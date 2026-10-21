import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth-context";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useUrlFilter } from "@/lib/use-url-filter";
import ChangeLog from "./ChangeLog";
import UserManagement from "./UserManagement";
import ReportingApi from "./ReportingApi";
import WarehouseSettings from "./WarehouseSettings";

type SettingsTab = "profile" | "changelog" | "users" | "api" | "warehouse";

export default function SettingsPage() {
  const { profile, role } = useAuth();
  // Reporting API tab is strictly admin-only (owner requirement) — the tab
  // is hidden for other roles AND the underlying RLS/RPCs enforce it
  // server-side, so the UI gate is convenience, not the boundary. The
  // Warehouse tab (setup data for the Inventory module) is admin-only too.
  const isAdmin = role === "admin";

  // Active tab lives in ?tab= so /settings?tab=warehouse (the old
  // /warehouse/locations link) opens straight onto it.
  const [tabParam, setTab] = useUrlFilter<SettingsTab>("tab", "profile");
  const availableTabs: SettingsTab[] = isAdmin
    ? ["profile", "changelog", "users", "api", "warehouse"]
    : ["profile", "changelog", "users"];
  const tab: SettingsTab = availableTabs.includes(tabParam) ? tabParam : "profile";

  const initials = profile?.full_name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() ?? "?";

  const roleColors: Record<string, string> = {
    admin: "border-primary text-primary",
    manager: "border-yellow-500 text-yellow-400",
    user: "border-muted text-muted-foreground",
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your profile, team, and view activity logs</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="changelog">Change Log</TabsTrigger>
          <TabsTrigger value="users">User Management</TabsTrigger>
          {isAdmin && <TabsTrigger value="api">Reporting API</TabsTrigger>}
          {isAdmin && <TabsTrigger value="warehouse">Warehouse</TabsTrigger>}
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle className="text-base">Your Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarFallback className="bg-primary text-primary-foreground text-lg">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-lg font-semibold">{profile?.full_name ?? "Unknown"}</p>
                  <p className="text-sm text-muted-foreground">{profile?.email ?? "Unknown"}</p>
                  <Badge variant="outline" className={`mt-1 text-xs uppercase ${roleColors[role]}`}>
                    {role}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="changelog" className="mt-4">
          <ChangeLog />
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <UserManagement />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="api" className="mt-4">
            <ReportingApi />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="warehouse" className="mt-4">
            <WarehouseSettings />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
