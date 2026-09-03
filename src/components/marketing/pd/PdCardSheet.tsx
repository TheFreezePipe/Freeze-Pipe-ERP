/**
 * Product Development — card sheet. Every field is click-to-edit (silent
 * save, toast on error); Advance (and Archive, Purgatory-only) are admin-only
 * and hand off to the Move sheet; recycle/kill are the board's drag gestures.
 * Gate preview comes from gateMissing (pd.ts) and paints missing values red.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown, Send } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import { DISPLAY_CATEGORIES } from "@/lib/constants";
import {
  PD_FIELD_LABEL,
  PD_STAGE_LABEL,
  brandedSpecRequired,
  cardFlags,
  deadlineChain,
  gateMissing,
  nextDeadline,
  nextStage,
  type DeadlineRow,
  type PdStage,
} from "@/lib/marketing/pd";
import {
  useAddPdNote,
  usePdProjectEvents,
  usePdProjectNotes,
  type PdProjectWithRefs,
} from "@/lib/hooks/use-pd";
import { useSuppliers } from "@/lib/hooks/use-suppliers";
import { useProducts } from "@/lib/hooks/use-products";
import { CostBasisEditor, EditableValue, FieldRow, MarginLine, SectionTitle, type EditableOption } from "./PdFields";
import { PdSamplesBlock } from "./PdSamples";
import { PdDropPicker } from "./PdDropPicker";
import { fmtDate, relDays, toCardLike, usePdFieldSave } from "./pd-field-utils";

export interface PdCardSheetProps {
  project: PdProjectWithRefs | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestMove: (to: PdStage, mode: "advance" | "recycle") => void;
  /** Kept for the board contract; the sheet no longer renders a Kill button (drag to Halted). */
  onRequestKill?: () => void;
  onRequestArchive: () => void;
  todayIso: string;
}

const KOOZIE_OPTIONS: EditableOption[] = [
  { value: "No", label: "No" },
  { value: "Yes — black", label: "Yes — black" },
  { value: "Yes — white", label: "Yes — white" },
  { value: "Yes — custom", label: "Yes — custom" },
];
const CATEGORY_OPTIONS: EditableOption[] = [
  { value: "fillable", label: "Fillable" },
  { value: "non_fillable", label: "Non-fillable" },
];
const DISPLAY_CATEGORY_OPTIONS: EditableOption[] = DISPLAY_CATEGORIES.map((c) => ({ value: c, label: c }));

const DEADLINE_TONE: Record<DeadlineRow["state"], string> = {
  done: "text-muted-foreground",
  ok: "text-green-400",
  tight: "text-amber-400",
  late: "text-red-400",
};

/** Gate keys the RFC / Ordered wizards fill themselves — they never block the Advance button. */
function advanceBlocked(next: PdStage, gate: string[]): boolean {
  if (next === "ready_for_confirmation") return false;
  if (next === "ordered") return gate.some((k) => k !== "factory_order");
  return gate.length > 0;
}

export function PdCardSheet({
  project,
  open,
  onOpenChange,
  onRequestMove,
  onRequestArchive,
  todayIso,
}: PdCardSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        {project && (
          <SheetBody
            key={project.id}
            project={project}
            onRequestMove={onRequestMove}
            onRequestArchive={onRequestArchive}
            todayIso={todayIso}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type BodyProps = Omit<PdCardSheetProps, "open" | "onOpenChange" | "project"> & { project: PdProjectWithRefs };

function SheetBody({ project: p, onRequestMove, onRequestArchive, todayIso }: BodyProps) {
  const { isAdmin } = useAuth();
  const { save, pending } = usePdFieldSave(p.id);
  const { data: suppliers = [] } = useSuppliers({ activeOnly: true });
  const { data: products = [] } = useProducts();

  const card = toCardLike(p);
  const stage = card.stage;
  const next = nextStage(stage);
  const gate = next ? gateMissing(card, next) : [];
  const missing = new Set(gate.map((k) => (k === "owner" ? "owner_id" : k)));
  const chain = deadlineChain(card, todayIso);
  const nextDl = nextDeadline(chain);
  const flags = cardFlags(card, todayIso, { hasFactoryOrderLine: !!p.linked_factory_order_id });
  const branded = brandedSpecRequired(card);
  const [costsOpen, setCostsOpen] = useState(false);

  const supplierOptions = useMemo<EditableOption[]>(
    () => suppliers.map((s) => ({ value: s.id, label: s.name })),
    [suppliers],
  );
  const productOptions = useMemo<EditableOption[]>(
    () =>
      products
        .filter((pr) => pr.is_active)
        .map((pr) => ({ value: pr.id, label: `${pr.sku} · ${pr.product_name}` })),
    [products],
  );

  const showArchive = stage === "purgatory";

  const str = (v: string | number | null) => (v == null ? null : String(v));
  const num = (v: string | number | null) => (typeof v === "number" ? v : null);

  return (
    <div className="space-y-5 text-sm">
      <SheetTitle className="sr-only">{p.name}</SheetTitle>
      <SheetDescription className="sr-only">{PD_STAGE_LABEL[stage]}</SheetDescription>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pr-6">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <EditableValue
              kind="text"
              value={p.name}
              maxLength={120}
              onCommit={(v) => {
                if (v) void save({ name: String(v) });
              }}
              className="text-lg font-semibold"
            />
            <Badge variant="outline">{PD_STAGE_LABEL[stage]}</Badge>
            <PdDropPicker project={p} size="sheet" />
          </div>
        </div>

        {/* Decisions: Advance lives here; recycle/kill are the board's drag
            gestures (drop on an earlier lane / the Halted rail). Archive is
            Purgatory-only and has no lane to drag to, so it stays. */}
        {isAdmin && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {next && (
              <Button
                size="sm"
                disabled={advanceBlocked(next, gate)}
                onClick={() => onRequestMove(next, "advance")}
              >
                Advance
                <ArrowRight className="h-3.5 w-3.5" />
                {PD_STAGE_LABEL[next]}
              </Button>
            )}
            {showArchive && (
              <Button size="sm" variant="outline" onClick={onRequestArchive}>
                Archive
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Hypothesis + next action + flags */}
      <div className="space-y-1.5">
        <EditableValue
          kind="textarea"
          value={p.hypothesis}
          missing={missing.has("hypothesis")}
          onCommit={(v) => void save({ hypothesis: str(v) })}
          className="w-full whitespace-pre-wrap"
        />
        {/* The card face's one-line "what's this waiting on"; edited here, shown on the board. */}
        <EditableValue
          kind="text"
          maxLength={60}
          value={p.next_action}
          display={p.next_action ? `→ ${p.next_action}` : undefined}
          onCommit={(v) => void save({ next_action: str(v) })}
          className="text-sm text-muted-foreground"
        />
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {flags.map((f) => (
              <span key={f} className="rounded border border-red-500/50 px-1.5 text-xs text-red-400">
                ⚑ {f}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Deadlines */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Deadlines</SectionTitle>
          <span className="text-xs text-muted-foreground">· target launch</span>
          <EditableValue
            kind="date"
            value={p.target_launch_date}
            missing={missing.has("target_launch_date")}
            onCommit={(v) => void save({ target_launch_date: str(v) })}
            className="text-xs"
          />
        </div>
        {chain ? (
          <div className="grid grid-cols-5 gap-2">
            {chain.map((row) => (
              <div
                key={row.key}
                className={cn(
                  "rounded-md border px-2 py-1.5",
                  nextDl?.key === row.key ? "border-blue-500" : "border-border",
                )}
              >
                <div className="text-[11px] text-muted-foreground">{row.label}</div>
                <div className="text-sm font-medium tabular-nums">{fmtDate(row.date)}</div>
                <div className={cn("text-[11px] tabular-nums", DEADLINE_TONE[row.state])}>
                  {row.state === "done" ? "done" : relDays(row.days)}
                </div>
                {row.air && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                    air {fmtDate(row.air.date)} · {relDays(row.air.days)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Set a target launch date</div>
        )}
      </div>

      {/* Product / Spec */}
      <div className="grid gap-x-10 gap-y-2 md:grid-cols-2">
        <div>
          <SectionTitle>Product</SectionTitle>
          <FieldRow label="Category">
            <EditableValue
              kind="select"
              clearable
              options={DISPLAY_CATEGORY_OPTIONS}
              value={p.display_category}
              missing={missing.has("display_category")}
              onCommit={(v) => void save({ display_category: str(v) })}
            />
          </FieldRow>
          <FieldRow label="Fillable">
            <EditableValue
              kind="select"
              clearable
              options={CATEGORY_OPTIONS}
              value={p.category}
              missing={missing.has("category")}
              onCommit={(v) => void save({ category: str(v) })}
            />
          </FieldRow>
          <FieldRow label="SKU code">
            <EditableValue
              kind="text"
              value={p.sku_code}
              maxLength={40}
              missing={missing.has("sku_code")}
              disabled={!!p.linked_sku_id}
              onCommit={(v) => void save({ sku_code: str(v) })}
            />
          </FieldRow>
          <FieldRow label="MSRP">
            <EditableValue
              kind="money"
              value={p.msrp}
              missing={missing.has("msrp")}
              onCommit={(v) => void save({ msrp: num(v) })}
            />
          </FieldRow>
          <FieldRow label="Carton qty">
            <EditableValue
              kind="number"
              value={p.carton_qty}
              missing={missing.has("carton_qty")}
              onCommit={(v) => void save({ carton_qty: num(v) })}
            />
          </FieldRow>
          <FieldRow label="Comparable SKU">
            <EditableValue
              kind="select"
              clearable
              options={productOptions}
              value={p.comparable_sku_id}
              onCommit={(v) => void save({ comparable_sku_id: str(v) })}
              display={p.comparable_sku ? p.comparable_sku.sku : undefined}
            />
          </FieldRow>
          <FieldRow label="Product created">
            {p.linked_sku_id ? (
              <span className="tabular-nums">
                yes ·{" "}
                <Link to={`/economics/${p.linked_sku_id}`} className="text-blue-400 hover:underline">
                  {p.linked_sku?.sku ?? p.sku_code ?? "SKU"}
                </Link>
              </span>
            ) : (
              <span className={missing.has("product_created") ? "text-red-400" : "text-muted-foreground/60"}>—</span>
            )}
          </FieldRow>
        </div>
        <div>
          <SectionTitle>Spec</SectionTitle>
          <FieldRow label="Packaging">
            <EditableValue
              kind="text"
              value={p.packaging}
              missing={missing.has("packaging")}
              onCommit={(v) => void save({ packaging: str(v) })}
            />
          </FieldRow>
          {branded && (
            <>
              <FieldRow label="Logo placement">
                <EditableValue
                  kind="text"
                  value={p.logo_placement}
                  missing={missing.has("logo_placement")}
                  onCommit={(v) => void save({ logo_placement: str(v) })}
                />
              </FieldRow>
              <FieldRow label="Koozie">
                <EditableValue
                  kind="select"
                  clearable
                  options={KOOZIE_OPTIONS}
                  value={p.koozie}
                  missing={missing.has("koozie")}
                  onCommit={(v) => void save({ koozie: str(v) })}
                />
              </FieldRow>
              <FieldRow label="Insert cards">
                <EditableValue
                  kind="text"
                  value={p.insert_cards}
                  missing={missing.has("insert_cards")}
                  onCommit={(v) => void save({ insert_cards: str(v) })}
                />
              </FieldRow>
            </>
          )}
          <FieldRow label="Spec sent">
            <EditableValue
              kind="date"
              value={p.spec_sent_at ? p.spec_sent_at.slice(0, 10) : null}
              max={todayIso}
              missing={missing.has("spec_sent_at")}
              onCommit={(v) => void save({ spec_sent_at: str(v) })}
            />
          </FieldRow>
        </div>
      </div>

      {/* Factory */}
      <div>
        <SectionTitle>Factory</SectionTitle>
        <div className="grid gap-x-10 gap-y-2 md:grid-cols-2">
          <div>
            <FieldRow label="Factory">
              <EditableValue
                kind="select"
                clearable
                options={supplierOptions}
                value={p.supplier_id}
                missing={missing.has("supplier_id")}
                onCommit={(v) => void save({ supplier_id: str(v) })}
                display={p.supplier ? p.supplier.name : undefined}
              />
            </FieldRow>
            <FieldRow label="Quoted cost">
              <EditableValue
                kind="money"
                value={p.quoted_unit_cost}
                missing={missing.has("quoted_unit_cost")}
                onCommit={(v) => void save({ quoted_unit_cost: num(v) })}
              />
            </FieldRow>
          </div>
          <div>
            <FieldRow label="MOQ">
              <EditableValue
                kind="number"
                value={p.moq_qty}
                missing={missing.has("moq_qty")}
                onCommit={(v) => void save({ moq_qty: num(v) })}
              />
            </FieldRow>
            <FieldRow label="Lead days">
              <EditableValue
                kind="number"
                value={p.quoted_lead_days}
                missing={missing.has("quoted_lead_days")}
                onCommit={(v) => void save({ quoted_lead_days: num(v) })}
              />
            </FieldRow>
          </div>
        </div>
      </div>

      {/* Samples (Phase 2) */}
      <PdSamplesBlock project={p} missing={missing} todayIso={todayIso} />

      {/* Margin + cost basis */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <MarginLine project={p} />
          <Button
            size="sm"
            variant="outline"
            className={cn("ml-auto", missing.has("cost_basis") && "border-red-500 text-red-400")}
            onClick={() => setCostsOpen((o) => !o)}
          >
            Costs
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", costsOpen && "rotate-180")} />
          </Button>
        </div>
        {costsOpen && (
          <div className="rounded-md border border-border p-3">
            <CostBasisEditor project={p} disabled={pending} />
          </div>
        )}
      </div>

      {/* To advance */}
      {next && gate.length > 0 && (
        <div className="text-xs text-red-400">
          To advance → {PD_STAGE_LABEL[next]}: {gate.map((k) => PD_FIELD_LABEL[k] ?? k).join(" · ")}
        </div>
      )}

      {/* Genealogy */}
      <div className="flex flex-wrap items-center gap-1.5">
        <GeneChip on={!!p.linked_launch_id} label="Launch" to={p.linked_launch_id ? "/marketing/launches" : null} />
        <GeneArrow />
        <GeneChip
          on={!!p.linked_sku_id}
          label={`SKU ${p.linked_sku?.sku ?? p.sku_code ?? ""}`.trim()}
          to={p.linked_sku_id ? `/economics/${p.linked_sku_id}` : null}
        />
        <GeneArrow />
        <GeneChip
          on={!!p.linked_factory_order_id}
          label="Factory order"
          to={p.linked_factory_order_id ? `/inventory/factory-orders/${p.linked_factory_order_id}` : null}
          missing={missing.has("factory_order")}
        />
        <GeneArrow />
        <GeneChip on={false} label="Freight" to={null} />
        <GeneArrow />
        <GeneChip on={false} label="First 30d" to={null} />
      </div>

      {/* Activity */}
      <Activity projectId={p.id} todayIso={todayIso} />
    </div>
  );
}

function GeneArrow() {
  return <span className="text-xs text-muted-foreground">→</span>;
}

function GeneChip({ on, label, to, missing }: { on: boolean; label: string; to: string | null; missing?: boolean }) {
  const cls = cn(
    "rounded-full border px-2 py-0.5 text-xs",
    on ? "border-blue-500 text-foreground" : missing ? "border-red-500 text-red-400" : "border-border text-muted-foreground/60",
  );
  if (on && to) {
    return (
      <Link to={to} className={cn(cls, "hover:bg-accent")}>
        {label}
      </Link>
    );
  }
  return <span className={cls}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Activity: stage events + notes, merged reverse-chronological, plus composer
// ---------------------------------------------------------------------------

interface ActivityItem {
  id: string;
  day: string; // ISO date
  ts: string; // ISO timestamp (tie-break)
  author: string;
  text: string;
  logged?: string; // ISO date when a note was back-dated
}

function eventText(e: { outcome: string; from_stage: string | null; to_stage: string | null; reason: string | null }): string {
  const label = (s: string | null) => (s ? (PD_STAGE_LABEL[s as PdStage] ?? s) : "—");
  const reason = e.reason ? ` · ${e.reason}` : "";
  switch (e.outcome) {
    case "advance":
      return `advanced ${label(e.from_stage)} → ${label(e.to_stage)}`;
    case "recycle":
      return `recycled → ${label(e.to_stage)}${reason}`;
    case "revive":
      return `revived → ${label(e.to_stage)}${reason}`;
    case "kill":
      return `killed${reason}`;
    case "archive":
      return `archived${reason}`;
    case "link_fo":
      return "linked factory order";
    default:
      return `${e.outcome}${reason}`;
  }
}

function Activity({ projectId, todayIso }: { projectId: string; todayIso: string }) {
  const { user } = useAuth();
  const { data: events = [] } = usePdProjectEvents(projectId);
  const { data: notes = [] } = usePdProjectNotes(projectId);
  const addNote = useAddPdNote();
  const [text, setText] = useState("");
  const [date, setDate] = useState(() => todayIso);

  const items = useMemo<ActivityItem[]>(() => {
    const out: ActivityItem[] = [];
    for (const e of events) {
      out.push({
        id: `e-${e.id}`,
        day: e.decided_at.slice(0, 10),
        ts: e.decided_at,
        author: e.decider?.full_name ?? "—",
        text: eventText(e),
      });
    }
    for (const n of notes) {
      const created = n.created_at.slice(0, 10);
      out.push({
        id: `n-${n.id}`,
        day: n.occurred_on,
        ts: n.created_at,
        author: n.author?.full_name ?? "—",
        text: n.body,
        logged: n.occurred_on < created ? created : undefined,
      });
    }
    out.sort((a, b) => (a.day === b.day ? (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) : a.day < b.day ? 1 : -1));
    return out;
  }, [events, notes]);

  async function post() {
    const body = text.trim();
    if (!body || addNote.isPending) return;
    try {
      await addNote.mutateAsync({ projectId, body, occurredOn: date || todayIso, authorId: user?.id ?? null });
      setText("");
    } catch (e) {
      toast({ title: "Note not saved", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-2">
      <SectionTitle>Activity</SectionTitle>
      <div className="space-y-1">
        {items.length === 0 && <div className="text-xs text-muted-foreground/60">—</div>}
        {items.map((it) => (
          <div key={it.id} className="flex gap-2 text-xs">
            <span className="w-12 shrink-0 text-muted-foreground tabular-nums">{it.day === todayIso ? "Today" : fmtDate(it.day)}</span>
            <span className="shrink-0 text-muted-foreground">{it.author}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {it.text}
              {it.logged && <span className="text-muted-foreground"> · logged {fmtDate(it.logged)}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void post();
            }
          }}
          className="h-8 text-sm"
        />
        <Input
          type="date"
          value={date}
          max={todayIso}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 w-36 text-xs tabular-nums"
        />
        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!text.trim() || addNote.isPending} onClick={() => void post()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
