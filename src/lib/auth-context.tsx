import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Profile } from "@/types/database";

export type UserRole = "admin" | "manager" | "user" | "supplier";

interface AuthState {
  user: User | null;
  profile: Profile | null;
  session: Session | null;
  loading: boolean;
  role: UserRole;
  /** False while the signed-in user's profile row (and therefore their real
   *  role) is still loading. Until it's true, `role` is the "user" fallback —
   *  route guards must WAIT on this rather than redirect, or every admin
   *  briefly reads as staff on login/refresh and gets bounced off their page. */
  roleResolved: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isUser: boolean;
  isSupplier: boolean;
  /** supplier_id if this is a supplier user; null otherwise. Driven by profile.supplier_id. */
  supplierId: string | null;
  hasRole: (...roles: UserRole[]) => boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

// Centralized in src/lib/env.ts — also enforces "prod must have real credentials".
import { isDemoMode } from "@/lib/env";

// Demo profile for development. Generated Profile has many nullable fields
// we don't care about in demo mode — spreading null into them is cleaner than
// enumerating each one.
const DEMO_PROFILE: Profile = {
  id: "demo-user",
  email: "admin@freezepipe.com",
  full_name: "Chase (Demo)",
  role: "admin",
  avatar_url: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  row_version: 1,
  homebase_employee_id: null,
  homebase_employee_name: null,
  homebase_linked_at: null,
  homebase_linked_by: null,
  supplier_id: null,
  is_active: true,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(isDemoMode ? DEMO_PROFILE : null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!isDemoMode);
  // Which user id the current `profile` state answers for. Comparing this to
  // user.id (rather than a boolean) keeps roleResolved TRUE through routine
  // token-refresh refetches — flipping a boolean would flash every guarded
  // page to a spinner once an hour — while still resolving false across an
  // actual account switch.
  const [profileFor, setProfileFor] = useState<string | null>(null);

  async function fetchProfile(userId: string) {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    // Generated profiles row includes nullable timestamps and a wider role type;
    // cast through unknown to land on the hand-rolled Profile shape the app uses.
    setProfile(data as unknown as Profile | null);
    setProfileFor(userId);
  }

  useEffect(() => {
    if (isDemoMode) return;

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        fetchProfile(s.user.id);
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        fetchProfile(s.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  }

  async function signUp(email: string, password: string, fullName: string) {
    const { error, data } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (!error && data.user) {
      await supabase.from("profiles").insert({
        id: data.user.id,
        email,
        full_name: fullName,
        role: "user",
      });
    }
    return { error: error as Error | null };
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setProfileFor(null);
  }

  const role: UserRole = (profile?.role as UserRole) ?? "user";
  const roleResolved = isDemoMode || !user || profileFor === user.id;
  // profile.supplier_id is added by migration 020. Cast through unknown because
  // the Profile type may not yet be regenerated against the new schema.
  const supplierId: string | null =
    ((profile as unknown as { supplier_id?: string | null } | null)?.supplier_id) ?? null;

  function hasRole(...roles: UserRole[]) {
    return roles.includes(role);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        session,
        loading,
        role,
        roleResolved,
        isAdmin: role === "admin",
        isManager: role === "manager",
        isUser: role === "user",
        isSupplier: role === "supplier",
        supplierId,
        hasRole,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
