import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth-context";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import ChangeLog from "./ChangeLog";
import UserManagement from "./UserManagement";

export default function SettingsPage() {
  const { profile, role } = useAuth();

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

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="changelog">Change Log</TabsTrigger>
          <TabsTrigger value="users">User Management</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
