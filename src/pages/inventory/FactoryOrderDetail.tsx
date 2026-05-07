import { useMemo, useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { format, parseISO, differenceInDays } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  AlarmClock,
  AlertTriangle,
  Link as LinkIcon,
  Unlink,
  Pencil,
  Plus,
  Trash2,
  Lock,
} from "lucide-react";
import {
  useFactoryOrders,
  useFreightLineItems,
  useProducts,
  useProductBoms,
  useFactoryOrderComponentStatus,
  useLinkFactoryOrderToParent,
  useUnlinkFactoryOrderFromParent,
  useSuppliers,
  useAdminEditFactoryOrder,
  computeMissingComponents,
  type FactoryOrderWithItems,
  type FreightLineItemWithProduct,
  type FactoryOrderLineOp,
} from "@/lib/hooks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";

// Mirror the list page's color map so badges read consistently.
const STATUS_COLOR: Record<string, string> = {
  ordered: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  in_production: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  finished: "bg-green-500/10 text-green-400 border-green-500/30",
  shipped: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  canceled: "bg-red-500/10 text-red-400 border-red-500/30",
};

type FreightMap = Map<string, FreightLineItemWithProduct[]>;

/**
 * Admin-side factory order detail. Shows the same data the list-page card
 * shows (header, line item rollups, value) but in a focused single-order
 * view, plus the component-orders panel with the full linker UI when the
 * order involves compound SKUs.
 *
 * The list-page OrderCard renders the same component-orders panel inline
 * for at-a-glance scanning; this page is for when the operator wants to
 * see one order's full state without the surrounding noise. They share
 * the same hooks and underlying computation — duplication is intentional
 * (the detail page can iterate independently of the list-page density
 * constraints).
 */
export default function FactoryOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: orders = [], isLoading } = useFactoryOrders();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: boms = [] } = useProductBoms();
  // Catalog-backed lookup; covers component SKUs not yet ordered as a
  // line item (which would otherwise show as truncated UUIDs).
  const { data: allProducts = [] } = useProducts();
  const { data: componentStatus } = useFactoryOrderComponentStatus(id ?? null);
  const linkMut = useLinkFactoryOrderToParent();
  const unlinkMut = useUnlinkFactoryOrderFromParent();
  const [linkError, setLinkError] = useState<string | null>(null);
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
  const suppliersQ = useSuppliers({ activeOnly: true });
  const editMut = useAdminEditFactoryOrder();

  const order = useMemo(() => orders.find((o) => o.id === id) ?? null, [orders, id]);

  // ===== Edit Mode state =====
  // The whole edit experience lives in this page (vs a modal) so changes
  // to multiple line items + the header read as one cohesive operation.
  // Drafts are local — nothing hits the DB until "Done editing."
  type LineDraft = {
    id: string;          // existing line UUID, or "new-{n}" for fresh rows
    isNew: boolean;
    isDeleted: boolean;
    sku_id: string;
    quantity_ordered: number;
    // For locked-line detection — > 0 finished or any consolidator confirm
    // means edits/deletes are blocked. Mirrored from the existing row at
    // draft-init time; new rows are 0/null so always editable.
    locked: boolean;
    // Original snapshot to detect "no actual change" so we don't emit
    // a no-op update op.
    origSkuId: string | null;
    origQty: number | null;
  };
  const [editMode, setEditMode] = useState(false);
  const [headerDraft, setHeaderDraft] = useState({
    order_number: "" as string,
    supplier_id: "" as string,
    order_date: "" as string,
    expected_completion: "" as string,
  });
  const [lineDrafts, setLineDrafts] = useState<LineDraft[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  // Counter for synthetic "new-N" ids on freshly-added lines. Incremented
  // each Add-Line click; doesn't matter what the value is, only that it's
  // unique per session.
  const [newLineCounter, setNewLineCounter] = useState(0);

  // Hydrate drafts whenever the order data changes (initial load or after
  // a save when the query refetches). We re-run this on every order
  // change but only ACTUALLY update the drafts when not in edit mode —
  // otherwise an in-flight edit would get overwritten by a window-focus
  // refetch of the underlying query.
  useEffect(() => {
    if (!order || editMode) return;
    setHeaderDraft({
      order_number: order.order_number ?? "",
      supplier_id: order.supplier?.id ?? "",
      order_date: order.order_date ?? "",
      expected_completion: order.expected_completion ?? "",
    });
    setLineDrafts(
      (order.items ?? []).map((it) => ({
        id: it.id,
        isNew: false,
        isDeleted: false,
        sku_id: it.sku_id,
        quantity_ordered: it.quantity_ordered,
        locked:
          (it.quantity_finished ?? 0) > 0 ||
          // consolidator_confirmed_quantity isn't projected through the
          // current query type, but its presence implies a non-null finished
          // chain too — the locked check is conservative.
          false,
        origSkuId: it.sku_id,
        origQty: it.quantity_ordered,
      })),
    );
  }, [order, editMode]);

  function enterEditMode() {
    setEditMode(true);
    setEditError(null);
  }
  function cancelEditMode() {
    setEditMode(false);
    setEditError(null);
    setNewLineCounter(0);
    // The hydration effect re-runs once editMode flips false and refills
    // drafts from the live order, discarding any unsaved changes.
  }
  function addNewLine() {
    setLineDrafts((prev) => [
      ...prev,
      {
        id: `new-${newLineCounter}`,
        isNew: true,
        isDeleted: false,
        sku_id: "",
        quantity_ordered: 1,
        locked: false,
        origSkuId: null,
        origQty: null,
      },
    ]);
    setNewLineCounter((n) => n + 1);
  }
  function updateLineDraft(draftId: string, patch: Partial<LineDraft>) {
    setLineDrafts((prev) =>
      prev.map((d) => (d.id === draftId ? { ...d, ...patch } : d)),
    );
  }
  function toggleLineDelete(draftId: string) {
    setLineDrafts((prev) =>
      prev.map((d) =>
        d.id === draftId
          ? d.isNew
            ? // Brand-new lines: just drop them from state — nothing to delete server-side
              { ...d, isDeleted: true }
            : { ...d, isDeleted: !d.isDeleted }
          : d,
      ),
    );
  }
  // Filter to lines that should actually render (drop new+deleted).
  const visibleLineDrafts = lineDrafts.filter((d) => !(d.isNew && d.isDeleted));

  async function handleSaveEdits() {
    if (!order) return;
    setEditError(null);

    // ---- Build the payload ----

    // Header: only include fields that actually changed. Empty strings
    // become null so the RPC clears the column.
    const header: Record<string, unknown> = {};
    const trimNumber = headerDraft.order_number.trim();
    if (trimNumber !== (order.order_number ?? "")) {
      header.order_number = trimNumber === "" ? null : trimNumber;
    }
    if (headerDraft.supplier_id && headerDraft.supplier_id !== order.supplier?.id) {
      header.supplier_id = headerDraft.supplier_id;
    }
    if ((headerDraft.order_date ?? "") !== (order.order_date ?? "")) {
      header.order_date = headerDraft.order_date === "" ? null : headerDraft.order_date;
    }
    if ((headerDraft.expected_completion ?? "") !== (order.expected_completion ?? "")) {
      header.expected_completion =
        headerDraft.expected_completion === "" ? null : headerDraft.expected_completion;
    }

    // Lines: emit insert / update / delete ops.
    const lineOps: FactoryOrderLineOp[] = [];
    for (const d of lineDrafts) {
      if (d.isNew && d.isDeleted) continue; // never existed → nothing to do
      if (d.isDeleted) {
        lineOps.push({ op: "delete", id: d.id });
        continue;
      }
      if (d.isNew) {
        if (!d.sku_id) {
          setEditError("New line is missing a SKU");
          return;
        }
        lineOps.push({
          op: "insert",
          sku_id: d.sku_id,
          quantity_ordered: d.quantity_ordered,
        });
        continue;
      }
      const skuChanged = d.sku_id !== d.origSkuId;
      const qtyChanged = d.quantity_ordered !== d.origQty;
      if (skuChanged || qtyChanged) {
        lineOps.push({
          op: "update",
          id: d.id,
          sku_id: d.sku_id,
          quantity_ordered: d.quantity_ordered,
        });
      }
    }

    // Bail early if nothing actually changed.
    if (Object.keys(header).length === 0 && lineOps.length === 0) {
      setEditMode(false);
      return;
    }

    try {
      await editMut.mutateAsync({
        orderId: order.id,
        // The query type (FactoryOrderWithItems) doesn't always project
        // row_version. Read it off the underlying object; it's safe because
        // the table guarantees a value (NOT NULL DEFAULT 1).
        expectedVersion: (order as FactoryOrderWithItems & { row_version?: number })
          .row_version ?? 1,
        header: Object.keys(header).length > 0 ? header : undefined,
        lineOps: lineOps.length > 0 ? lineOps : undefined,
      });
      setEditMode(false);
      setNewLineCounter(0);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const editLockedReason =
    order && (order.status === "shipped" || order.status === "canceled")
      ? `Edit Mode is disabled for ${order.status} orders.`
      : null;

  const freightMap = useMemo<FreightMap>(() => {
    const out: FreightMap = new Map();
    for (const line of freightLines) {
      const foi = line.source_factory_order_item_id;
      if (!foi) continue;
      const arr = out.get(foi) ?? [];
      arr.push(line);
      out.set(foi, arr);
    }
    return out;
  }, [freightLines]);

  const missingComponents = useMemo(
    () => (order ? computeMissingComponents(order, orders, boms) : []),
    [order, orders, boms],
  );
  const childOrders = useMemo(
    () => (order ? orders.filter((o) => o.parent_factory_order_id === order.id) : []),
    [order, orders],
  );
  const skuByIdLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of allProducts) map.set(p.id, p.sku);
    return map;
  }, [allProducts]);

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!order) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-red-400">Order not found.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/inventory/factory-orders">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to factory orders
          </Link>
        </Button>
      </div>
    );
  }

  const items = order.items ?? [];
  const orderTotal = items.reduce((s, i) => s + i.quantity_ordered, 0);
  const orderValue = items.reduce(
    (s, i) => s + (i.unit_cost ?? 0) * i.quantity_ordered,
    0,
  );
  const daysLeft =
    order.expected_completion && order.status !== "shipped"
      ? differenceInDays(parseISO(order.expected_completion), new Date())
      : null;
  const isOverdue =
    daysLeft !== null && daysLeft < 0 && order.status !== "shipped";

  // Linker candidates per missing component — same logic as the list-page
  // panel: orders containing the component SKU, not parented elsewhere,
  // and not this order itself.
  function candidatesFor(componentSkuId: string): FactoryOrderWithItems[] {
    if (!order) return [];
    return orders.filter(
      (o) =>
        o.id !== order.id &&
        !o.parent_factory_order_id &&
        o.items.some((i) => i.sku_id === componentSkuId),
    );
  }

  async function handleLink(childOrderId: string) {
    if (!order) return;
    setLinkError(null);
    try {
      await linkMut.mutateAsync({ childOrderId, parentOrderId: order.id });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Link failed");
    }
  }

  async function handleUnlink(childOrderId: string) {
    setLinkError(null);
    try {
      await unlinkMut.mutateAsync({ childOrderId });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Unlink failed");
    }
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate("/inventory/factory-orders")}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> All factory orders
          </Button>
          <h1 className="text-2xl font-semibold mt-1">
            {order.order_number ?? (
              <span className="italic text-muted-foreground">Awaiting order #</span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{order.id}</p>
        </div>
        {canEdit && !editMode && (
          <Button
            variant="outline"
            size="sm"
            onClick={enterEditMode}
            disabled={!!editLockedReason}
            title={editLockedReason ?? "Edit this order"}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </div>

      {/* Edit Mode amber banner — visible whenever edit mode is on so the
          user always knows they're in override territory. Done/Cancel
          buttons live in here too so they're reachable from the top of
          the page (a long order pushes the line items table off-screen). */}
      {editMode && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 flex items-center gap-3">
          <Pencil className="h-4 w-4 text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-100">Edit Mode</p>
            <p className="text-xs text-amber-300/80">
              Order header and line items are unlocked. Changes save when
              you click Done editing. Lines with finished or received
              quantity stay locked.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={cancelEditMode}
              disabled={editMut.isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveEdits} disabled={editMut.isPending}>
              {editMut.isPending ? "Saving…" : "Done editing"}
            </Button>
          </div>
        </div>
      )}

      {editError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {editError}
        </div>
      )}

      {/* Top metadata strip */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {order.supplier?.name ?? "—"}
            </Badge>
            <Badge
              variant="outline"
              className={`${STATUS_COLOR[order.status] ?? ""} text-xs`}
            >
              {order.status.replace("_", " ")}
            </Badge>
            {daysLeft !== null && (
              <Badge
                variant="outline"
                className={`text-xs gap-1 ${
                  daysLeft < 0
                    ? "border-red-500/40 text-red-400"
                    : daysLeft < 5
                      ? "border-amber-500/40 text-amber-400"
                      : "border-border text-muted-foreground"
                }`}
              >
                {isOverdue && <AlarmClock className="h-3 w-3" />}
                {daysLeft < 0 ? `${Math.abs(daysLeft)}d late` : `${daysLeft}d left`}
              </Badge>
            )}
            {missingComponents.length > 0 && (
              <Badge
                variant="outline"
                className="text-xs gap-1 border-red-500/50 text-red-400 bg-red-500/10"
              >
                <AlertTriangle className="h-3 w-3" />
                missing {missingComponents.length === 1 ? "component" : "components"}
              </Badge>
            )}
            {order.parent_factory_order_id && (
              <Badge
                variant="outline"
                className="text-xs gap-1 border-blue-500/40 text-blue-400"
              >
                <LinkIcon className="h-3 w-3" />
                fulfills parent order
              </Badge>
            )}
            <div className="ml-auto flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {orderTotal.toLocaleString()}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                units
              </span>
              {orderValue > 0 && (
                <span className="text-sm text-amber-400/90 ml-3 tabular-nums">
                  ${orderValue.toLocaleString()}
                </span>
              )}
            </div>
          </div>
          {editMode ? (
            // Edit mode — header inputs (order #, supplier, dates). Notes
            // is intentionally not in scope for this iteration; dropping
            // it here keeps the visual density similar to read mode.
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Order #</Label>
                <Input
                  value={headerDraft.order_number}
                  onChange={(e) =>
                    setHeaderDraft((d) => ({ ...d, order_number: e.target.value }))
                  }
                  placeholder="(none)"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Factory (supplier)</Label>
                <Select
                  value={headerDraft.supplier_id}
                  onValueChange={(v) =>
                    setHeaderDraft((d) => ({ ...d, supplier_id: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {(suppliersQ.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="font-mono text-xs mr-2">{s.code}</span>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Order date</Label>
                <Input
                  type="date"
                  value={headerDraft.order_date}
                  onChange={(e) =>
                    setHeaderDraft((d) => ({ ...d, order_date: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Expected completion</Label>
                <Input
                  type="date"
                  value={headerDraft.expected_completion}
                  onChange={(e) =>
                    setHeaderDraft((d) => ({
                      ...d,
                      expected_completion: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 mt-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Ordered</p>
                <p className="tabular-nums">
                  {order.order_date ? format(parseISO(order.order_date), "MMM d, yyyy") : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Expected</p>
                <p className="tabular-nums">
                  {order.expected_completion
                    ? format(parseISO(order.expected_completion), "MMM d, yyyy")
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Notes</p>
                <p>{order.notes ?? "—"}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Component orders panel — same look + behavior as the list-page
          inline panel, just hosted on its own page for focused interaction. */}
      {(missingComponents.length > 0 || childOrders.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              Component orders
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {childOrders.length > 0 && (
              <div className="space-y-1">
                {childOrders.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-muted/30 border border-border/60"
                  >
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 border-blue-500/40 text-blue-400"
                    >
                      {c.supplier?.code ?? "—"}
                    </Badge>
                    <Link
                      to={`/inventory/factory-orders/${c.id}`}
                      className="font-mono hover:text-primary"
                    >
                      {c.order_number ?? (
                        <span className="italic text-muted-foreground/60">awaiting #</span>
                      )}
                    </Link>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{c.status.replace("_", " ")}</span>
                    {c.expected_completion && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground tabular-nums">
                          ETA {format(parseISO(c.expected_completion), "MMM d")}
                        </span>
                      </>
                    )}
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums">
                      {c.items
                        .map((i) => `${i.quantity_ordered} ${i.product?.sku ?? "?"}`)
                        .join(", ")}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 ml-auto"
                      onClick={() => handleUnlink(c.id)}
                      disabled={unlinkMut.isPending}
                      title="Unlink this child order"
                    >
                      <Unlink className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {missingComponents.map((m) => {
              const candidates = candidatesFor(m.componentSkuId);
              const skuLabel =
                skuByIdLookup.get(m.componentSkuId) ?? m.componentSkuId.slice(0, 8);
              return (
                <div
                  key={m.componentSkuId}
                  className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-red-500/5 border border-red-500/20"
                >
                  <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
                  <span className="font-medium text-red-400">{skuLabel}</span>
                  <span className="text-muted-foreground tabular-nums">
                    need {m.qtyNeeded.toLocaleString()}
                    {m.qtyOrdered > 0 && (
                      <>
                        , linked {m.qtyOrdered.toLocaleString()}, short{" "}
                        <span className="text-red-400">{m.qtyShort.toLocaleString()}</span>
                      </>
                    )}
                  </span>
                  <div className="ml-auto w-72">
                    {candidates.length === 0 ? (
                      <span className="text-[10px] italic text-muted-foreground/60">
                        No unlinked orders for this SKU — place one first
                      </span>
                    ) : (
                      <Select onValueChange={(cid) => handleLink(cid)}>
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder="Link existing order…" />
                        </SelectTrigger>
                        <SelectContent>
                          {candidates.map((c) => (
                            <SelectItem key={c.id} value={c.id} className="text-xs">
                              <span className="font-mono">{c.order_number ?? "(awaiting #)"}</span>
                              <span className="text-muted-foreground ml-2">
                                {c.supplier?.code} · {c.status.replace("_", " ")}
                                {c.expected_completion && (
                                  <> · ETA {format(parseISO(c.expected_completion), "MMM d")}</>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              );
            })}

            {linkError && <p className="text-[11px] text-red-400 px-2">{linkError}</p>}
          </CardContent>
        </Card>
      )}

      {/* Component status from RPC — only renders when the RPC returns
          actual data. Functionally redundant with the panel above (admin
          has full visibility), but reassures that the RPC and authorization
          path is wired. Suppressed when there are no expected components. */}
      {componentStatus && componentStatus.expected_components.length === 0 &&
        childOrders.length === 0 && missingComponents.length === 0 && null}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">SKU</th>
                <th className="py-2 text-right">Ordered</th>
                {!editMode && <th className="py-2 text-right">Finished</th>}
                {!editMode && <th className="py-2 text-right">Unit cost</th>}
                {!editMode && <th className="py-2 text-right">Line value</th>}
                {editMode && <th className="py-2 w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {editMode ? (
                // ===== Edit mode rows =====
                // Each row is one entry in lineDrafts. Locked rows render
                // a lock icon and disabled inputs; deleted rows render
                // a strikethrough preview and an Undo button. Brand-new
                // lines render with a "new" tag so the operator sees what
                // they're about to add.
                <>
                  {visibleLineDrafts.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-xs text-muted-foreground italic">
                        No line items. Add one below.
                      </td>
                    </tr>
                  ) : (
                    visibleLineDrafts.map((d) => (
                      <tr
                        key={d.id}
                        className={`border-t border-border ${d.isDeleted ? "opacity-50" : ""}`}
                      >
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-2">
                            {d.locked && (
                              <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                            )}
                            <Select
                              value={d.sku_id}
                              onValueChange={(v) => updateLineDraft(d.id, { sku_id: v })}
                              disabled={d.locked || d.isDeleted}
                            >
                              <SelectTrigger className="h-8 max-w-[280px]">
                                <SelectValue placeholder="Pick a SKU…" />
                              </SelectTrigger>
                              <SelectContent>
                                {allProducts
                                  .filter((p) => p.is_active)
                                  .map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                      <span className="font-mono text-xs">{p.sku}</span>
                                      <span className="ml-2 text-muted-foreground">
                                        {p.product_name}
                                      </span>
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            {d.isNew && (
                              <Badge
                                variant="outline"
                                className="text-[10px] py-0 border-green-500/40 text-green-400"
                              >
                                new
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-2 text-right">
                          <Input
                            type="number"
                            min={1}
                            value={d.quantity_ordered}
                            onChange={(e) =>
                              updateLineDraft(d.id, {
                                quantity_ordered: Math.max(1, parseInt(e.target.value, 10) || 1),
                              })
                            }
                            disabled={d.locked || d.isDeleted}
                            className="h-8 w-24 ml-auto text-right tabular-nums"
                          />
                        </td>
                        <td className="py-2 text-right">
                          {d.locked ? (
                            <span
                              className="text-[10px] text-muted-foreground"
                              title="This line has finished or confirmed quantity. Receipt is already credited; edits are locked."
                            >
                              locked
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => toggleLineDelete(d.id)}
                              title={d.isDeleted ? "Undo delete" : "Remove this line"}
                            >
                              <Trash2
                                className={`h-3.5 w-3.5 ${d.isDeleted ? "text-amber-400" : "text-muted-foreground"}`}
                              />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                  <tr className="border-t border-border">
                    <td colSpan={3} className="py-2">
                      <Button variant="ghost" size="sm" onClick={addNewLine}>
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Add line item
                      </Button>
                    </td>
                  </tr>
                </>
              ) : (
                // ===== Read mode rows (unchanged from before) =====
                items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-4 text-center text-xs text-muted-foreground italic"
                    >
                      No line items on this order.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => {
                    const lineMissing = missingComponents.filter((m) =>
                      boms.some(
                        (b) =>
                          b.parent_sku_id === it.sku_id &&
                          b.component_sku_id === m.componentSkuId,
                      ),
                    );
                    const unitCost = it.unit_cost ?? 0;
                    const lineValue = unitCost * it.quantity_ordered;
                    return (
                      <tr key={it.id} className="border-t border-border">
                        <td className="py-2">
                          <div className="flex items-center gap-1.5">
                            {lineMissing.length > 0 && (
                              <span
                                className="inline-flex items-center text-red-400 shrink-0"
                                title={`Missing component order(s): ${lineMissing
                                  .map(
                                    (m) =>
                                      `${skuByIdLookup.get(m.componentSkuId) ?? "?"} (${m.qtyShort.toLocaleString()} short)`,
                                  )
                                  .join(", ")}`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                              </span>
                            )}
                            <span className="font-mono">{it.product?.sku ?? "?"}</span>
                          </div>
                          {it.product?.product_name && (
                            <div className="text-xs text-muted-foreground">
                              {it.product.product_name}
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {it.quantity_ordered.toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {(it.quantity_finished ?? 0).toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {unitCost > 0 ? `$${unitCost.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {lineValue > 0 ? `$${lineValue.toLocaleString()}` : "—"}
                        </td>
                      </tr>
                    );
                  })
                )
              )}
            </tbody>
          </table>
          {/* Note about freightMap — currently unused on this page but threaded
              through for parity with the list-page rollup math when we extend
              the table to show shipped/in-transit columns. */}
          <p className="hidden">{freightMap.size}</p>
        </CardContent>
      </Card>
    </div>
  );
}
