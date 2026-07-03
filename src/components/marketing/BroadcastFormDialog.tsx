import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import {
  useCreateBroadcast,
  useUpdateBroadcast,
  useSales,
  useLaunches,
  broadcastResults,
  type MktBroadcastWithLinks,
} from "@/lib/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  broadcast?: MktBroadcastWithLinks | null;
  /** Prefill the scheduled date when creating (e.g. from a calendar day click). */
  defaultDate?: string | null;
  /** Lock the date fields (already sent / past — protected from rescheduling). */
  datesLocked?: boolean;
}

const NONE = "__none__";
const dateInput = (v: string | null) => (v ? v.slice(0, 10) : "");
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function BroadcastFormDialog({ open, onOpenChange, broadcast, defaultDate, datesLocked }: Props) {
  const { data: sales = [] } = useSales();
  const { data: launches = [] } = useLaunches();
  const create = useCreateBroadcast();
  const update = useUpdateBroadcast();
  const editing = !!broadcast;

  const [channel, setChannel] = useState<string>("email");
  const [name, setName] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [sentAt, setSentAt] = useState("");
  const [segment, setSegment] = useState("");
  const [audienceSize, setAudienceSize] = useState("");
  const [saleId, setSaleId] = useState<string>(NONE);
  const [launchId, setLaunchId] = useState<string>(NONE);
  const [recipients, setRecipients] = useState("");
  const [opens, setOpens] = useState("");
  const [clicks, setClicks] = useState("");
  const [revenue, setRevenue] = useState("");

  useEffect(() => {
    if (!open) return;
    setChannel(broadcast?.channel ?? "email");
    setName(broadcast?.name ?? "");
    setScheduledAt(dateInput(broadcast?.scheduled_at ?? null) || (defaultDate ?? ""));
    setSentAt(dateInput(broadcast?.sent_at ?? null));
    setSegment(broadcast?.audience_segment ?? "");
    setAudienceSize(broadcast?.audience_size != null ? String(broadcast.audience_size) : "");
    setSaleId(broadcast?.sale_id ?? NONE);
    setLaunchId(broadcast?.launch_id ?? NONE);
    // Typed results columns (legacy `metrics` jsonb read as fallback only).
    const res = broadcast ? broadcastResults(broadcast) : null;
    setRecipients(res?.recipients != null ? String(res.recipients) : "");
    setOpens(res?.opens != null ? String(res.opens) : "");
    setClicks(res?.clicks != null ? String(res.clicks) : "");
    setRevenue(res?.revenue != null ? String(res.revenue) : "");
  }, [open, broadcast, defaultDate]);

  const pending = create.isPending || update.isPending;
  const launchLabel = (l: (typeof launches)[number]) => l.name;

  async function handleSubmit() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the broadcast a name/subject.", variant: "destructive" });
      return;
    }
    const payload = {
      channel,
      name: name.trim(),
      scheduled_at: scheduledAt || null,
      sent_at: sentAt || null,
      audience_segment: segment.trim() || null,
      audience_size: numOrNull(audienceSize),
      sale_id: saleId === NONE ? null : saleId,
      launch_id: launchId === NONE ? null : launchId,
      // Typed results columns. The legacy `metrics` jsonb is read-only now —
      // deliberately never written.
      recipients: numOrNull(recipients),
      opens: channel === "email" ? numOrNull(opens) : null,
      clicks: numOrNull(clicks),
      revenue: numOrNull(revenue),
    };
    try {
      if (editing && broadcast) {
        await update.mutateAsync({ id: broadcast.id, updates: payload });
        toast({ title: "Broadcast updated" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Broadcast created" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit broadcast" : "New broadcast"}</DialogTitle>
          <DialogDescription>
            An email or SMS blast. Link it to the sale/launch it's promoting. Results are entered by hand for now.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email (Klaviyo)</SelectItem>
                  <SelectItem value="sms">SMS (Mailchimp)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Name / subject</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Valentine's launch blast" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Scheduled</Label>
              <Input type="date" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} disabled={datesLocked} />
            </div>
            <div className="space-y-1.5">
              <Label>Sent <span className="text-xs text-muted-foreground font-normal">once it goes out</span></Label>
              <Input type="date" value={sentAt} onChange={(e) => setSentAt(e.target.value)} disabled={datesLocked} />
            </div>
          </div>
          {datesLocked && (
            <p className="-mt-2 text-[11px] text-amber-400/80">🔒 This broadcast is in the past — its dates are locked.</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Audience segment</Label>
              <Input value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="e.g. VIPs, all subscribers" />
            </div>
            <div className="space-y-1.5">
              <Label>Audience size</Label>
              <Input type="number" min={0} value={audienceSize} onChange={(e) => setAudienceSize(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Promotes sale <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
              <Select value={saleId} onValueChange={setSaleId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— none —</SelectItem>
                  {sales.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Promotes launch <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
              <Select value={launchId} onValueChange={setLaunchId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— none —</SelectItem>
                  {launches.map((l) => <SelectItem key={l.id} value={l.id}>{launchLabel(l)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border border-border/50 bg-muted/20 p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Results <span className="font-normal">— manual, fill in after the send</span></p>
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Recipients</Label>
                <Input type="number" min={0} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
              </div>
              {channel === "email" && (
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create broadcast"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
