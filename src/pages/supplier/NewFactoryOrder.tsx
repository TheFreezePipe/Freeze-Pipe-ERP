import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateSupplierFactoryOrder } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/** Minimal SKU picker — uses the supplier-portal view for column projection. */
function useVisibleSKUs() {
  return useQuery({
    queryKey: ["supplier", "skus"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("id, sku, product_name, category")
        .eq("is_active", true)
        .order("sku");
      if (error) throw error;
      return data as Array<{ id: string; sku: string; product_name: string; category: string }>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface LineDraft {
  id: string; // local
  skuId: string | null;
  quantity: number;
  /** Empty string = inherit order ETA. */
  alternateEta: string;
}

function newLine(): LineDraft {
  return { id: crypto.randomUUID(), skuId: null, quantity: 0, alternateEta: "" };
}

export default function NewFactoryOrder() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const skus = useVisibleSKUs();
  const create = useCreateSupplierFactoryOrder();

  const [orderNumber, setOrderNumber] = useState("");
  const [expectedCompletion, setExpectedCompletion] = useState(
    () => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  // Idempotency key is stable per form load. If the user refreshes to retry,
  // they get a new key (intended — a refresh is a new intent).
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // Validation UX: keep the submit button clickable; when the user tries
  // to submit with missing required fields, flip this flag on so the
  // relevant fields render in red until they're fixed.
  const [triedSubmit, setTriedSubmit] = useState(false);

  // Required fields. Order number stays OPTIONAL per user call — we just
  // expose the input. If requirements change, add it to this block.
  const errors = {
    orderNumber: false, // optional; always valid
    expectedCompletion: expectedCompletion.length !== 10,
    // A line is invalid if it has a SKU without qty, qty without SKU, or neither.
    lines: lines.map((l) => ({
      sku: !l.skuId,
      qty: !l.quantity || l.quantity <= 0,
    })),
    noLines: lines.length === 0,
  };
  const valid =
    !errors.expectedCompletion &&
    !errors.noLines &&
    errors.lines.every((e) => !e.sku && !e.qty);

  async function onSubmit() {
    if (!valid) {
      setTriedSubmit(true);
      return;
    }
    setTriedSubmit(false);
    try {
      const res = await create.mutateAsync({
        idempotencyKey,
        orderNumber: orderNumber.trim() || null,
        expectedCompletion,
        notes: notes.trim() || null,
        items: lines.map((l) => ({
          skuId: l.skuId!,
          quantity: l.quantity,
          alternateExpectedCompletion: l.alternateEta.trim() || null,
        })),
      });
      toast({
        title: res.replayed ? "Order already existed" : "Order created",
        description: `Order id ${res.factory_order_id}`,
      });
      navigate(`/supplier/orders/${res.factory_order_id}`);
    } catch (err) {
      // Surface everything we know about the failure so diagnosing doesn't
      // require the Network tab. PostgREST errors are plain objects; pull
      // message/details/hint/code off of them.
      let description = "Unknown error";
      if (err instanceof Error) {
        description = err.message;
      } else if (err && typeof err === "object") {
        const e = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
        const parts: string[] = [];
        if (typeof e.code === "string") parts.push(`[${e.code}]`);
        if (typeof e.message === "string" && e.message) parts.push(e.message);
        if (typeof e.details === "string" && e.details) parts.push(e.details);
        if (typeof e.hint === "string" && e.hint) parts.push(`(${e.hint})`);
        if (parts.length) description = parts.join(" ");
      }
      // eslint-disable-next-line no-console
      console.error("[NewFactoryOrder] create failed:", err);
      toast({
        title: "Could not create order",
        description,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New Factory Order</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Declare a new production run. Status starts as <code className="text-xs">ordered</code> and
          you'll advance it to <code className="text-xs">in_production</code> → <code className="text-xs">finished</code> as work progresses.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Header</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="order-number">Order number (optional)</Label>
              <Input
                id="order-number"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="e.g. NAN-2026-043"
              />
            </div>
            <div>
              <Label htmlFor="expected">Expected completion</Label>
              <Input
                id="expected"
                type="date"
                value={expectedCompletion}
                onChange={(e) => setExpectedCompletion(e.target.value)}
                className={
                  triedSubmit && errors.expectedCompletion
                    ? "border-red-500 focus-visible:ring-red-500"
                    : undefined
                }
              />
            </div>
          </div>
          <div>
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              placeholder="Anything the consolidator / receiver should know…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Line items</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, newLine()])}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((l, idx) => {
            const lineErr = errors.lines[idx] ?? { sku: false, qty: false };
            const redRing = "border-red-500 focus-visible:ring-red-500";
            return (
            <div key={l.id} className="grid grid-cols-[1fr_100px_160px_auto] gap-2 items-end">
              <div>
                <Label className={idx === 0 ? "" : "sr-only"}>SKU</Label>
                <Select
                  value={l.skuId ?? ""}
                  onValueChange={(v) => setLines((ls) => ls.map((x) => x.id === l.id ? { ...x, skuId: v } : x))}
                >
                  <SelectTrigger
                    className={triedSubmit && lineErr.sku ? redRing : undefined}
                  >
                    <SelectValue placeholder={skus.isLoading ? "Loading…" : "Select a SKU"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(skus.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="font-mono text-xs">{s.sku}</span>
                        <span className="ml-2 text-muted-foreground">{s.product_name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className={idx === 0 ? "" : "sr-only"}>Quantity</Label>
                <Input
                  type="number"
                  min={1}
                  value={l.quantity || ""}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => x.id === l.id ? { ...x, quantity: parseInt(e.target.value || "0", 10) } : x))
                  }
                  className={triedSubmit && lineErr.qty ? redRing : undefined}
                />
              </div>
              <div>
                <Label
                  className={idx === 0 ? "" : "sr-only"}
                  title="Leave empty to inherit the order's expected completion date."
                >
                  Alt ETA (optional)
                </Label>
                <Input
                  type="date"
                  min={new Date().toISOString().slice(0, 10)}
                  value={l.alternateEta}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => x.id === l.id ? { ...x, alternateEta: e.target.value } : x))
                  }
                  placeholder={expectedCompletion}
                  title={
                    l.alternateEta
                      ? "Per-item override"
                      : `Inheriting order ETA${expectedCompletion ? ` (${expectedCompletion})` : ""}`
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}
                title="Remove line"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            );
          })}
        </CardContent>
      </Card>

      {triedSubmit && !valid && (
        <p className="text-xs text-red-400">
          Fill in the highlighted fields to continue.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/supplier/orders")}>Cancel</Button>
        <Button
          onClick={onSubmit}
          disabled={create.isPending}
          className={!valid ? "opacity-60" : undefined}
        >
          {create.isPending ? "Creating…" : "Create Order"}
        </Button>
      </div>
    </div>
  );
}
