import type { UserRole } from "@/lib/auth-context";

/** Where each role lands after sign-in and when a route refuses them. */
export function landingPathFor(role: UserRole): string {
  if (role === "user") return "/go";
  if (role === "supplier") return "/supplier";
  return "/dashboard";
}
