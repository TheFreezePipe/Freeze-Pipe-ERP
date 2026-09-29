import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ChevronRight, Plus, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { readyByDefault } from "@/lib/marketing/workback";
import { followsLaunch, movePreview, pdStageLabel, type MovePreview } from "@/lib/marketing/launch-link";
import {
  useCreateLaunch,
  useUpdateLaunch,
  useProducts,
  usePdBoard,
  type MktLaunchWithMembers,
  type LaunchMemberInput,
} from "@/lib/hooks";
import { LAUNCH_KINDS } from "./launch-format";
import { DateShift, OwnDateChip, StageChip } from "./LaunchLinkParts";
import { LaunchMoveConfirm } from "./LaunchMoveConfirm";

/** "Create launch" from a PD drop: the form opens prefilled with the drop's cards as products. */
export interface LaunchFormPrefillInput {
  name: string;
  kind: string;
  launchDate: string | null;
  members: Array<{ pd_project_id: string; planned_name: string; included: boolean }>;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch?: MktLaunchWithMembers | null;
  /** Prefill launch date when creating (e.g. from a calendar day click). */
  defaultDate?: string | null;
  /** Lock the date fields (past launch — protected from rescheduling). */
  datesLocked?: boolean;
  /** Create from a PD drop (ignored when `launch` is set). Unticked products are not saved. */
  prefill?: LaunchFormPrefillInput;
}

const NONE = "__none__";
const dateInput = (v: string | null) => (v ? v.slice(0, 10) : "");
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

type MemberRow = {
  sku_id: string;
  planned_name: string;
  expected: string;
  limited: string;
  confidence: string;
  /** The PD card this product stands for (name read-only; the card owns it). */
  pd_project_id: string | null;
  /** Saved only while ticked (create-from-drop rows start ticked unless halted). */
  included: boolean;
  /** Shows the tick box (create-from-drop rows). */
  optional: boolean;
};
const emptyMember = (): MemberRow => ({
  sku_id: NONE,
  planned_name: "",
  expected: "",
  limited: "",
  confidence: NONE,
  pd_project_id: null,
  included: true,
  optional: false,
});

export function LaunchFormDialog(props: Props) {
  const { open, onOpenChange, launch, defaultDate } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        {/* Mounted while open (DialogContent unmounts on close), so every open starts from the props. */}
        <LaunchFormBody key={`${launch?.id ?? "new"}:${defaultDate ?? ""}`} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function initialMembers(launch: MktLaunchWithMembers | null | undefined, prefill: LaunchFormPrefillInput | undefined): MemberRow[] {
  if (launch) {
    const rows = (launch.skus ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((s): MemberRow => ({
        sku_id: s.sku_id ?? NONE,
        planned_name: s.planned_name ?? "",
        expected: s.expected_first_30d_units != null ? String(s.expected_first_30d_units) : "",
        limited: s.limited_qty != null ? String(s.limited_qty) : "",
        confidence: s.planner_confidence != null ? String(s.planner_confidence) : NONE,
        pd_project_id: s.pd_project_id ?? null,
        included: true,
        optional: false,
      }));
    return rows.length > 0 ? rows : [emptyMember()];
  }
  if (prefill && prefill.members.length > 0) {
    return prefill.members.map((m) => ({
      ...emptyMember(),
      planned_name: m.planned_name,
      pd_project_id: m.pd_project_id,
      included: m.included,
      optional: true,
    }));
  }
  return [emptyMember()];
}

interface CardInfo {
  name: string;
  stage: string;
  target: string | null;
  /** Attached to the launch being edited and on its own date. */
  ownDate: boolean;
  sku: string | null;
}

function LaunchFormBody({ onOpenChange, launch, defaultDate, datesLocked, prefill }: Props) {
  const { data: products = [] } = useProducts();
  const { data: board = [] } = usePdBoard();
  const create = useCreateLaunch();
  const update = useUpdateLaunch();
  const editing = !!launch;
  const fromDrop = !launch && !!prefill;

  const [name, setName] = useState(() => launch?.name ?? prefill?.name ?? "");
  const [kind, setKind] = useState<string>(() => launch?.kind ?? prefill?.kind ?? "launch");
  const [launchDate, setLaunchDate] = useState(
    () => dateInput(launch?.launch_date ?? null) || (launch ? "" : dateInput(prefill?.launchDate ?? null)) || (defaultDate ?? ""),
  );
  const [earlyAccess, setEarlyAccess] = useState(() => dateInput(launch?.early_access_date ?? null));
  const [readyBy, setReadyBy] = useState(() => dateInput(launch?.inventory_ready_by ?? null));
  // Ready-by is derived (earliest launch date − READY_BY_LEAD_DAYS) until the
  // user types one; clearing the field returns to the derived value.
  const [readyByTouched, setReadyByTouched] = useState(() => !!launch?.inventory_ready_by);
  const [notes, setNotes] = useState(() => launch?.notes ?? "");
  const [members, setMembers] = useState<MemberRow[]>(() => initialMembers(launch, prefill));
  // The move confirm keeps its last preview while it animates closed.
  const [move, setMove] = useState<MovePreview | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // What a card-backed product shows: the card's name, stage, date and SKU.
  const cardInfo = useMemo(() => {
    const m = new Map<string, CardInfo>();
    for (const c of board) {
      m.set(c.id, { name: c.name, stage: c.stage, target: c.target_launch_date, ownDate: false, sku: c.linked_sku?.sku ?? null });
    }
    for (const c of launch?.cards ?? []) {
      const sku = launch?.skus.find((s) => s.pd_project_id === c.id)?.product?.sku ?? m.get(c.id)?.sku ?? null;
      m.set(c.id, { name: c.name, stage: c.stage, target: c.target_launch_date, ownDate: !followsLaunch(c), sku });
    }
    return m;
  }, [board, launch]);

  const pending = create.isPending || update.isPending;
  const isStudio = kind === "studio_drop";

  const effectiveReadyBy = readyByTouched ? readyBy : readyByDefault(earlyAccess, launchDate);
  const earlyAccessAfterLaunch = !!earlyAccess && !!launchDate && earlyAccess > launchDate;
  const includedCount = members.filter((m) => m.included).length;

  function updateMember(i: number, patch: Partial<MemberRow>) {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }

  async function save() {
    const memberPayload: LaunchMemberInput[] = members
      .filter((m) => m.included)
      .map((m) => ({
        sku_id: m.sku_id === NONE ? null : m.sku_id,
        planned_name: m.sku_id === NONE ? m.planned_name.trim() || null : null,
        expected_first_30d_units: numOrNull(m.expected),
        limited_qty: numOrNull(m.limited),
        planner_confidence: m.confidence === NONE ? null : Number(m.confidence),
        pd_project_id: m.pd_project_id,
      }));
    const launchPayload = {
      name: name.trim(),
      kind,
      launch_date: launchDate || null,
      early_access_date: earlyAccess || null,
      inventory_ready_by: effectiveReadyBy || null,
      notes: notes.trim() || null,
    };
    try {
      if (editing && launch) {
        await update.mutateAsync({ id: launch.id, updates: launchPayload, members: memberPayload });
        toast({ title: "Launch updated" });
      } else {
        await create.mutateAsync({ launch: launchPayload, members: memberPayload });
        toast({ title: "Launch created" });
      }
      setMoveOpen(false);
      onOpenChange(false);
    } catch (err) {
      setMoveOpen(false);
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  function handleSubmit() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the launch/drop a name.", variant: "destructive" });
      return;
    }
    // The database refuses early access after the launch date
    // (mkt_launches_early_access_check); say so here instead of surfacing
    // the raw constraint error. A typed date bypasses the input's max.
    if (earlyAccessAfterLaunch) {
      toast({ title: "Invalid dates", description: "Early access opens after the launch date.", variant: "destructive" });
      return;
    }
    // Each member must identify a product (existing SKU or a working name).
    for (const m of members) {
      if (!m.included || m.pd_project_id) continue;
      if (m.sku_id === NONE && !m.planned_name.trim()) {
        toast({ title: "Identify each product", description: "Pick a SKU or enter a working name for every product row.", variant: "destructive" });
        return;
      }
    }
    // Moving a launch moves the cards that follow it: confirm first.
    if (editing && launch && !datesLocked && dateInput(launch.launch_date) !== launchDate && launch.cards.some((c) => !c.archived_at)) {
      setMove(
        movePreview(launch, launchDate || null, launch.cards, format(new Date(), "yyyy-MM-dd"), {
          inventory_ready_by: effectiveReadyBy || null,
          early_access_date: earlyAccess || null,
        }),
      );
      setMoveOpen(true);
      return;
    }
    void save();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit launch" : "New launch / drop"}</DialogTitle>
        <DialogDescription className="sr-only">Launch name, dates and products</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isStudio ? "e.g. Summer Studio Drop" : "e.g. Mini Recycler launch"} />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LAUNCH_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label>Early access <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
            <Input
              type="date"
              value={earlyAccess}
              max={launchDate || undefined}
              onChange={(e) => setEarlyAccess(e.target.value)}
              disabled={datesLocked}
              aria-invalid={earlyAccessAfterLaunch || undefined}
              className={earlyAccessAfterLaunch ? "border-destructive focus-visible:ring-destructive" : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Launch date</Label>
            <Input
              type="date"
              value={launchDate}
              onChange={(e) => setLaunchDate(e.target.value)}
              disabled={datesLocked}
              aria-invalid={earlyAccessAfterLaunch || undefined}
              className={earlyAccessAfterLaunch ? "border-destructive focus-visible:ring-destructive" : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Inventory ready by</Label>
            <Input
              type="date"
              value={effectiveReadyBy}
              onChange={(e) => {
                setReadyBy(e.target.value);
                setReadyByTouched(e.target.value !== "");
              }}
              disabled={datesLocked}
            />
          </div>
        </div>
        {datesLocked && (
          <p className="-mt-2 text-[11px] text-amber-400/80">🔒 This launch date has passed — its dates are locked.</p>
        )}

        {/* Member products */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-base">Products <span className="text-xs font-normal text-muted-foreground">({includedCount})</span></Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setMembers((prev) => [...prev, emptyMember()])}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add product
            </Button>
          </div>

          {members.map((m, i) => {
            const info = m.pd_project_id ? cardInfo.get(m.pd_project_id) : undefined;
            return (
              <div
                key={m.pd_project_id ?? `row-${i}`}
                className={`space-y-3 rounded-lg border p-3 ${m.pd_project_id ? "border-violet-500/30" : "border-border/50"} ${m.included ? "" : "opacity-60"}`}
              >
                {m.pd_project_id ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {m.optional && (
                      <Checkbox
                        checked={m.included}
                        onCheckedChange={(v) => updateMember(i, { included: v === true })}
                        aria-label={info?.name ?? m.planned_name}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium" title={info?.name ?? m.planned_name}>
                      {info?.name ?? (m.planned_name || "—")}
                      {info?.sku && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{info.sku}</span>}
                    </span>
                    {info && <StageChip label={pdStageLabel(info.stage)} />}
                    {info && m.included && (
                      info.ownDate ? (
                        <OwnDateChip date={info.target} />
                      ) : (
                        <span className="text-xs"><DateShift from={info.target} to={launchDate || info.target} /></span>
                      )
                    )}
                    {editing && (
                      <Link
                        to={`/marketing/product-development?card=${m.pd_project_id}`}
                        className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Open <ChevronRight className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">Product {i + 1}</span>
                      {members.length > 1 && (
                        <button type="button" onClick={() => setMembers((prev) => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Existing SKU</Label>
                        <Select value={m.sku_id} onValueChange={(v) => updateMember(i, { sku_id: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>— new / planned —</SelectItem>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                <span className="font-mono text-xs">{p.sku}</span>
                                <span className="ml-2 text-muted-foreground">{p.product_name}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Working name <span className="text-muted-foreground/60">if new</span></Label>
                        <Input
                          value={m.planned_name}
                          onChange={(e) => updateMember(i, { planned_name: e.target.value })}
                          placeholder="not-yet-created product"
                          disabled={m.sku_id !== NONE}
                        />
                      </div>
                    </div>
                  </>
                )}
                {m.included && !(m.pd_project_id && fromDrop) && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Exp. 1st-30d units</Label>
                      <Input type="number" min={0} value={m.expected} onChange={(e) => updateMember(i, { expected: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Limited qty</Label>
                      <Input type="number" min={0} value={m.limited} onChange={(e) => updateMember(i, { limited: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Confidence (1–5)</Label>
                      <Select value={m.confidence} onValueChange={(v) => updateMember(i, { confidence: v })}>
                        <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>—</SelectItem>
                          {[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <Label>Notes <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Create launch"}
        </Button>
      </DialogFooter>

      {launch && (
        <LaunchMoveConfirm
          open={moveOpen && !!move}
          launchName={name.trim() || launch.name}
          preview={move}
          pending={pending}
          onCancel={() => setMoveOpen(false)}
          onConfirm={() => void save()}
        />
      )}
    </>
  );
}
