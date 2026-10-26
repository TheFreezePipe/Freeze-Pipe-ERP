import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TASK_TYPES, type TaskType } from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";
import { useRef, useState } from "react";
import { Check, Minus, Plus, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { taskCompletionSchema, safeValidate } from "@/lib/schemas";
import { useProducts, useLogTask, useWarehouseSettings, useWhStartStation } from "@/lib/hooks";
import { MyOutputStrip } from "@/components/manufacturing/MyOutputStrip";
import { LineCartonsBanner } from "@/components/manufacturing/LineCartonsBanner";
import { RtsCartonStep } from "@/components/manufacturing/RtsCartonStep";
import { TakeToLineStep, type StepScanTarget } from "@/components/manufacturing/TakeToLineStep";
import { toast } from "@/hooks/use-toast";
import {
  noCartonNote,
  physicalLayerLive,
  takenUnits,
  type NoCartonReason,
  type TakenCarton,
} from "@/lib/warehouse/rts-cartons";
import { cartonCode, stationCode } from "@/lib/warehouse/scan";

export default function Workspace() {
  const { profile, user } = useAuth();
  const [selectedSKU, setSelectedSKU] = useState<string>("");
  const [taskType, setTaskType] = useState<TaskType | "">("");
  const [quantity, setQuantity] = useState(0);
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: products = [] } = useProducts();
  const logTask = useLogTask();

  // Cartons through manufacturing (design §5.7): the carton steps appear only
  // once wh_settings.physical_layer.live_since has passed. Until then nothing
  // below changes what the Workspace shows or logs.
  const { data: whSettings, dataUpdatedAt: whSettingsAt } = useWarehouseSettings();
  const live = physicalLayerLive(whSettings, whSettingsAt);
  const liveEmptying = live && taskType === "emptying";
  const liveRts = live && (taskType === "rtsing" || taskType === "prefilled_rtsing");
  const { mutate: startStation } = useWhStartStation();
  const [taken, setTaken] = useState<TakenCarton[]>([]);
  const [noCarton, setNoCarton] = useState<NoCartonReason | null>(null);
  // An RTS task whose log has landed: SKU, type and quantity stay put until its labels are done.
  const [rtsLocked, setRtsLocked] = useState(false);
  const [submittedNote, setSubmittedNote] = useState<string | null>(null);
  const stepRef = useRef<StepScanTarget>(null);

  // Fillable-only for the manufacturing tasks; any active SKU for breakage
  // (non-fillables break too — a clip, a base, etc.).
  const activeSKUs = products.filter(p => p.is_active);
  const fillableSKUs = activeSKUs.filter(p => p.category === "fillable");
  const visibleSKUs = taskType === "breakage" ? activeSKUs : fillableSKUs;
  const selectedProduct = products.find(p => p.sku === selectedSKU);

  function selectSKU(sku: string) {
    setSelectedSKU(sku);
    setError(null);
    const product = products.find(p => p.sku === sku);
    // Breakage entries are typically ad-hoc counts (1, 2, a few) and
    // nowhere near a full carton; pre-populating the carton qty would be
    // misleading. Leave qty at whatever it was.
    if (product && taskType !== "breakage") {
      // Live emptying with cartons already scanned: their units, not a standard carton.
      const scanned = liveEmptying ? takenUnits(taken, product.id) : 0;
      setQuantity(scanned > 0 ? scanned : (product.standard_quantity_per_carton ?? 0));
    }
  }

  function selectTaskType(next: TaskType) {
    setTaskType(next);
    // Switching INTO breakage after a SKU is already selected should reset
    // the auto-populated carton qty so the operator has to think about it.
    if (next === "breakage") setQuantity(0);
  }

  /**
   * Validate and write the task log; resolves with the task_log id and throws
   * the sentence to show. `extraNote` (live emptying with no carton scanned)
   * is appended to the worker's notes.
   */
  async function logCurrentTask(extraNote: string | null = null): Promise<string | null> {
    if (!selectedProduct) {
      throw new Error("Please select a SKU");
    }

    const typed = notes.trim();
    const validation = safeValidate(taskCompletionSchema, {
      skuId: selectedProduct.id,
      taskType,
      quantity,
      notes: (extraNote ? [typed, extraNote].filter(Boolean).join(" · ") : typed) || undefined,
    });
    if (!validation.ok) {
      const firstMsg = Object.values(validation.errors)[0] ?? "Invalid input";
      throw new Error(firstMsg);
    }

    if (!profile?.id) {
      throw new Error("Not authenticated");
    }

    try {
      // Single atomic RPC: moves inventory + inserts task_log + inserts audit row.
      // Server-side enforcement rejects insufficient source stock with a descriptive error.
      const result = await logTask.mutateAsync({
        skuId: validation.value.skuId,
        taskType: validation.value.taskType,
        quantity: validation.value.quantity,
        notes: validation.value.notes ?? null,
        actorId: profile.id,
        timeCompleted: new Date().toISOString(),
      });
      return result.task_log_id ?? null;
    } catch (err) {
      // The RPC returns structured errors — surface them directly. Includes:
      //   "insufficient_source_stock" with current/requested quantities
      //   "sku is archived"
      //   "sku not found"
      throw new Error(err instanceof Error ? err.message : "Failed to log task");
    }
  }

  function resetTask() {
    setSubmitted(false);
    setSelectedSKU("");
    setTaskType("");
    setQuantity(0);
    setNotes("");
    setTaken([]);
    setNoCarton(null);
    setRtsLocked(false);
    setSubmittedNote(null);
  }

  function finishLogged(note: string | null = null) {
    setSubmittedNote(note);
    setSubmitted(true);
    setTimeout(resetTask, 1500);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      await logCurrentTask(liveEmptying && taken.length === 0 && noCarton ? noCartonNote(noCarton) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log task");
      return;
    }
    finishLogged();
  }

  // ---- live physical layer only -------------------------------------------------

  /** The RTS step writes the log through here, then relabels against its id. */
  async function logForRts(): Promise<string | null> {
    setError(null);
    const id = await logCurrentTask();
    setRtsLocked(true);
    return id;
  }

  function completeRts(opts: { overlay: boolean; note?: string }) {
    if (opts.overlay) finishLogged(opts.note ?? null);
    else resetTask();
  }

  /** A carton taken to the line: its SKU becomes the task's, and the quantity is the scanned cartons' units. */
  function onTaken(carton: TakenCarton) {
    const next = [...taken, carton];
    setTaken(next);
    setNoCarton(null);
    setError(null);
    let skuId = selectedProduct?.id ?? null;
    if (!selectedProduct && carton.sku_id) {
      const product = products.find((p) => p.id === carton.sku_id);
      if (product) {
        setSelectedSKU(product.sku);
        skuId = product.id;
      }
    }
    const units = takenUnits(next, skuId);
    if (units > 0) setQuantity(units);
  }

  /** A scanner aimed at the SKU box: ERP labels (%C-…, %ST-…) go to the carton step, not the search. */
  function onSkuKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const raw = e.currentTarget.value.trim();
    if (!raw.startsWith("%") || (!cartonCode(raw) && !stationCode(raw))) return;
    e.preventDefault();
    setSelectedSKU("");
    if (stepRef.current) {
      stepRef.current.scan(raw);
    } else if (stationCode(raw)) {
      startStation(
        { scan: raw },
        {
          onSuccess: (r) => toast({ title: `Station: ${r.session.name ?? r.session.code}` }),
          onError: (err) => setError(err instanceof Error ? err.message : "Couldn't start the station"),
        },
      );
    } else {
      setError("Pick Emptying or an RTS task first, then scan the carton.");
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 md:space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Workspace</h1>
        <p className="text-muted-foreground">Log manufacturing tasks</p>
      </div>

      {/* Cartons at the line once the physical layer is live (design §5.7). */}
      {live && <LineCartonsBanner me={user?.id ?? null} />}

      {/* Personal scoreboard — today / this week, links to Performance
          (which defaults staff to the "Just me" scope). */}
      <MyOutputStrip />

      {/* Success animation overlay */}
      {submitted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-3 animate-in zoom-in-95 duration-300">
            <div className="h-20 w-20 rounded-full bg-green-500/20 flex items-center justify-center">
              <Check className="h-10 w-10 text-green-400" />
            </div>
            <p className="text-lg font-semibold text-green-400">Task Logged!</p>
            {submittedNote && <p className="max-w-xs text-center text-sm text-muted-foreground">{submittedNote}</p>}
          </div>
        </div>
      )}

      {/* SKU selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select SKU</CardTitle>
          <Input
            placeholder="Search or scan SKU..."
            value={selectedSKU}
            onChange={(e) => setSelectedSKU(e.target.value)}
            onKeyDown={live ? onSkuKeyDown : undefined}
            className="h-12 text-base"
            autoFocus
            disabled={rtsLocked}
          />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2">
            {visibleSKUs
              .filter(p => !selectedSKU || p.sku.toLowerCase().includes(selectedSKU.toLowerCase()) || p.product_name.toLowerCase().includes(selectedSKU.toLowerCase()))
              .slice(0, 8)
              .map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectSKU(p.sku)}
                disabled={rtsLocked}
                className={cn(
                  "flex flex-col items-start rounded-lg border p-3 text-left transition-all min-h-[56px]",
                  "active:scale-[0.97] touch-manipulation",
                  selectedSKU === p.sku
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border hover:bg-muted/50"
                )}
              >
                <span className="text-sm font-bold">{p.sku}</span>
                <span className="text-xs text-muted-foreground line-clamp-1">{p.product_name}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Task type */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Task Type</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 5 task types: 2-cols on the narrowest layout wraps to 2/2/1 which
              leaves the last tile half-width and ugly. 3 cols lays 3/2 which
              reads cleaner. On tablet/desktop the 5-wide row keeps everything
              inline. Tightened padding + text styling so two-line labels
              (Filling & Capping, Pre-Filled RTSing, Log Breakage) wrap on
              word boundaries instead of mid-word, and so the button heights
              match across the row regardless of label length. */}
          <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
            {Object.entries(TASK_TYPES).map(([key, { label, color, bgColor }]) => (
              <button
                key={key}
                type="button"
                onClick={() => selectTaskType(key as TaskType)}
                disabled={rtsLocked}
                className={cn(
                  "rounded-lg border px-3 py-3 text-center text-sm font-medium leading-tight transition-all",
                  "min-h-[64px] flex items-center justify-center",
                  "[text-wrap:balance] hyphens-none break-words",
                  "active:scale-[0.97] touch-manipulation",
                  taskType === key
                    ? `border-primary ring-1 ring-primary ${bgColor} ${color}`
                    : "border-border hover:bg-muted/50 text-muted-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Emptying, once live: scan the carton being emptied (it moves to the line). */}
      {liveEmptying && (
        <TakeToLineStep
          ref={stepRef}
          product={selectedProduct ? { id: selectedProduct.id, sku: selectedProduct.sku } : null}
          taken={taken}
          noCarton={noCarton}
          onTaken={onTaken}
          onNoCarton={setNoCarton}
          disabled={submitted}
        />
      )}

      {/* Quantity — step by carton for manufacturing tasks, by 1 for breakage.
          The carton hint is hidden for breakage since breakage events are
          almost always single-digit unit counts, not cartons. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quantity</CardTitle>
          {selectedProduct && taskType !== "breakage" && (
            <CardDescription>
              Standard: {selectedProduct.standard_quantity_per_carton} per carton
            </CardDescription>
          )}
          {taskType === "breakage" && (
            <CardDescription>
              Enter the count of broken units to remove from finished inventory.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center gap-4">
            <Button
              variant="outline"
              size="icon"
              className="h-14 w-14 rounded-full text-lg touch-manipulation"
              onClick={() => setQuantity(Math.max(0, quantity - 1))}
              type="button"
              disabled={rtsLocked}
            >
              <Minus className="h-6 w-6" />
            </Button>
            <div className="text-center min-w-[80px]">
              <p className="text-4xl font-bold tabular-nums">{quantity}</p>
              <p className="text-xs text-muted-foreground">units</p>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-14 w-14 rounded-full text-lg touch-manipulation"
              onClick={() => setQuantity(quantity + 1)}
              type="button"
              disabled={rtsLocked}
            >
              <Plus className="h-6 w-6" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* RTS and pre-filled RTS, once live: green carton labels before the task is complete. */}
      {liveRts ? (
        <RtsCartonStep
          ref={stepRef}
          product={
            selectedProduct
              ? {
                  id: selectedProduct.id,
                  sku: selectedProduct.sku,
                  standard_quantity_per_carton: selectedProduct.standard_quantity_per_carton ?? null,
                }
              : null
          }
          quantity={quantity}
          canSubmit={!!selectedSKU && !!taskType && !!quantity && !submitted && !logTask.isPending}
          onLog={logForRts}
          onComplete={completeRts}
        >
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              placeholder="Any notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-12 text-base"
              disabled={rtsLocked}
            />
          </div>
        </RtsCartonStep>
      ) : (
      /* Notes + submit */
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              placeholder="Any notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-12 text-base"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="button"
            className="w-full h-14 text-lg font-semibold touch-manipulation"
            disabled={!selectedSKU || !taskType || !quantity || submitted || logTask.isPending}
            onClick={handleSubmit}
          >
            {submitted ? "Logged!" : logTask.isPending ? "Saving…" : "Log Task"}
          </Button>

          {selectedSKU && taskType && quantity > 0 && (
            <p className="text-center text-xs text-muted-foreground">
              {selectedSKU} · {TASK_TYPES[taskType as TaskType]?.label} · {quantity} units
            </p>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
