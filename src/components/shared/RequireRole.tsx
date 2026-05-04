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
  const { role } = useAuth();

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
