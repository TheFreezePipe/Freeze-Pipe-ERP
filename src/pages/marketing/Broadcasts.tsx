import { useEffect, useState } from "react";
import { Plus, Mail, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useBroadcasts,
  useDeleteBroadcast,
  useUpdateBroadcast,
  broadcastResults,
  type MktBroadcastWithLinks,
} from "@/lib/hooks";
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

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "45.2%" or null when it can't be derived (missing data / zero recipients). */
function ratePct(numer: number | null, denom: number | null): string | null {
  if (numer == null || denom == null || denom <= 0) return null;
  return `${((numer / denom) * 100).toFixed(1)}%`;
}

const money = (v: number): string =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Compact "log the results after the send" dialog — just the four typed
 * result columns + the sent date (defaults to the scheduled date).
 */
function LogResultsDialog({
  broadcast,
  onClose,
}: {
  broadcast: MktBroadcastWithLinks | null;
  onClose: () => void;
}) {
  const update = useUpdateBroadcast();
  const [sentAt, setSentAt] = useState("");
  const [recipients, setRecipients] = useState("");
  const [opens, setOpens] = useState("");
  const [clicks, setClicks] = useState("");
  const [revenue, setRevenue] = useState("");
  const isEmail = broadcast?.channel === "email";

  useEffect(() => {
    if (!broadcast) return;
    const res = broadcastResults(broadcast);
    setSentAt(dayKeyOf(broadcast.sent_at) ?? dayKeyOf(broadcast.scheduled_at) ?? "");
    setRecipients(res.recipients != null ? String(res.recipients) : "");
    setOpens(res.opens != null ? String(res.opens) : "");
    setClicks(res.clicks != null ? String(res.clicks) : "");
    setRevenue(res.revenue != null ? String(res.revenue) : "");
  }, [broadcast]);

  async function handleSave() {
    if (!broadcast) return;
    try {
      await update.mutateAsync({
        id: broadcast.id,
        updates: {
          sent_at: sentAt || null,
          // Typed results columns; legacy `metrics` jsonb is never written.
          recipients: numOrNull(recipients),
          opens: isEmail ? numOrNull(opens) : null,
          clicks: numOrNull(clicks),
          revenue: numOrNull(revenue),
        },
      });
      toast({ title: "Results logged" });
      onClose();
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={!!broadcast} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Log results</DialogTitle>
          <DialogDescription>{broadcast?.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Sent date</Label>
            <Input type="date" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Recipients</Label>
              <Input type="number" min={0} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
            </div>
            {isEmail && (
              <div className="space-y-1.5">
                <Label className="text-xs">Opens</Label>
                <Input type="number" min={0} value={opens} onChange={(e) => setOpens(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Clicks</Label>
              <Input type="number" min={0} value={clicks} onChange={(e) => setClicks(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Revenue $</Label>
              <Input type="number" min={0} value={revenue} onChange={(e) => setRevenue(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save results"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Broadcasts() {
  const { data: broadcasts = [], isLoading } = useBroadcasts();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteBroadcast();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktBroadcastWithLinks | null>(null);
  const [logging, setLogging] = useState<MktBroadcastWithLinks | null>(null);

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
    <div className="space-y-6 max-w-6xl">
      <BroadcastFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <BroadcastFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        broadcast={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.sent_at) ?? dayKeyOf(editing.scheduled_at), todayKey)}
      />
      <LogResultsDialog broadcast={logging} onClose={() => setLogging(null)} />

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
                  <th className="px-4 py-2.5 font-medium">Results</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {broadcasts.map((b) => {
                  const res = broadcastResults(b);
                  const hasResults =
                    res.recipients != null || res.opens != null || res.clicks != null || res.revenue != null;
                  // Past broadcasts (by sent date, else scheduled date) with no
                  // recipients logged get the "results not logged" nudge.
                  const needsResults =
                    res.recipients == null &&
                    isPastKey(dayKeyOf(b.sent_at) ?? dayKeyOf(b.scheduled_at), todayKey);
                  return (
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
                      <td className="px-4 py-3 text-muted-foreground">
                        {!hasResults && !needsResults && "—"}
                        {hasResults && (
                          <div className="flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums">
                            <span title="Recipients">
                              {res.recipients != null ? res.recipients.toLocaleString() : "—"}
                            </span>
                            {b.channel === "email" && (
                              <>
                                <span className="text-muted-foreground/40">·</span>
                                <span title="Open rate (opens / recipients)">
                                  {ratePct(res.opens, res.recipients) ?? "—"} open
                                </span>
                              </>
                            )}
                            <span className="text-muted-foreground/40">·</span>
                            <span title="Click rate (clicks / recipients)">
                              {ratePct(res.clicks, res.recipients) ?? "—"} click
                            </span>
                            <span className="text-muted-foreground/40">·</span>
                            <span title="Revenue">{res.revenue != null ? money(res.revenue) : "—"}</span>
                          </div>
                        )}
                        {needsResults && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                              results not logged
                            </span>
                            {canEdit && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setLogging(b)}
                              >
                                Log results
                              </Button>
                            )}
                          </div>
                        )}
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
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
