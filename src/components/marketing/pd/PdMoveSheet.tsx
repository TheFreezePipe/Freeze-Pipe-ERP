/**
 * Product Development — the Move dialog. One component for every stage
 * change: plain advance (gate preview + Move), the three-step RFC wizard
 * (Spec · Margin · Product → creates the SKU via rpc_pd_promote_product),
 * the Phase-1 Ordered factory-order picker, recycle / kill / archive with a
 * required reason. Admin-only; the RPCs enforce the same rule server-side.
 */
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import { DISPLAY_CATEGORIES } from "@/lib/constants";
import {
  PD_FIELD_LABEL,
  PD_LANES,
  PD_STAGE_LABEL,
  SPEC_FIELDS,
  brandedSpecRequired,
  gateMissing,
  type PdStage,
} from "@/lib/marketing/pd";
import {
  useArchivePdProject,
  useKillPdProject,
  useLinkPdFactoryOrder,
  useMovePdProject,
  usePromotePdProduct,
  type PdProjectWithRefs,
} from "@/lib/hooks/use-pd";
import { useFactoryOrders } from "@/lib/hooks/use-factory-orders";
import { useProducts } from "@/lib/hooks/use-products";
import { CostBasisEditor, EditableValue, FieldRow, MarginLine, type EditableOption } from "./PdFields";
import { fmtDate, toCardLike, usePdFieldSave } from "./pd-field-utils";

export type PdMoveMode = "advance" | "recycle" | "kill" | "archive";

export interface PdMoveSheetProps {
  project: PdProjectWithRefs;
  to: PdStage;
  mode: PdMoveMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

function MissingList({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return <div className="text-xs text-red-400">{keys.map((k) => PD_FIELD_LABEL[k] ?? k).join(" · ")}</div>;
}

export function PdMoveSheet({ project, to, mode, open, onOpenChange, todayIso }: PdMoveSheetProps) {
  const { isAdmin } = useAuth();
  const title =
    mode === "advance" ? `Move to ${PD_STAGE_LABEL[to]}` : mode === "recycle" ? "Recycle" : mode === "kill" ? "Kill" : "Archive";
  const wide = mode === "advance" && to === "ready_for_confirmation";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(wide ? "max-w-2xl" : "max-w-md")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{project.name}</DialogDescription>
        </DialogHeader>
        {!isAdmin ? (
          <div className="text-sm text-muted-foreground">Admins move cards</div>
        ) : (
          <MoveBody
            key={`${project.id}:${mode}:${to}`}
            project={project}
            to={to}
            mode={mode}
            todayIso={todayIso}
            close={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface BodyProps {
  project: PdProjectWithRefs;
  to: PdStage;
  mode: PdMoveMode;
  todayIso: string;
  close: () => void;
}

function MoveBody(props: BodyProps) {
  const { mode, to } = props;
  if (mode === "kill" || mode === "archive") return <ReasonBody {...props} />;
  if (mode === "recycle") return <RecycleBody {...props} />;
  if (to === "ready_for_confirmation") return <RfcWizard {...props} />;
  if (to === "ordered") return <OrderedBody {...props} />;
  return <AdvanceBody {...props} />;
}

// ---------------------------------------------------------------------------
// Plain advance
// ---------------------------------------------------------------------------

function AdvanceBody({ project, to, close }: BodyProps) {
  const move = useMovePdProject();
  const missing = gateMissing(toCardLike(project), to);

  async function go() {
    try {
      await move.mutateAsync({ id: project.id, to });
      toast({ title: `Moved to ${PD_STAGE_LABEL[to]}` });
      close();
    } catch (e) {
      toast({ title: "Move failed", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm">
        {PD_STAGE_LABEL[project.stage as PdStage]} → {PD_STAGE_LABEL[to]}
      </div>
      <MissingList keys={missing} />
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button disabled={missing.length > 0 || move.isPending} onClick={() => void go()}>
          Move
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recycle (earlier lane + reason) — RPC turns this into "revive" from Halted
// ---------------------------------------------------------------------------

function RecycleBody({ project, to, close }: BodyProps) {
  const move = useMovePdProject();
  const stage = project.stage as PdStage;
  const lanes: PdStage[] = PD_LANES.includes(stage)
    ? [...PD_LANES.slice(0, PD_LANES.indexOf(stage)), "purgatory"]
    : [...PD_LANES];
  const [target, setTarget] = useState<PdStage>(() => (lanes.includes(to) ? to : (lanes[0] ?? to)));
  const [reason, setReason] = useState("");
  const ok = reason.trim().length > 0 && !!target;

  async function go() {
    try {
      await move.mutateAsync({ id: project.id, to: target, reason: reason.trim() });
      toast({ title: `Moved to ${PD_STAGE_LABEL[target]}` });
      close();
    } catch (e) {
      toast({ title: "Move failed", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">Lane</Label>
        <Select value={target} onValueChange={(v) => setTarget(v as PdStage)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {lanes.map((l) => (
              <SelectItem key={l} value={l}>
                {PD_STAGE_LABEL[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Reason</Label>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!ok || move.isPending} onClick={() => void go()}>
          Move
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill / Archive (reason required)
// ---------------------------------------------------------------------------

function ReasonBody({ project, mode, close }: BodyProps) {
  const kill = useKillPdProject();
  const archive = useArchivePdProject();
  const [reason, setReason] = useState("");
  const pending = kill.isPending || archive.isPending;
  const isKill = mode === "kill";

  async function go() {
    const r = reason.trim();
    if (!r) return;
    try {
      if (isKill) await kill.mutateAsync({ id: project.id, reason: r });
      else await archive.mutateAsync({ id: project.id, reason: r });
      toast({ title: isKill ? "Killed" : "Archived" });
      close();
    } catch (e) {
      toast({ title: isKill ? "Kill failed" : "Archive failed", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">Reason</Label>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button variant={isKill ? "destructive" : "default"} disabled={!reason.trim() || pending} onClick={() => void go()}>
          {isKill ? "Kill" : "Archive"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered (Phase 1): link an existing factory order
// ---------------------------------------------------------------------------

function OrderedBody({ project, close }: BodyProps) {
  const link = useLinkPdFactoryOrder();
  const { data: orders = [] } = useFactoryOrders();
  const [foId, setFoId] = useState<string>("");
  const missing = gateMissing(toCardLike(project), "ordered").filter((k) => k !== "factory_order");

  const openOrders = useMemo(
    () => orders.filter((o) => !o.canceled_at && o.status !== "shipped" && o.status !== "finished"),
    [orders],
  );

  async function go() {
    if (!foId) return;
    try {
      await link.mutateAsync({ id: project.id, factoryOrderId: foId });
      toast({ title: "Moved to Ordered" });
      close();
    } catch (e) {
      toast({ title: "Link failed", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">Factory order</Label>
        <Select value={foId || undefined} onValueChange={setFoId}>
          <SelectTrigger>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {openOrders.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.order_number ?? o.id.slice(0, 8)} · {o.supplier?.name ?? "—"} · {fmtDate(o.order_date ?? o.created_at)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <MissingList keys={missing} />
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!foId || missing.length > 0 || link.isPending} onClick={() => void go()}>
          Link & move
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RFC wizard: 1 Spec · 2 Margin · 3 Product
// ---------------------------------------------------------------------------

const SPEC_KEYS: ReadonlySet<string> = new Set(SPEC_FIELDS);
const MARGIN_KEYS: ReadonlySet<string> = new Set([
  "msrp",
  "quoted_unit_cost",
  "category",
  "carton_qty",
  "cost_basis",
  "moq_qty",
  "quoted_lead_days",
]);

function StepDots({ step }: { step: 1 | 2 | 3 }) {
  const steps: [number, string][] = [
    [1, "Spec"],
    [2, "Margin"],
    [3, "Product"],
  ];
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map(([n, label], i) => (
        <span key={n} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-muted-foreground">·</span>}
          <span className={cn(n === step ? "font-semibold text-foreground" : "text-muted-foreground")}>
            <span className="tabular-nums">{n}</span> {label}
          </span>
        </span>
      ))}
    </div>
  );
}

function RfcWizard(props: BodyProps) {
  const { project: p, close } = props;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const { save, pending } = usePdFieldSave(p.id);
  const card = toCardLike(p);
  const gate = gateMissing(card, "ready_for_confirmation");
  const missing = new Set(gate);
  const branded = brandedSpecRequired(card);
  const specMissing = gate.filter((k) => SPEC_KEYS.has(k));
  const marginMissing = gate.filter((k) => MARGIN_KEYS.has(k));
  const str = (v: string | number | null) => (v == null ? null : String(v));
  const num = (v: string | number | null) => (typeof v === "number" ? v : null);

  return (
    <div className="space-y-4">
      <StepDots step={step} />

      {step === 1 && (
        <div className="space-y-3">
          <div>
            <FieldRow label="Packaging">
              <EditableValue
                kind="text"
                value={p.packaging}
                missing={missing.has("packaging")}
                disabled={pending}
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
                    disabled={pending}
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
                    disabled={pending}
                    onCommit={(v) => void save({ koozie: str(v) })}
                  />
                </FieldRow>
                <FieldRow label="Insert cards">
                  <EditableValue
                    kind="text"
                    value={p.insert_cards}
                    missing={missing.has("insert_cards")}
                    disabled={pending}
                    onCommit={(v) => void save({ insert_cards: str(v) })}
                  />
                </FieldRow>
              </>
            )}
          </div>
          <MissingList keys={specMissing} />
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button disabled={specMissing.length > 0} onClick={() => setStep(2)}>
              Next
            </Button>
          </DialogFooter>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6">
            <FieldRow label="MSRP">
              <EditableValue
                kind="money"
                value={p.msrp}
                missing={missing.has("msrp")}
                disabled={pending}
                onCommit={(v) => void save({ msrp: num(v) })}
              />
            </FieldRow>
            <FieldRow label="Quoted cost">
              <EditableValue
                kind="money"
                value={p.quoted_unit_cost}
                missing={missing.has("quoted_unit_cost")}
                disabled={pending}
                onCommit={(v) => void save({ quoted_unit_cost: num(v) })}
              />
            </FieldRow>
            <FieldRow label="Fillable">
              <EditableValue
                kind="select"
                clearable
                options={CATEGORY_OPTIONS}
                value={p.category}
                missing={missing.has("category")}
                disabled={pending}
                onCommit={(v) => void save({ category: str(v) })}
              />
            </FieldRow>
            <FieldRow label="Carton qty">
              <EditableValue
                kind="number"
                value={p.carton_qty}
                missing={missing.has("carton_qty")}
                disabled={pending}
                onCommit={(v) => void save({ carton_qty: num(v) })}
              />
            </FieldRow>
            <FieldRow label="MOQ">
              <EditableValue
                kind="number"
                value={p.moq_qty}
                missing={missing.has("moq_qty")}
                disabled={pending}
                onCommit={(v) => void save({ moq_qty: num(v) })}
              />
            </FieldRow>
            <FieldRow label="Lead days">
              <EditableValue
                kind="number"
                value={p.quoted_lead_days}
                missing={missing.has("quoted_lead_days")}
                disabled={pending}
                onCommit={(v) => void save({ quoted_lead_days: num(v) })}
              />
            </FieldRow>
          </div>
          <div className="rounded-md border border-border p-3">
            <CostBasisEditor project={p} disabled={pending} />
          </div>
          <MarginLine project={p} />
          <MissingList keys={marginMissing} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button disabled={marginMissing.length > 0} onClick={() => setStep(3)}>
              Next
            </Button>
          </DialogFooter>
        </div>
      )}

      {step === 3 && <ProductStep project={p} close={close} back={() => setStep(2)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: New SKU form (mirrors SKUList's dialog) → rpc_pd_promote_product → move
// ---------------------------------------------------------------------------

interface ProductForm {
  sku: string;
  product_name: string;
  upc_code: string;
  category: "fillable" | "non_fillable";
  display_category: string;
  retail_price: string;
  standard_quantity_per_carton: string;
  abc_classification: string;
}

function ProductStep({ project: p, close, back }: { project: PdProjectWithRefs; close: () => void; back: () => void }) {
  const { data: products = [] } = useProducts();
  const promote = usePromotePdProduct();
  const move = useMovePdProject();
  const [form, setForm] = useState<ProductForm>(() => ({
    sku: p.sku_code ?? "",
    product_name: p.name,
    upc_code: "",
    category: p.category === "non_fillable" ? "non_fillable" : "fillable",
    display_category: p.display_category ?? "",
    retail_price: p.msrp != null ? String(p.msrp) : "",
    standard_quantity_per_carton: p.carton_qty != null ? String(p.carton_qty) : "",
    abc_classification: "",
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = promote.isPending || move.isPending;

  // Everything the RFC gate needs except what this step produces itself.
  const otherMissing = gateMissing(toCardLike(p), "ready_for_confirmation").filter(
    (k) => k !== "product_created" && k !== "sku_code",
  );

  function update(field: keyof ProductForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const n = { ...prev };
        delete n[field];
        return n;
      });
    }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    const sku = form.sku.trim();
    if (!sku) e.sku = "SKU is required";
    else if (products.some((x) => x.sku.toLowerCase() === sku.toLowerCase())) e.sku = "SKU already exists";
    if (!form.product_name.trim()) e.product_name = "Product name is required";
    if (!form.display_category) e.display_category = "Display category is required";
    if (!form.retail_price || parseFloat(form.retail_price) <= 0) e.retail_price = "Retail price is required";
    if (!form.standard_quantity_per_carton || parseInt(form.standard_quantity_per_carton, 10) <= 0)
      e.standard_quantity_per_carton = "Qty per carton is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function go() {
    if (!validate()) return;
    const sku = form.sku.trim();
    try {
      await promote.mutateAsync({
        id: p.id,
        product: {
          sku,
          product_name: form.product_name.trim(),
          category: form.category,
          display_category: form.display_category,
          retail_price: parseFloat(form.retail_price),
          standard_quantity_per_carton: parseInt(form.standard_quantity_per_carton, 10),
          upc_code: form.upc_code.trim() || null,
          abc_classification: form.abc_classification || null,
        },
      });
    } catch (e) {
      const msg = describeError(e);
      if (msg === "sku_exists") {
        setErrors((prev) => ({ ...prev, sku: "SKU already exists" }));
        return;
      }
      toast({ title: "Product not created", description: msg, variant: "destructive" });
      return;
    }
    try {
      await move.mutateAsync({ id: p.id, to: "ready_for_confirmation" });
      toast({ title: `${sku} created · moved to ${PD_STAGE_LABEL.ready_for_confirmation}` });
      close();
    } catch (e) {
      toast({ title: `${sku} created · move failed`, description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">SKU Code *</Label>
          <Input value={form.sku} onChange={(e) => update("sku", e.target.value)} className={errors.sku ? "border-red-500" : ""} />
          {errors.sku && <p className="text-[11px] text-red-400">{errors.sku}</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Product Name *</Label>
          <Input
            value={form.product_name}
            onChange={(e) => update("product_name", e.target.value)}
            className={errors.product_name ? "border-red-500" : ""}
          />
          {errors.product_name && <p className="text-[11px] text-red-400">{errors.product_name}</p>}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">UPC Code</Label>
        <Input value={form.upc_code} onChange={(e) => update("upc_code", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Manufacturing Category *</Label>
          <Select value={form.category} onValueChange={(v) => update("category", v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fillable">Fillable</SelectItem>
              <SelectItem value="non_fillable">Non-Fillable</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Product Line *</Label>
          <Select value={form.display_category || undefined} onValueChange={(v) => update("display_category", v)}>
            <SelectTrigger className={errors.display_category ? "border-red-500" : ""}>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {DISPLAY_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.display_category && <p className="text-[11px] text-red-400">{errors.display_category}</p>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Retail Price *</Label>
          <Input
            type="number"
            step="0.01"
            value={form.retail_price}
            onChange={(e) => update("retail_price", e.target.value)}
            className={cn("tabular-nums", errors.retail_price && "border-red-500")}
          />
          {errors.retail_price && <p className="text-[11px] text-red-400">{errors.retail_price}</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Qty per Carton *</Label>
          <Input
            type="number"
            value={form.standard_quantity_per_carton}
            onChange={(e) => update("standard_quantity_per_carton", e.target.value)}
            className={cn("tabular-nums", errors.standard_quantity_per_carton && "border-red-500")}
          />
          {errors.standard_quantity_per_carton && (
            <p className="text-[11px] text-red-400">{errors.standard_quantity_per_carton}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ABC Classification</Label>
          <Select value={form.abc_classification || undefined} onValueChange={(v) => update("abc_classification", v)}>
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="A">A</SelectItem>
              <SelectItem value="B">B</SelectItem>
              <SelectItem value="C">C</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <MissingList keys={otherMissing} />
      <DialogFooter>
        <Button variant="outline" onClick={back} disabled={pending}>
          Back
        </Button>
        <Button disabled={pending || otherMissing.length > 0} onClick={() => void go()}>
          Create SKU & move
        </Button>
      </DialogFooter>
    </div>
  );
}
