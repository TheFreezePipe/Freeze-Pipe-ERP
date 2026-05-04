import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { supabaseUpdateWithVersion } from "@/lib/concurrency";
import type { Profile } from "@/types/database";

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .order("full_name");
      if (error) throw error;
      return data as Profile[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Generic profile update — use for name, avatar, Homebase link, etc.
 *
 * For role changes: DO NOT use this. The column-level trigger in
 * migration 015 rejects direct role updates. Use useUpdateUserRole().
 */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      updates: Partial<Omit<Profile, "role">>;
      expectedVersion?: number;
    }) => {
      return supabaseUpdateWithVersion(
        supabase,
        "profiles",
        params.id,
        params.expectedVersion ?? null,
        params.updates as Record<string, unknown>,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

/**
 * Change a user's role via the rpc_update_user_role RPC.
 *
 * Enforces RBAC server-side (admin/manager only, no self-edits, managers
 * can't grant admin or modify admins). Writes an audit entry.
 */
export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      targetUserId: string;
      newRole: "admin" | "manager" | "user";
      actorId: string;
    }) => {
      const { data, error } = await supabase.rpc("rpc_update_user_role", {
        p_target_user_id: params.targetUserId,
        p_new_role: params.newRole,
        p_actor_id: params.actorId,
      });
      if (error) throw error;
      const result = data as { ok: boolean; error?: string; previous_role?: string; new_role?: string };
      if (!result.ok) throw new Error(result.error ?? "Role change failed");
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}

/**
 * Invite a new user via the `invite-user` Edge Function. The function
 * authenticates the calling admin, validates RBAC server-side, and
 * issues a Supabase Auth invitation email. The invitee receives a
 * link that signs them in directly — no separate password setup.
 *
 * Role + supplier_id (when role='supplier') are patched onto the
 * profile row that the `handle_new_user` trigger creates, so the
 * invitee logs in with the correct shape from the first session.
 */
export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      email: string;
      fullName: string;
      role: "admin" | "manager" | "user" | "supplier";
      supplierId?: string | null;
    }) => {
      // Pass the caller's session token so the function can validate
      // their identity + role server-side. supabase-js automatically
      // attaches it via `functions.invoke`.
      const { data, error } = await supabase.functions.invoke("invite-user", {
        body: {
          email: params.email,
          full_name: params.fullName,
          role: params.role,
          supplier_id: params.supplierId ?? null,
        },
      });
      if (error) {
        // FunctionsHttpError preserves the body in `context`; surface
        // the user-friendly message we built into the function.
        const ctx = (error as unknown as {
          context?: { json?: () => Promise<{ error?: string }> };
        }).context;
        if (ctx?.json) {
          try {
            const j = await ctx.json();
            if (j?.error) throw new Error(j.error);
          } catch {
            // fall through to generic message
          }
        }
        throw new Error(error.message ?? "invite failed");
      }
      const result = data as {
        ok: boolean;
        warning?: string;
        warning_detail?: string;
        user_id?: string | null;
      };
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}
