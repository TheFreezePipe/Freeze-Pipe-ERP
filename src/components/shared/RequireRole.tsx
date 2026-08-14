import { Navigate } from "react-router-dom";
import { useAuth, type UserRole } from "@/lib/auth-context";
import type { ReactNode } from "react";

interface RequireRoleProps {
  /** Roles that are allowed to view this route */
  allowed: UserRole[];
  children: ReactNode;
}

/**
 * Route guard that checks user role.
 * Redirects unauthorized users to their default landing page:
 * - "user" role        → /manufacturing/workspace
 * - "supplier" role    → /supplier
 * - admin / manager    → /dashboard
 */
export function RequireRole({ allowed, children }: RequireRoleProps) {
  const { role, roleResolved } = useAuth();

  // Until the profile loads, `role` is the "user" fallback — redirecting on
  // it bounced every admin from /dashboard to the staff workspace on each
  // login/refresh. Hold with a spinner until the real role is known.
  if (!roleResolved) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (allowed.includes(role)) {
    return <>{children}</>;
  }

  // Redirect to the user's default landing page
  const fallback =
    role === "user" ? "/manufacturing/workspace" :
    role === "supplier" ? "/supplier" :
    "/dashboard";
  return <Navigate to={fallback} replace />;
}
