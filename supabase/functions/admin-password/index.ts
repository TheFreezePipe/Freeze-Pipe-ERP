// =============================================================
// Admin password management (Supabase Edge Function)
// =============================================================
// Two operations gated to admin/manager callers:
//
//   mode="create" — create a user with a known password (no invite
//                   email). Required when SMTP isn't configured or
//                   when the admin wants to onboard via direct
//                   credential-share (Slack/text/etc.).
//                   Body: { mode, email, full_name, role, supplier_id? }
//                   Returns: { ok, user_id, password }
//                   The password is generated server-side with
//                   crypto.getRandomValues — admin can't pick a weak
//                   one. Email is auto-confirmed so the new user can
//                   log in immediately.
//
//   mode="reset"  — reset an existing user's password. Generates a
//                   new password, sets email_confirm=true (in case
//                   the user was created via invite and never
//                   confirmed).
//                   Body: { mode, user_id }
//                   Returns: { ok, user_id, password }
//
// Authorization mirrors invite-user (admin/manager only; managers
// can't reset/create admin accounts).
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ROLES = ["admin", "manager", "user", "supplier"] as const;
type Role = (typeof ALLOWED_ROLES)[number];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 16-char password with hyphens every 4 chars, drawn from a
// Crockford-base32-ish alphabet that excludes 0/O/1/I/L/etc. so the
// admin can dictate it over the phone if needed.
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]);
  return [
    chars.slice(0, 4).join(""),
    chars.slice(4, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
  ].join("-");
}

interface CreatePayload {
  mode: "create";
  email: string;
  full_name: string;
  role: Role;
  supplier_id?: string | null;
}
interface ResetPayload {
  mode: "reset";
  user_id: string;
}
type Payload = CreatePayload | ResetPayload;

function validatePayload(p: unknown): Payload | string {
  if (!p || typeof p !== "object") return "body must be a JSON object";
  const o = p as Record<string, unknown>;
  if (o.mode !== "create" && o.mode !== "reset") {
    return "mode must be 'create' or 'reset'";
  }
  if (o.mode === "create") {
    if (typeof o.email !== "string" || !o.email.includes("@")) {
      return "email is required and must contain @";
    }
    if (typeof o.full_name !== "string" || o.full_name.trim().length === 0) {
      return "full_name is required";
    }
    if (typeof o.role !== "string" || !ALLOWED_ROLES.includes(o.role as Role)) {
      return `role must be one of: ${ALLOWED_ROLES.join(", ")}`;
    }
    if (o.role === "supplier"
        && (typeof o.supplier_id !== "string" || o.supplier_id.length === 0)) {
      return "supplier_id is required when role is 'supplier'";
    }
    return {
      mode: "create",
      email: (o.email as string).trim().toLowerCase(),
      full_name: (o.full_name as string).trim(),
      role: o.role as Role,
      supplier_id: o.role === "supplier" ? (o.supplier_id as string) : null,
    };
  } else {
    if (typeof o.user_id !== "string" || o.user_id.length === 0) {
      return "user_id is required for reset";
    }
    return { mode: "reset", user_id: o.user_id as string };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  // ---- 1. Authenticate the caller ----
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "missing bearer token" }, 401);
  }
  const callerToken = authHeader.slice("Bearer ".length);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
    auth: { persistSession: false },
  });
  const { data: callerUser, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerUser?.user) {
    return jsonResponse({ error: "invalid or expired token" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", callerUser.user.id)
    .single();
  if (profileErr || !callerProfile) {
    return jsonResponse({ error: "caller profile not found" }, 403);
  }
  if (!callerProfile.is_active) {
    return jsonResponse({ error: "caller is deactivated" }, 403);
  }
  if (!["admin", "manager"].includes(callerProfile.role as string)) {
    return jsonResponse({ error: "admin or manager role required" }, 403);
  }

  // ---- 2. Parse + validate body ----
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "body must be valid JSON" }, 400);
  }
  const validated = validatePayload(body);
  if (typeof validated === "string") {
    return jsonResponse({ error: validated }, 400);
  }
  const payload = validated;

  // ---- 3. Branch on mode ----
  const password = generatePassword();

  if (payload.mode === "create") {
    // Manager can't create admins.
    if (callerProfile.role === "manager" && payload.role === "admin") {
      return jsonResponse(
        { error: "managers cannot create admin accounts" },
        403,
      );
    }
    // If role=supplier, verify supplier exists.
    if (payload.role === "supplier") {
      const { data: sup, error: supErr } = await admin
        .from("suppliers")
        .select("id")
        .eq("id", payload.supplier_id!)
        .maybeSingle();
      if (supErr || !sup) {
        return jsonResponse({ error: "supplier_id not found" }, 400);
      }
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: payload.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: payload.full_name },
    });
    if (createErr || !created?.user) {
      return jsonResponse(
        { error: createErr?.message ?? "create failed", code: "create_failed" },
        422,
      );
    }

    // Patch the auto-created profile (handle_new_user trigger created
    // it with role='user'). Same shape as invite-user's post-step.
    const { error: patchErr } = await admin
      .from("profiles")
      .update({
        role: payload.role,
        supplier_id: payload.supplier_id,
        full_name: payload.full_name,
      })
      .eq("id", created.user.id);
    if (patchErr) {
      return jsonResponse({
        ok: true,
        warning:
          "User created with password, but failed to set role/supplier on the profile. Fix from the user-management UI.",
        warning_detail: patchErr.message,
        user_id: created.user.id,
        password,
      });
    }

    return jsonResponse({
      ok: true,
      user_id: created.user.id,
      password,
    });
  }

  // mode === "reset"
  // Look up the target user's role to enforce the manager-can't-reset-
  // admin rule.
  const { data: targetProfile, error: targetErr } = await admin
    .from("profiles")
    .select("role, email")
    .eq("id", payload.user_id)
    .maybeSingle();
  if (targetErr || !targetProfile) {
    return jsonResponse({ error: "target user not found" }, 404);
  }
  if (callerProfile.role === "manager" && targetProfile.role === "admin") {
    return jsonResponse(
      { error: "managers cannot reset admin passwords" },
      403,
    );
  }

  const { data: updated, error: resetErr } = await admin.auth.admin.updateUserById(
    payload.user_id,
    {
      password,
      email_confirm: true,
    },
  );
  if (resetErr || !updated?.user) {
    return jsonResponse(
      { error: resetErr?.message ?? "reset failed", code: "reset_failed" },
      422,
    );
  }

  return jsonResponse({
    ok: true,
    user_id: payload.user_id,
    password,
  });
});
