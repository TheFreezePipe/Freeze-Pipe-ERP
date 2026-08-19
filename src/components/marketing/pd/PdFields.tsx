/**
 * Product Development board — shared field primitives for the card sheet
 * and the Move sheet: the click-to-edit value, label/value rows, the margin
 * line, and the cost-basis editor. Pure helpers live in pd-field-utils.ts.
 */
import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { marginTone } from "@/lib/marketing/pd";
import { useSkuEconomics } from "@/lib/hooks/use-sku-economics";
import type { PdProjectUpdate, PdProjectWithRefs } from "@/lib/hooks/use-pd";
import {
  COST_KEYS,
  FILLABLE_ONLY_KEYS,
  MARGIN_TONE_CLASS,
  NONE,
  fmtDate,
  fmtMoney,
  fmtPct,
  parseCostBasis,
  pdMargin,
  serializeCostBasis,
  usePdFieldSave,
  type CostBasis,
  type CostKey,
} from "./pd-field-utils";

// ---------------------------------------------------------------------------
// Click-to-edit value
// ---------------------------------------------------------------------------

export type EditableKind = "text" | "textarea" | "number" | "money" | "date" | "select";

export interface EditableOption {
  value: string;
  label: string;
}

export interface EditableValueProps {
  kind: EditableKind;
  value: string | number | null | undefined;
  onCommit: (next: string | number | null) => void;
  options?: EditableOption[];
  /** Selects: offer a "—" row that commits null. */
  clearable?: boolean;
  missing?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** Date inputs: upper bound (ISO). */
  max?: string;
  /** Override the read-mode rendering. */
  display?: ReactNode;
  className?: string;
  inputClassName?: string;
}

function parseDraft(kind: EditableKind, draft: string): string | number | null {
  const t = draft.trim();
  if (kind === "number" || kind === "money") {
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "select") return t === "" || t === NONE ? null : t;
  return t === "" ? null : t;
}

function renderValue(kind: EditableKind, value: string | number | null | undefined, options?: EditableOption[]): string {
  if (value == null || value === "") return "—";
  if (kind === "money") return fmtMoney(typeof value === "number" ? value : Number(value));
  if (kind === "date") return fmtDate(String(value));
  if (kind === "select") return options?.find((o) => o.value === String(value))?.label ?? String(value);
  return String(value);
}

/**
 * Renders a value; click swaps to an input. Enter / blur commit, Esc cancels.
 * Commits only when the parsed value actually changed.
 */
export function EditableValue({
  kind,
  value,
  onCommit,
  options,
  clearable,
  missing,
  disabled,
  maxLength,
  max,
  display,
  className,
  inputClassName,
}: EditableValueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const empty = value == null || value === "";
  const isNumeric = kind === "number" || kind === "money";

  function begin() {
    if (disabled) return;
    setDraft(value == null ? "" : String(value));
    setEditing(true);
  }
  function commit(raw: string) {
    setEditing(false);
    const next = parseDraft(kind, raw);
    const prev = value == null || value === "" ? null : isNumeric ? Number(value) : String(value);
    if (next === prev) return;
    onCommit(next);
  }
  function cancel() {
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={begin}
        disabled={disabled}
        className={cn(
          "group -mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 text-left hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent",
          isNumeric && "tabular-nums",
          missing ? "text-red-400" : empty ? "text-muted-foreground/60" : "text-foreground",
          className,
        )}
      >
        <span className="break-words">{display ?? renderValue(kind, value, options)}</span>
        {!disabled && <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60" />}
      </button>
    );
  }

  if (kind === "select") {
    return (
      <Select
        defaultOpen
        value={draft === "" ? undefined : draft}
        onValueChange={(v) => commit(v)}
        onOpenChange={(o) => {
          if (!o) cancel();
        }}
      >
        <SelectTrigger className={cn("h-7 w-full min-w-[8rem] text-xs", inputClassName)} autoFocus>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {clearable && <SelectItem value={NONE}>—</SelectItem>}
          {(options ?? []).map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (kind === "textarea") {
    return (
      <Textarea
        autoFocus
        rows={2}
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Escape") cancel();
        }}
        className={cn("min-h-0 text-sm", inputClassName)}
      />
    );
  }

  return (
    <Input
      autoFocus
      type={kind === "date" ? "date" : isNumeric ? "number" : "text"}
      step={kind === "money" ? "0.01" : kind === "number" ? "1" : undefined}
      inputMode={isNumeric ? "decimal" : undefined}
      max={kind === "date" ? max : undefined}
      maxLength={maxLength}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(draft);
        else if (e.key === "Escape") cancel();
      }}
      className={cn(
        "h-7 w-auto max-w-full text-sm",
        isNumeric && "w-24 tabular-nums",
        kind === "date" && "w-36",
        inputClassName,
      )}
    />
  );
}

/** Label + value row used by every block in the card sheet. */
/**
 * Label / value row. A fixed label column and a flexible value column — the
 * value gets every pixel the label doesn't use and wraps rather than
 * truncating, so "Studio" never renders as "Stu…".
 */
export function FieldRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 py-1", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-sm">{children}</div>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

// ---------------------------------------------------------------------------
// Margin line + cost-basis editor (shared by the card sheet and RFC step 2)
// ---------------------------------------------------------------------------

export function MarginLine({ project, className }: { project: PdProjectWithRefs; className?: string }) {
  const m = pdMargin(project);
  if (!m) return null;
  const tone = marginTone(m.contributionMargin) ?? "ok";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 text-sm tabular-nums", className)}>
      <span>Landed {fmtMoney(m.totalD2C)}</span>
      <span className="text-muted-foreground">·</span>
      <span>MSRP {fmtMoney(project.msrp)}</span>
      <span className="text-muted-foreground">·</span>
      <span>
        Margin <span className={cn("font-semibold", MARGIN_TONE_CLASS[tone])}>{fmtPct(m.contributionMargin)}</span>
      </span>
    </div>
  );
}

const EMPTY_BASIS: CostBasis = { values: {}, seeded: {} };

export function CostBasisEditor({ project, disabled }: { project: PdProjectWithRefs; disabled?: boolean }) {
  const cb = parseCostBasis(project.cost_basis) ?? EMPTY_BASIS;
  const { save, pending } = usePdFieldSave(project.id);
  const comparable = project.comparable_sku;
  const { data: compEcon } = useSkuEconomics(project.comparable_sku_id);
  const confirmed = project.cost_basis_confirmed;

  function persist(next: CostBasis, extra: PdProjectUpdate = {}) {
    return save({ cost_basis: serializeCostBasis(next) as PdProjectUpdate["cost_basis"], ...extra });
  }

  function setValue(key: CostKey, n: string | number | null) {
    const values = { ...cb.values };
    const seeded = { ...cb.seeded };
    if (n == null || typeof n !== "number") delete values[key];
    else values[key] = n;
    delete seeded[key];
    void persist({ values, seeded });
  }

  function seed() {
    if (!comparable || !compEcon) return;
    const values = { ...cb.values };
    const seeded = { ...cb.seeded };
    for (const { key } of COST_KEYS) {
      if (values[key] != null) continue;
      if (FILLABLE_ONLY_KEYS.has(key) && project.category !== "fillable") continue;
      const v = compEcon[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        values[key] = v;
        seeded[key] = comparable.sku;
      }
    }
    void persist({ values, seeded });
  }

  function confirm() {
    void persist({ values: cb.values, seeded: {} }, { cost_basis_confirmed: true });
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-6">
        {COST_KEYS.map(({ key, label, kind }) => (
          <FieldRow key={key} label={label}>
            <span className="inline-flex items-center gap-1.5">
              {cb.seeded[key] && (
                <span className="rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
                  from {cb.seeded[key]}
                </span>
              )}
              <EditableValue
                kind={kind}
                value={cb.values[key] ?? null}
                onCommit={(v) => setValue(key, v)}
                disabled={disabled || pending}
                display={kind === "number" && cb.values[key] != null ? `${cb.values[key]}%` : undefined}
              />
            </span>
          </FieldRow>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || pending || !comparable || !compEcon}
          onClick={seed}
        >
          Seed from {comparable?.sku ?? "comparable"}
        </Button>
        {confirmed ? (
          <span className="text-xs font-medium text-green-400">Confirmed</span>
        ) : (
          <Button type="button" size="sm" disabled={disabled || pending} onClick={confirm}>
            Confirm costs
          </Button>
        )}
      </div>
    </div>
  );
}
