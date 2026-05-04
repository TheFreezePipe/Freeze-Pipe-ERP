import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { X as XIcon, Link2, Link2Off, Building2, UserX, UserCheck, UserPlus, Mail } from "lucide-react";
import { useState } from "react";
import {
  useProfiles,
  useUpdateUserRole,
  useUpdateProfile,
  usePromoteUserToSupplier,
  useSetProfileActive,
  useInviteUser,
} from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Profile } from "@/types/database";

const roleColors: Record<string, string> = {
  admin: "border-primary text-primary",
  manager: "border-yellow-500 text-yellow-400",
  user: "border-muted text-muted-foreground",
};

// Local query — small list, admin-only page, no need for a dedicated hook.
function useSuppliersList() {
  return useQuery({
    queryKey: ["admin", "suppliers-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id, name, code, is_active")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data as Array<{ id: string; name: string; code: string; is_active: boolean }>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export default function UserManagement() {
  const { profile } = useAuth();
  const { data: profiles = [], isLoading } = useProfiles();
  const suppliers = useSuppliersList();
  const updateRole = useUpdateUserRole();
  const updateProfile = useUpdateProfile();
  const promoteToSupplier = usePromoteUserToSupplier();
  const setActive = useSetProfileActive();
  const inviteUser = useInviteUser();
  const [roleError, setRoleError] = useState<{ userId: string; message: string } | null>(null);
  const [linkDialogUser, setLinkDialogUser] = useState<Profile | null>(null);
  const [homebaseIdInput, setHomebaseIdInput] = useState("");
  const [homebaseNameInput, setHomebaseNameInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [promoteUser, setPromoteUser] = useState<Profile | null>(null);
  const [promoteSupplierId, setPromoteSupplierId] = useState<string>("");
  const [promoteError, setPromoteError] = useState<string | null>(null);

  // Invite-user dialog state. Lives at the page level so the button
  // in the header can open it. The dialog itself is rendered at the
  // bottom of the JSX next to the existing promote/link dialogs.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "manager" | "user" | "supplier">("user");
  const [inviteSupplierId, setInviteSupplierId] = useState<string>("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  function resetInviteForm() {
    setInviteEmail("");
    setInviteName("");
    setInviteRole("user");
    setInviteSupplierId("");
    setInviteError(null);
    setInviteSuccess(null);
  }

  async function handleInvite() {
    setInviteError(null);
    setInviteSuccess(null);
    const trimmedEmail = inviteEmail.trim().toLowerCase();
    const trimmedName = inviteName.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setInviteError("Email is required");
      return;
    }
    if (!trimmedName) {
      setInviteError("Full name is required");
      return;
    }
    if (inviteRole === "supplier" && !inviteSupplierId) {
      setInviteError("Pick a supplier when inviting a supplier user");
      return;
    }
    try {
      const result = await inviteUser.mutateAsync({
        email: trimmedEmail,
        fullName: trimmedName,
        role: inviteRole,
        supplierId: inviteRole === "supplier" ? inviteSupplierId : null,
      });
      // The function returns ok:true even when the post-invite profile
      // patch fails — surface as a warning so the admin can fix it
      // without thinking the email failed to send.
      if (result.warning) {
        setInviteSuccess(`Invite sent — ${result.warning}`);
      } else {
        setInviteSuccess(`Invite sent to ${trimmedEmail}`);
      }
      // Don't auto-close; let the admin send another or read the warning.
      setInviteEmail("");
      setInviteName("");
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Invite failed");
    }
  }
  async function handlePromote() {
    if (!promoteUser || !promoteSupplierId) return;
    setPromoteError(null);
    try {
      await promoteToSupplier.mutateAsync({
        targetUserId: promoteUser.id,
        supplierId: promoteSupplierId,
      });
      setPromoteUser(null);
      setPromoteSupplierId("");
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : "Promotion failed");
    }
  }

  async function handleToggleActive(user: Profile, current: boolean) {
    try {
      await setActive.mutateAsync({ targetUserId: user.id, isActive: !current });
    } catch (err) {
      setRoleError({
        userId: user.id,
        message: err instanceof Error ? err.message : "Toggle failed",
      });
      setTimeout(() => setRoleError(null), 5000);
    }
  }

  async function handleLinkHomebase() {
    if (!linkDialogUser || !profile?.id) return;
    setLinkError(null);
    try {
      await updateProfile.mutateAsync({
        id: linkDialogUser.id,
        updates: {
          homebase_employee_id: homebaseIdInput.trim() || null,
          homebase_employee_name: homebaseNameInput.trim() || null,
        },
      });
      setLinkDialogUser(null);
      setHomebaseIdInput("");
      setHomebaseNameInput("");
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Link failed");
    }
  }

  async function handleUnlinkHomebase(user: Profile) {
    await updateProfile.mutateAsync({
      id: user.id,
      updates: {
        homebase_employee_id: null,
        homebase_employee_name: null,
      },
    });
  }

  // Supplier promotion is its own flow (rpc_promote_user_to_supplier). This
  // handler only covers the internal role matrix.
  async function handleRoleChange(userId: string, newRole: "admin" | "manager" | "user") {
    setRoleError(null);
    if (!profile?.id) return;
    try {
      // RPC enforces all the rules server-side: not-self, not-manager→admin,
      // manager-can't-modify-admin, etc. We let the server be the source of
      // truth and just surface whatever it rejects.
      await updateRole.mutateAsync({
        targetUserId: userId,
        newRole,
        actorId: profile.id,
      });
    } catch (err) {
      setRoleError({
        userId,
        message: err instanceof Error ? err.message : "Role change failed",
      });
      setTimeout(() => setRoleError(null), 5000);
    }
  }

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{profiles.length} users</p>
        {(profile?.role === "admin" || profile?.role === "manager") && (
          <Button
            size="sm"
            onClick={() => {
              resetInviteForm();
              setInviteOpen(true);
            }}
          >
            <UserPlus className="mr-1.5 h-4 w-4" />
            Invite user
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">User</th>
                <th className="px-3 py-3">Role</th>
                <th className="px-3 py-3">Supplier</th>
                <th className="px-3 py-3">Homebase</th>
                <th className="px-3 py-3">Joined</th>
                <th className="px-3 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(user => {
                const initials = user.full_name
                  .split(" ")
                  .map(n => n[0])
                  .join("")
                  .toUpperCase();

                const u = user as Profile & {
                  supplier_id?: string | null;
                  is_active?: boolean;
                  homebase_employee_id?: string | null;
                  homebase_employee_name?: string | null;
                };
                const isActive = u.is_active ?? true;
                const linkedSupplier = u.supplier_id
                  ? (suppliers.data ?? []).find((s) => s.id === u.supplier_id)
                  : null;

                return (
                  <tr key={user.id} className={`border-b border-border/50 ${isActive ? "" : "opacity-50"}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs bg-muted">{initials}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{user.full_name}</p>
                          <p className="text-xs text-muted-foreground">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={user.role}
                        onValueChange={(v) => handleRoleChange(user.id, v as "admin" | "manager" | "user")}
                        disabled={profile?.id === user.id}
                      >
                        <SelectTrigger className="h-7 w-[120px]" title={profile?.id === user.id ? "Cannot change your own role" : undefined}>
                          <Badge variant="outline" className={`text-[10px] uppercase ${roleColors[user.role]}`}>
                            {user.role}
                          </Badge>
                        </SelectTrigger>
                        <SelectContent>
                          {profile?.role === "admin" && (
                            <SelectItem value="admin">Admin</SelectItem>
                          )}
                          <SelectItem value="manager">Manager</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                      {roleError?.userId === user.id && (
                        <div className="mt-1 flex items-start gap-1 text-[10px] text-red-400">
                          <XIcon className="h-3 w-3 shrink-0 mt-0.5" />
                          <span>{roleError.message}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {user.role === "supplier" && linkedSupplier ? (
                        <div className="flex items-center gap-1.5">
                          <Building2 className="h-3 w-3 text-indigo-400" />
                          <span className="text-xs">{linkedSupplier.name}</span>
                        </div>
                      ) : user.role === "supplier" && u.supplier_id ? (
                        <span className="text-xs text-muted-foreground font-mono">
                          {u.supplier_id.slice(0, 8)}…
                        </span>
                      ) : profile?.role === "admin" && user.role !== "supplier" && profile.id !== user.id ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setPromoteUser(user);
                            setPromoteSupplierId("");
                            setPromoteError(null);
                          }}
                        >
                          <Building2 className="mr-1 h-3 w-3" />
                          Promote
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {user.homebase_employee_id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                          <span className="text-xs">{user.homebase_employee_name ?? user.homebase_employee_id}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-red-400"
                            onClick={() => handleUnlinkHomebase(user)}
                            title="Unlink from Homebase"
                          >
                            <Link2Off className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setLinkDialogUser(user);
                            setHomebaseIdInput("");
                            setHomebaseNameInput(user.full_name);
                            setLinkError(null);
                          }}
                        >
                          <Link2 className="mr-1 h-3 w-3" />
                          Link
                        </Button>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground tabular-nums">
                      {user.created_at ? new Date(user.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {profile?.role === "admin" && profile.id !== user.id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          title={isActive ? "Deactivate user" : "Reactivate user"}
                          onClick={() => handleToggleActive(user, isActive)}
                          disabled={setActive.isPending}
                        >
                          {isActive ? (
                            <><UserX className="mr-1 h-3 w-3" /> Deactivate</>
                          ) : (
                            <><UserCheck className="mr-1 h-3 w-3" /> Reactivate</>
                          )}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Homebase link dialog */}
      <Dialog
        open={!!linkDialogUser}
        onOpenChange={(o) => { if (!o) { setLinkDialogUser(null); setLinkError(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link {linkDialogUser?.full_name} to Homebase</DialogTitle>
            <DialogDescription>
              Enter the Homebase employee ID and display name so labor hours from
              Homebase can feed the Performance dashboard's Tasks/Hr metric.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="hb-id" className="text-xs">Homebase Employee ID</Label>
              <Input
                id="hb-id"
                value={homebaseIdInput}
                onChange={e => setHomebaseIdInput(e.target.value)}
                placeholder="e.g. hb-1001"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hb-name" className="text-xs">Homebase display name</Label>
              <Input
                id="hb-name"
                value={homebaseNameInput}
                onChange={e => setHomebaseNameInput(e.target.value)}
                placeholder={linkDialogUser?.full_name ?? ""}
              />
            </div>
            {linkError && <p className="text-xs text-red-400">{linkError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialogUser(null)}>Cancel</Button>
            <Button onClick={handleLinkHomebase} disabled={!homebaseIdInput.trim() || updateProfile.isPending}>
              {updateProfile.isPending ? "Linking…" : "Link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Promote-to-supplier dialog */}
      <Dialog
        open={!!promoteUser}
        onOpenChange={(o) => { if (!o) { setPromoteUser(null); setPromoteError(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Promote {promoteUser?.full_name} to supplier</DialogTitle>
            <DialogDescription>
              This changes the user's role to <span className="font-mono text-xs">supplier</span>{" "}
              and links them to the selected supplier organization. Only one active supplier user
              is allowed per supplier (MVP constraint). The change cannot be undone by role edit —
              use deactivate to retire the supplier user.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sup-pick" className="text-xs">Supplier organization</Label>
              <Select value={promoteSupplierId} onValueChange={setPromoteSupplierId}>
                <SelectTrigger id="sup-pick">
                  <SelectValue placeholder={suppliers.isLoading ? "Loading…" : "Pick a supplier"} />
                </SelectTrigger>
                <SelectContent>
                  {(suppliers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="font-mono text-xs">{s.code}</span>
                      <span className="ml-2">{s.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {promoteError && <p className="text-xs text-red-400">{promoteError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteUser(null)}>Cancel</Button>
            <Button
              onClick={handlePromote}
              disabled={!promoteSupplierId || promoteToSupplier.isPending}
            >
              {promoteToSupplier.isPending ? "Promoting…" : "Promote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite-user dialog. Calls the `invite-user` Edge Function via
          useInviteUser, which validates the caller is admin/manager
          server-side and sends the Supabase Auth invitation email
          (Resend in prod). Role + supplier_id are pre-applied to the
          new profile so the invitee logs in correctly shaped on first
          session. */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Invite a user
            </DialogTitle>
            <DialogDescription>
              They'll receive an email with a link that signs them in directly. No password setup required.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input
                type="email"
                placeholder="name@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Full name</Label>
              <Input
                placeholder="Jane Doe"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(v) =>
                  setInviteRole(v as "admin" | "manager" | "user" | "supplier")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User (internal staff, basic access)</SelectItem>
                  <SelectItem value="manager">Manager (can manage users + roles, except admin)</SelectItem>
                  {profile?.role === "admin" && (
                    <SelectItem value="admin">Admin (full access)</SelectItem>
                  )}
                  <SelectItem value="supplier">Supplier (external — see only their own data)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {inviteRole === "supplier" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Supplier</Label>
                <Select
                  value={inviteSupplierId}
                  onValueChange={setInviteSupplierId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a supplier…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(suppliers.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} <span className="text-muted-foreground ml-1">({s.code})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {inviteError && (
              <p className="text-xs text-red-400">{inviteError}</p>
            )}
            {inviteSuccess && (
              <p className="text-xs text-green-400">{inviteSuccess}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInviteOpen(false);
                resetInviteForm();
              }}
            >
              Close
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviteUser.isPending}
            >
              {inviteUser.isPending ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
