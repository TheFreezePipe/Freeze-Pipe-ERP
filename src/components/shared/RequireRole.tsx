import { Navigate } from "react-router-dom";
import { useAuth, type UserRole } from "@/lib/auth-context";
import { landingPathFor } from "@/lib/landing";
import type { ReactNode } from "react";

interface RequireRoleProps {
  /** Roles that are allowed to view this route */
  allowed: UserRole[];
  children: ReactNode;
}

/**
 * Route guard that checks user role.
 * Redirects unauthorized users to their default landing page
 * (`landingPathFor`): user → /go, supplier → /supplier, else /dashboard.
 */
export function RequireRole({ allowed, children }: RequireRoleProps) {
  const { role, roleResolved } = useAuth();

  // Until the profile loads, `role` is the "user" fallback — redirecting on
  // it bounced every admin from /dashboard to the staff workspace on each
  // login/refresh. Hold with a spinner until the real role is known.
  if (!roleResolved) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (allowed.includes(role)) {
    return <>{children}</>;
  }

  return <Navigate to={landingPathFor(role)} replace />;
}
