import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TASK_TYPES, type TaskType } from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";
import { useState } from "react";
import { Check, Minus, Plus, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { taskCompletionSchema, safeValidate } from "@/lib/schemas";
import { useProducts, useLogTask } from "@/lib/hooks";

export default function Workspace() {
  const { profile } = useAuth();
  const [selectedSKU, setSelectedSKU] = useState<string>("");
  const [taskType, setTaskType] = useState<TaskType | "">("");
  const [quantity, setQuantity] = useState(0);
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: products = [] } = useProducts();
  const logTask = useLogTask();

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
      setQuantity(product.standard_quantity_per_carton);
    }
  }

  function selectTaskType(next: TaskType) {
    setTaskType(next);
    // Switching INTO breakage after a SKU is already selected should reset
    // the auto-populated carton qty so the operator has to think about it.
    if (next === "breakage") setQuantity(0);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!selectedProduct) {
      setError("Please select a SKU");
      return;
    }

    const validation = safeValidate(taskCompletionSchema, {
      skuId: selectedProduct.id,
      taskType,
      quantity,
      notes: notes.trim() || undefined,
    });
    if (!validation.ok) {
      const firstMsg = Object.values(validation.errors)[0] ?? "Invalid input";
      setError(firstMsg);
      return;
    }

    if (!profile?.id) {
      setError("Not authenticated");
      return;
    }

    try {
      // Single atomic RPC: moves inventory + inserts task_log + inserts audit row.
      // Server-side enforcement rejects insufficient source stock with a descriptive error.
      await logTask.mutateAsync({
        skuId: validation.value.skuId,
        taskType: validation.value.taskType,
        quantity: validation.value.quantity,
        notes: validation.value.notes ?? null,
        actorId: profile.id,
        timeCompleted: new Date().toISOString(),
      });

      setSubmitted(true);
      setTimeout(() => {
        setSubmitted(false);
        setSelectedSKU("");
        setTaskType("");
        setQuantity(0);
        setNotes("");
      }, 1500);
    } catch (err) {
      // The RPC returns structured errors — surface them directly. Includes:
      //   "insufficient_source_stock" with current/requested quantities
      //   "sku is archived"
      //   "sku not found"
      setError(err instanceof Error ? err.message : "Failed to log task");
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 md:space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Workspace</h1>
        <p className="text-muted-foreground">Log manufacturing tasks</p>
      </div>

      {/* Success animation overlay */}
      {submitted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-3 animate-in zoom-in-95 duration-300">
            <div className="h-20 w-20 rounded-full bg-green-500/20 flex items-center justify-center">
              <Check className="h-10 w-10 text-green-400" />
            </div>
            <p className="text-lg font-semibold text-green-400">Task Logged!</p>
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
            className="h-12 text-base"
            autoFocus
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
            >
              <Plus className="h-6 w-6" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Notes + submit */}
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
    </div>
  );
}
