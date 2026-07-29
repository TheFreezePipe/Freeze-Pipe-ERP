import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Link as LinkIcon } from "lucide-react";
import type { FactoryOrderWithItems, ProductBomRow } from "@/lib/hooks";

/**
 * Link-preview confirmation dialog (ALLOCATED terminology, owner decision
 * 2026-07-27). Opened when the admin picks a parent for a child order in
 * the FactoryOrders linker — BEFORE the link mutation runs — so the
 * operator sees exactly which component units the parent will claim:
 *
 *   per child line: parent needs N (BOM units_per_parent × parent line
 *   qty, summed across parent lines), child carries M
 *     → min(N, M) allocated  +  M − min(N, M) free
 *     → if N > M, a red "{N−M} short" chip + warning (shortfall needs
 *       another order)
 *   lines with no BOM relation to the parent ride along untouched.
 *
 * The math mirrors buildPlannedAllocationMap exactly — what this preview
 * shows is precisely what the on-order surfaces will reserve at link time.
 * Confirm runs the caller's existing link mutation unchanged; Cancel aborts.
 */

interface PreviewLine {
  skuLabel: string;
  /** Units the parent's BOM requires of this component. */
  needed: number;
  /** Units this child order carries. */
  has: number;
  allocated: number;
  free: number;
  short: number;
  /** No BOM relation to any parent line — untouched by the link. */
  ridesAlong: boolean;
}

function orderLabel(o: FactoryOrderWithItems): string {
  return o.order_number ?? (o.supplier?.code ? `${o.supplier.code} order (awaiting #)` : "(awaiting #)");
}

export function LinkOrderDialog({
  open,
  onOpenChange,
  child,
  parent,
  boms,
  skuByIdLookup,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Child order about to be linked; null while no pick is pending. */
  child: FactoryOrderWithItems | null;
  parent: FactoryOrderWithItems;
  boms: ProductBomRow[];
  skuByIdLookup: Map<string, string>;
  onConfirm: (childOrderId: string) => void;
  isPending: boolean;
}) {
  const lines = useMemo<PreviewLine[]>(() => {
    if (!child) return [];
    return (child.items ?? []).map((item) => {
      // Same formula as buildPlannedAllocationMap: need = Σ over parent
      // lines with a BOM to this component of units_per_parent × qty.
      const rows = boms.filter((b) => b.component_sku_id === item.sku_id);
      let needed = 0;
      for (const parentItem of parent.items ?? []) {
        for (const b of rows) {
          if (b.parent_sku_id === parentItem.sku_id) {
            needed += b.units_per_parent * (parentItem.quantity_ordered ?? 0);
          }
        }
      }
      const has = item.quantity_ordered ?? 0;
      const allocated = Math.min(needed, has);
      return {
        skuLabel: item.product?.sku ?? skuByIdLookup.get(item.sku_id) ?? item.sku_id.slice(0, 8),
        needed,
        has,
        allocated,
        free: has - allocated,
        short: Math.max(0, needed - has),
        ridesAlong: needed <= 0,
      };
    });
  }, [child, parent, boms, skuByIdLookup]);

  if (!child) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <LinkIcon className="h-4 w-4 text-blue-400" />
            Link {orderLabel(child)} to {orderLabel(parent)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Linking allocates component units to the parent order at the factory —
            allocated units leave On Order now and never arrive as loose stock.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {lines.map((l) => (
            <div
              key={l.skuLabel}
              className="rounded border border-border/60 bg-muted/20 px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium">{l.skuLabel}</span>
                {l.ridesAlong ? (
                  <span className="text-muted-foreground tabular-nums">
                    {l.has.toLocaleString()} units — rides along untouched
                  </span>
                ) : (
                  <span className="text-muted-foreground tabular-nums">
                    parent needs {l.needed.toLocaleString()} · this order carries{" "}
                    {l.has.toLocaleString()}
                  </span>
                )}
              </div>
              {!l.ridesAlong && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-300">
                    {l.allocated.toLocaleString()} allocated
                  </span>
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${
                      l.free > 0
                        ? "border-green-500/40 bg-green-500/10 text-green-300"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {l.free.toLocaleString()} free
                  </span>
                  {l.short > 0 && (
                    <span className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-red-300">
                      <AlertTriangle className="h-3 w-3" />
                      {l.short.toLocaleString()} short
                    </span>
                  )}
                </div>
              )}
              {l.short > 0 && (
                <p className="mt-1.5 text-[11px] text-red-400">
                  The parent needs more {l.skuLabel} than this order carries — shortfall
                  will need another order.
                </p>
              )}
            </div>
          ))}
          {lines.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              This order has no line items.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onConfirm(child.id)} disabled={isPending}>
            {isPending ? "Linking…" : "Link orders"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
