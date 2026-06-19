import { useState } from "react";
import { Plus, Mail, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBroadcasts, useDeleteBroadcast, type MktBroadcastWithLinks } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { BroadcastFormDialog } from "@/components/marketing/BroadcastFormDialog";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { format, parseISO } from "date-fns";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

export default function Broadcasts() {
  const { data: broadcasts = [], isLoading } = useBroadcasts();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteBroadcast();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktBroadcastWithLinks | null>(null);

  async function handleDelete(b: MktBroadcastWithLinks) {
    if (!window.confirm(`Delete "${b.name}"?`)) return;
    try {
      await del.mutateAsync(b.id);
      toast({ title: "Broadcast deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <BroadcastFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <BroadcastFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        broadcast={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.sent_at) ?? dayKeyOf(editing.scheduled_at), todayKey)}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Broadcasts</h1>
          <p className="text-muted-foreground">Email &amp; SMS blasts</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Broadcast
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading broadcasts…</div>
      ) : broadcasts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Mail className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No broadcasts yet.</p>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add a broadcast
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Broadcast</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Audience</th>
                  <th className="px-4 py-2.5 font-medium">Promotes</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {broadcasts.map((b) => (
                  <tr key={b.id} className="border-t border-border/40 hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {b.channel === "email" ? (
                          <Mail className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                        ) : (
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-green-400" />
                        )}
                        <span className="font-medium">{b.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {b.sent_at ? <>Sent {fmt(b.sent_at)}</> : b.scheduled_at ? <>Sched. {fmt(b.scheduled_at)}</> : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {b.audience_segment ?? "—"}
                      {b.audience_size != null && <span className="ml-1 tabular-nums">({b.audience_size.toLocaleString()})</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {b.sale?.name ?? (b.launch ? b.launch.name : "—")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(b)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleDelete(b)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
