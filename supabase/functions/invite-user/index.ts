// =============================================================
// Admin user invitation (Supabase Edge Function)
// =============================================================
// Issues a Supabase Auth invitation email to a new user, optionally
// pre-assigning their role and supplier_id on the profile row that
// gets auto-created by the `handle_new_user` trigger.
//
// Why an Edge Function: Supabase's invite endpoint is admin-only and
// requires the service-role key, which can never be exposed to a
// browser. The function authenticates the calling admin via their
// session JWT, validates they have admin/manager role, then uses
// the service-role client to call `auth.admin.inviteUserByEmail`.
//
// Flow:
//   1. Client (admin Settings page) → POST /functions/v1/invite-user
//      with { email, full_name, role, supplier_id? } and the
//      authenticated user's bearer token.
//   2. Function validates the bearer token and the caller's profile
//      role. Rejects non-admins.
//   3. Calls inviteUserByEmail. Supabase sends the invite email
//      using the configured SMTP provider (Resend in prod). The
//      `data` payload is stored on auth.users.raw_user_meta_data
//      and surfaces to `handle_new_user` via NEW.raw_user_meta_data.
//   4. After the invitee accepts and the profile row materializes,
//      the function patches `profiles` with the role + supplier_id.
//      We do this on the *invite* request rather than waiting for
//      acceptance because:
//        - the trigger only knows about full_name, not role/supplier
//        - we want the role to be correct from first login
//        - the upsert is idempotent (matches by email).
//      Caveat: the profile patch only succeeds if the auth.users row
//      already exists. If invitee hasn't accepted yet, profile patch
//      noops — first login still gets default 'user'. The admin can
//      re-issue (which is idempotent for existing emails) to retry.
//
// Authorization shape mirrors `rpc_update_user_role` (migration 015):
//   - admin can promote anyone
//   - manager can invite + assign user/manager/supplier (but not admin)
//   - regular user / supplier cannot call this at all
//
// CORS: enabled for the browser caller. Preflight handled below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Where users land after clicking the invite link. Vercel sets this in
// production; locally we fall back to the dev origin.
const SITE_URL = Deno.env.get("SITE_URL") ?? "http://localhost:5173";

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

interface InvitePayload {
  email: string;
  full_name: string;
  role: Role;
  /** Required when role === 'supplier'. */
  supplier_id?: string | null;
}

function validatePayload(p: unknown): InvitePayload | string {
  if (!p || typeof p !== "object") return "body must be a JSON object";
  const o = p as Record<string, unknown>;
  if (typeof o.email !== "string" || !o.email.includes("@")) {
    return "email is required and must be a valid address";
  }
  if (typeof o.full_name !== "string" || o.full_name.trim().length === 0) {
    return "full_name is required";
  }
  if (typeof o.role !== "string" || !ALLOWED_ROLES.includes(o.role as Role)) {
    return `role must be one of: ${ALLOWED_ROLES.join(", ")}`;
  }
  if (o.role === "supplier") {
    if (typeof o.supplier_id !== "string" || o.supplier_id.length === 0) {
      return "supplier_id is required when role is 'supplier'";
    }
  }
  return {
    email: o.email.trim().toLowerCase(),
    full_name: o.full_name.trim(),
    role: o.role as Role,
    supplier_id:
      o.role === "supplier" ? (o.supplier_id as string) : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  // -------- 1. Authenticate the caller via their session JWT.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "missing bearer token" }, 401);
  }
  const callerToken = authHeader.slice("Bearer ".length);

  // anon-keyed client used purely to resolve the caller's identity
  // from their access token. No mutations performed with this.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
    auth: { persistSession: false },
  });
  const { data: callerUser, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerUser?.user) {
    return jsonResponse({ error: "invalid or expired token" }, 401);
  }

  // service-role client for actual privileged work
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

  // -------- 2. Validate request body.
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

  // Manager can't invite admins.
  if (callerProfile.role === "manager" && payload.role === "admin") {
    return jsonResponse(
      { error: "managers cannot invite admins" },
      403,
    );
  }

  // If supplier role: verify the supplier_id exists.
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

  // -------- 3. Issue the invite.
  const { data: invite, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    payload.email,
    {
      data: {
        full_name: payload.full_name,
        // The trigger reads full_name from raw_user_meta_data; role +
        // supplier_id are intentionally NOT used by the trigger (it
        // always inserts role='user'). We patch the profile below.
        invited_role: payload.role,
        invited_supplier_id: payload.supplier_id,
      },
      redirectTo: `${SITE_URL}/auth/accept-invite`,
    },
  );

  if (inviteErr) {
    // The most common failure here is "user already exists" — Supabase
    // returns this with a 422 / specific message. We forward the
    // message so the admin UI can surface "this email is already on
    // file; promote them via the role editor instead."
    return jsonResponse(
      { error: inviteErr.message ?? "invite failed", code: "invite_failed" },
      422,
    );
  }

  // -------- 4. Patch the profile (best-effort — see header comment).
  // The profile row is created by handle_new_user() the moment the
  // auth.users row materializes, which in inviteUserByEmail happens
  // synchronously on this call (not after acceptance). So the
  // patch here lands the role + supplier_id immediately and the user
  // logs in with the correct shape.
  const newUserId = invite.user?.id;
  if (newUserId) {
    const { error: patchErr } = await admin
      .from("profiles")
      .update({
        role: payload.role,
        supplier_id: payload.supplier_id,
        full_name: payload.full_name,
      })
      .eq("id", newUserId);
    if (patchErr) {
      // Don't fail the invite over this — the email already went out.
      // The admin can fix the role from the user-management UI after
      // first login. Surface as a warning in the response.
      return jsonResponse({
        ok: true,
        warning:
          "Invite sent, but failed to set role/supplier on the new profile. Fix from the user-management UI after first login.",
        warning_detail: patchErr.message,
        user_id: newUserId,
      });
    }
  }

  return jsonResponse({ ok: true, user_id: newUserId ?? null });
});
