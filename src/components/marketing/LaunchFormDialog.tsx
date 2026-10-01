/**
 * Launch / drop form (create, edit, create-from-drop). One product, one row:
 * a SKU pick whose SKU belongs to a live PD card turns the row into the
 * card's row on the spot — card name, stage and the date change it will get
 * — and is saved WITH the card (pd_project_id), so the card attaches in the
 * same rpc_save_launch. The X on a card row removes the product; on an
 * attached card that is a detach (detach_pd_project_ids, processed last by
 * the server). Halted cards are never shown: stopped cards do not ride a
 * launch. Arrived (archived) cards stay listed, frozen.
 */
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
import {
  followsLaunch,
  isArrived,
  movePreview,
  pdStageLabel,
  MEMBER_STATE_LABEL,
  type MovePreview,
} from "@/lib/marketing/launch-link";
import {
  useCreateLaunch,
  useUpdateLaunch,
  useProducts,
  usePdBoard,
  type LaunchSaveInput,
  type MktLaunchInsert,
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
  members: Array<{
    pd_project_id: string;
    planned_name: string;
    included: boolean;
    /** Optional card facts for cards the board does not list (arrived cards): what the row shows. */
    stage?: string;
    arrived?: boolean;
    target_launch_date?: string | null;
    sku?: string | null;
  }>;
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
  /** Stable React key (rows are added and removed by key, never by index). */
  key: string;
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
  /** The row existed when the form opened (edit): removing it detaches the card. */
  fromOpen: boolean;
};
const emptyMember = (key: string): MemberRow => ({
  key,
  sku_id: NONE,
  planned_name: "",
  expected: "",
  limited: "",
  confidence: NONE,
  pd_project_id: null,
  included: true,
  optional: false,
  fromOpen: false,
});
const newKey = () => `row-${crypto.randomUUID()}`;

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
    const halted = new Set(launch.cards.filter((c) => c.stage === "halted").map((c) => c.id));
    const rows = (launch.skus ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .filter((s) => !s.pd_project_id || !halted.has(s.pd_project_id))
      .map((s, i): MemberRow => ({
        key: `open-${i}`,
        sku_id: s.sku_id ?? NONE,
        planned_name: s.planned_name ?? "",
        expected: s.expected_first_30d_units != null ? String(s.expected_first_30d_units) : "",
        limited: s.limited_qty != null ? String(s.limited_qty) : "",
        confidence: s.planner_confidence != null ? String(s.planner_confidence) : NONE,
        pd_project_id: s.pd_project_id ?? null,
        included: true,
        optional: false,
        fromOpen: true,
      }));
    return rows.length > 0 ? rows : [emptyMember("open-0")];
  }
  if (prefill && prefill.members.length > 0) {
    return prefill.members.map((m, i) => ({
      ...emptyMember(`prefill-${i}`),
      planned_name: m.planned_name,
      pd_project_id: m.pd_project_id,
      included: m.included,
      optional: true,
    }));
  }
  return [emptyMember("open-0")];
}

interface CardInfo {
  name: string;
  stage: string;
  target: string | null;
  /** Attached to the launch being edited and on its own date. */
  ownDate: boolean;
  /** Archived as arrived: frozen, no date change. */
  arrived: boolean;
  /** Halted: never on a launch (the row is hidden). */
  halted: boolean;
  /** The other launch the card rides now (it leaves it when this one saves). */
  otherLaunch: string | null;
  sku: string | null;
}

function LaunchFormBody({ onOpenChange, launch, defaultDate, datesLocked, prefill }: Props) {
  const { data: products = [] } = useProducts();
  const { data: board = [] } = usePdBoard();
  const create = useCreateLaunch();
  const update = useUpdateLaunch();
  const editing = !!launch;

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
  // Cards whose row the X removed (edit): detached by the save, last.
  const [detached, setDetached] = useState<string[]>([]);
  // The cards that had a row at open: only these can be dropped by the save's
  // detached-while-open guard; a card picked in this session goes through.
  const [openedWithCardIds] = useState<string[]>(() =>
    initialMembers(launch, prefill)
      .map((m) => m.pd_project_id)
      .filter((id): id is string => !!id && !!launch),
  );
  // The move confirm keeps its last preview while it animates closed.
  const [move, setMove] = useState<MovePreview | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // What a card-backed product shows: the card's name, stage, date and SKU.
  const cardInfo = useMemo(() => {
    const m = new Map<string, CardInfo>();
    for (const p of prefill?.members ?? []) {
      m.set(p.pd_project_id, {
        name: p.planned_name,
        stage: p.stage ?? "",
        target: p.target_launch_date ?? null,
        ownDate: false,
        arrived: !!p.arrived,
        halted: p.stage === "halted",
        otherLaunch: null,
        sku: p.sku ?? null,
      });
    }
    for (const c of board) {
      m.set(c.id, {
        name: c.name,
        stage: c.stage,
        target: c.target_launch_date,
        ownDate: false,
        arrived: false,
        halted: c.stage === "halted",
        otherLaunch: c.linked_launch_id && c.linked_launch_id !== launch?.id ? c.launch?.name ?? "another launch" : null,
        sku: c.linked_sku?.sku ?? null,
      });
    }
    for (const c of launch?.cards ?? []) {
      const sku = launch?.skus.find((s) => s.pd_project_id === c.id)?.product?.sku ?? m.get(c.id)?.sku ?? null;
      m.set(c.id, {
        name: c.name,
        stage: c.stage,
        target: c.target_launch_date,
        ownDate: !isArrived(c) && !followsLaunch(c),
        arrived: isArrived(c),
        halted: c.stage === "halted",
        otherLaunch: null,
        sku,
      });
    }
    return m;
  }, [board, launch, prefill]);

  // Stopped cards never ride a launch: their rows are hidden and never saved.
  const rows = useMemo(() => members.filter((m) => !m.pd_project_id || !cardInfo.get(m.pd_project_id)?.halted), [members, cardInfo]);

  const pending = create.isPending || update.isPending;
  const isStudio = kind === "studio_drop";

  const effectiveReadyBy = readyByTouched ? readyBy : readyByDefault(earlyAccess, launchDate);
  const earlyAccessAfterLaunch = !!earlyAccess && !!launchDate && earlyAccess > launchDate;
  const includedCount = rows.filter((m) => m.included).length;

  function updateMember(key: string, patch: Partial<MemberRow>) {
    setMembers((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }

  /** The live, unhalted card that owns a SKU (the board; an attached card on this launch counts too). */
  function cardForSku(skuId: string) {
    const onBoard = board.find((c) => c.linked_sku_id === skuId && c.stage !== "halted");
    if (onBoard) return { id: onBoard.id };
    const attached = launch?.cards.find((c) => c.linked_sku_id === skuId && c.stage !== "halted" && !c.archived_at);
    return attached ? { id: attached.id } : null;
  }

  /** A SKU pick: the row becomes the owning card's row when the SKU has a live card. One product, one row. */
  function pickSku(key: string, skuId: string) {
    if (skuId === NONE) {
      updateMember(key, { sku_id: NONE });
      return;
    }
    const card = cardForSku(skuId);
    const already = rows.some((m) => m.key !== key && m.included && (m.sku_id === skuId || (card != null && m.pd_project_id === card.id)));
    if (already) {
      toast({ title: "Already on this launch", variant: "destructive" });
      return;
    }
    if (!card) {
      updateMember(key, { sku_id: skuId });
      return;
    }
    const wasDetached = detached.includes(card.id);
    if (wasDetached) setDetached((prev) => prev.filter((id) => id !== card.id));
    updateMember(key, { sku_id: skuId, pd_project_id: card.id, planned_name: "", fromOpen: wasDetached });
  }

  /** Remove a product row; an attached card's row is detached by the save. */
  function removeMember(key: string) {
    const m = members.find((r) => r.key === key);
    if (m?.pd_project_id && m.fromOpen && !detached.includes(m.pd_project_id)) {
      setDetached((prev) => [...prev, m.pd_project_id!]);
    }
    setMembers((prev) => prev.filter((r) => r.key !== key));
  }

  async function save() {
    const memberPayload: LaunchMemberInput[] = rows
      .filter((m) => m.included)
      .map((m) => ({
        sku_id: m.sku_id === NONE ? null : m.sku_id,
        planned_name: m.sku_id === NONE ? m.planned_name.trim() || null : null,
        expected_first_30d_units: numOrNull(m.expected),
        limited_qty: numOrNull(m.limited),
        planner_confidence: m.confidence === NONE ? null : Number(m.confidence),
        pd_project_id: m.pd_project_id,
      }));
    const launchPayload: MktLaunchInsert = {
      name: name.trim(),
      kind,
      launch_date: launchDate || null,
      early_access_date: earlyAccess || null,
      inventory_ready_by: effectiveReadyBy || null,
      notes: notes.trim() || null,
    };
    try {
      if (editing && launch) {
        // Cards whose row the X removed detach last, server-side (their row goes unless it has actuals).
        const updates: LaunchSaveInput = detached.length > 0 ? { ...launchPayload, detach_pd_project_ids: detached } : launchPayload;
        await update.mutateAsync({ id: launch.id, updates, members: memberPayload, openedWithCardIds });
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
    for (const m of rows) {
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
            <Button type="button" variant="outline" size="sm" onClick={() => setMembers((prev) => [...prev, emptyMember(newKey())])}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add product
            </Button>
          </div>

          {rows.map((m, i) => {
            const info = m.pd_project_id ? cardInfo.get(m.pd_project_id) : undefined;
            const removable = m.pd_project_id ? !m.optional : rows.length > 1;
            return (
              <div
                key={m.key}
                className={`space-y-3 rounded-lg border p-3 ${m.pd_project_id ? "border-violet-500/30" : "border-border/50"} ${m.included ? "" : "opacity-60"}`}
              >
                {m.pd_project_id ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {m.optional && (
                      <Checkbox
                        checked={m.included}
                        onCheckedChange={(v) => updateMember(m.key, { included: v === true })}
                        aria-label={info?.name ?? m.planned_name}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium" title={info?.name ?? m.planned_name}>
                      {info?.name ?? (m.planned_name || "—")}
                      {info?.sku && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{info.sku}</span>}
                    </span>
                    {info && (info.arrived ? (
                      <StageChip label={MEMBER_STATE_LABEL.arrived} tone="ok" />
                    ) : info.stage ? (
                      <StageChip label={pdStageLabel(info.stage)} />
                    ) : null)}
                    {info && m.included && !info.arrived && (
                      info.ownDate ? (
                        <OwnDateChip date={info.target} />
                      ) : (
                        <span className="text-xs"><DateShift from={info.target} to={launchDate || info.target} /></span>
                      )
                    )}
                    {info?.otherLaunch && m.included && (
                      <span className="whitespace-nowrap text-[10px] text-muted-foreground">leaves {info.otherLaunch}</span>
                    )}
                    {editing && (
                      <Link
                        to={`/marketing/product-development?card=${m.pd_project_id}`}
                        className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Open <ChevronRight className="h-3 w-3" />
                      </Link>
                    )}
                    {removable && (
                      <button type="button" onClick={() => removeMember(m.key)} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${info?.name ?? m.planned_name}`}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">Product {i + 1}</span>
                      {removable && (
                        <button type="button" onClick={() => removeMember(m.key)} className="text-muted-foreground hover:text-foreground" aria-label={`Remove product ${i + 1}`}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Existing SKU</Label>
                        <Select value={m.sku_id} onValueChange={(v) => pickSku(m.key, v)}>
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
                          onChange={(e) => updateMember(m.key, { planned_name: e.target.value })}
                          placeholder="not-yet-created product"
                          disabled={m.sku_id !== NONE}
                        />
                      </div>
                    </div>
                  </>
                )}
                {m.included && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Exp. 1st-30d units</Label>
                      <Input type="number" min={0} value={m.expected} onChange={(e) => updateMember(m.key, { expected: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Limited qty</Label>
                      <Input type="number" min={0} value={m.limited} onChange={(e) => updateMember(m.key, { limited: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Confidence (1–5)</Label>
                      <Select value={m.confidence} onValueChange={(v) => updateMember(m.key, { confidence: v })}>
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
