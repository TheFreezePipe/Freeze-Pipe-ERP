import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  useInventoryTransactions,
  useAuditLogs,
  useProfiles,
  type AuditLogEntry,
  type ChangeLogFilters,
  type InventoryTransactionWithDetails,
} from "@/lib/hooks";
import { useState, useMemo, useEffect } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Info,
  Activity,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 10;

/**
 * The Change Log unifies two data sources:
 *   1. inventory_transactions — finance/inventory-domain events (cycle counts,
 *      freight status changes, SKU toggles). Legacy; most events land here.
 *   2. audit_logs            — workflow events emitted by SECURITY DEFINER
 *      RPCs (supplier factory order create/advance/cancel, freight shipment
 *      create/update, breakage + variance acknowledgements, etc.). New home
 *      for most supplier-originated activity.
 *
 * Both are interleaved by created_at so the admin sees a real activity
 * feed — not just the inventory slice. Without the audit_logs source,
 * supplier actions (e.g. Nancy canceling an order) are completely
 * invisible to Chase on this page.
 */

const TYPE_COLORS: Record<string, string> = {
  // inventory_transactions.transaction_type values
  cycle_count: "border-purple-500 text-purple-400",
  task_logged: "border-green-500 text-green-400",
  freight_status_change: "border-yellow-500 text-yellow-400",
  freight_status_override: "border-amber-500 text-amber-400",
  freight_status_override_cleared: "border-muted text-muted-foreground",
  freight_delivered: "border-blue-500 text-blue-400",
  order_shipped: "border-cyan-500 text-cyan-400",
  factory_order_update: "border-orange-500 text-orange-400",
  tracking_eta_update: "border-sky-500 text-sky-400",
  tracking_status_auto: "border-cyan-500 text-cyan-400",
  sku_active_toggle: "border-rose-500 text-rose-400",
  sku_demand_override: "border-indigo-500 text-indigo-400",
  // audit_logs.action values — supplier portal workflow actions
  "factory_order.create": "border-emerald-500 text-emerald-400",
  "factory_order.advance": "border-amber-500 text-amber-400",
  "factory_order.cancel": "border-red-500 text-red-400",
  "factory_order.update_finished": "border-amber-500 text-amber-400",
  "freight_shipment.create": "border-emerald-500 text-emerald-400",
  "freight_shipment.update_tracking": "border-sky-500 text-sky-400",
  "breakage_report.create": "border-red-500 text-red-400",
  "breakage_report.acknowledge": "border-muted text-muted-foreground",
  "shipment_variance.acknowledge": "border-muted text-muted-foreground",
};

/** Unified row shape. Both inventory + audit entries normalize into this. */
interface TimelineEntry {
  source: "inventory" | "audit";
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_name: string;
  /** transaction_type (inventory) or action (audit) — used for color + filter. */
  type: string;
  /** Raw row kept around so the Change cell can render source-specific details. */
  inventory?: InventoryTransactionWithDetails;
  audit?: AuditLogEntry;
}

export default function ChangeLog() {
  const { data: profiles = [] } = useProfiles();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "inventory" | "audit">("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [page, setPage] = useState(0);

  // Debounce free-text search so each keystroke doesn't fire a query.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Date / type / user / search are pushed to the DB so the feed searches
  // the FULL history, not just a recent client-side window. sourceFilter
  // stays client-side — it only hides one of the two merged streams.
  const filters: ChangeLogFilters = useMemo(
    () => ({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      type: typeFilter !== "all" ? typeFilter : undefined,
      userId: userFilter !== "all" ? userFilter : undefined,
      search: debouncedSearch || undefined,
      limit: 500,
    }),
    [dateFrom, dateTo, typeFilter, userFilter, debouncedSearch],
  );

  const { data: inventoryTxns = [], isLoading: invLoading } =
    useInventoryTransactions(filters);
  const { data: auditLogs = [], isLoading: auditLoading } = useAuditLogs(filters);

  function profileName(id: string | null): string {
    if (!id) return "System";
    const p = profiles.find((u) => u.id === id);
    return p?.full_name ?? "Unknown";
  }

  // Normalize both sources into the unified TimelineEntry shape, then
  // interleave by timestamp descending.
  const entries = useMemo<TimelineEntry[]>(() => {
    const invEntries: TimelineEntry[] = inventoryTxns.map((t) => ({
      source: "inventory" as const,
      id: `inv-${t.id}`,
      created_at: t.created_at,
      actor_id: t.performed_by,
      actor_name:
        t.performed_by === null
          ? "System"
          : (t.performed_by_profile?.full_name ?? profileName(t.performed_by)),
      type: t.transaction_type,
      inventory: t,
    }));
    const auditEntries: TimelineEntry[] = auditLogs.map((a) => ({
      source: "audit" as const,
      id: `audit-${a.id}`,
      created_at: a.created_at,
      actor_id: a.actor_id,
      actor_name:
        a.actor_id === null
          ? "System"
          : (a.actor_profile?.full_name ?? profileName(a.actor_id)),
      type: a.action,
      audit: a,
    }));
    return [...invEntries, ...auditEntries].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }, [inventoryTxns, auditLogs, profiles]);

  // Stable type list for the dropdown: every known type plus anything
  // present in the current result. Derived from TYPE_COLORS so the options
  // don't collapse to just the selected type once a filter is applied
  // (the data is now fetched pre-filtered from the server).
  const allTypes = useMemo(() => {
    const set = new Set<string>(Object.keys(TYPE_COLORS));
    for (const e of entries) set.add(e.type);
    return Array.from(set).sort();
  }, [entries]);

  // Date / type / user / search are applied server-side in the hooks, so the
  // only remaining client-side filter is the source toggle (which stream to
  // show). Everything else already arrives filtered from the database.
  const filtered = useMemo(() => {
    if (sourceFilter === "all") return entries;
    return entries.filter((e) => e.source === sourceFilter);
  }, [entries, sourceFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasFilters =
    !!search ||
    typeFilter !== "all" ||
    sourceFilter !== "all" ||
    userFilter !== "all" ||
    !!dateFrom ||
    !!dateTo;

  function resetFilters() {
    setSearch("");
    setTypeFilter("all");
    setSourceFilter("all");
    setUserFilter("all");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

  function onFilterChange<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(0);
  }

  if (invLoading || auditLoading) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      {/* Primary: search + source + type */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by SKU, type, notes, reference, or target id…"
            value={search}
            onChange={(e) => onFilterChange(setSearch, e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={sourceFilter}
          onValueChange={(v) => onFilterChange(setSourceFilter, v as typeof sourceFilter)}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="inventory">Inventory</SelectItem>
            <SelectItem value="audit">Workflow</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => onFilterChange(setTypeFilter, v)}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {allTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.replace(/[_.]/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Secondary: user + date range */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="user-filter" className="text-xs text-muted-foreground">
            User
          </Label>
          <Select
            value={userFilter}
            onValueChange={(v) => onFilterChange(setUserFilter, v)}
          >
            <SelectTrigger id="user-filter" className="h-9 w-[180px] text-xs">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              <SelectItem value="system">System (automated)</SelectItem>
              {profiles.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => onFilterChange(setDateFrom, e.target.value)}
            className="h-9 w-[150px] text-xs"
            max={dateTo || undefined}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="date-to"
            type="date"
            value={dateTo}
            onChange={(e) => onFilterChange(setDateTo, e.target.value)}
            className="h-9 w-[150px] text-xs"
            min={dateFrom || undefined}
          />
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs text-muted-foreground"
            onClick={resetFilters}
          >
            <X className="mr-1 h-3 w-3" />
            Clear all
          </Button>
        )}

        <div className="ml-auto text-xs text-muted-foreground pb-1.5">
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Target</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((entry) => {
                const colorClass =
                  TYPE_COLORS[entry.type] ?? "border-muted text-muted-foreground";
                return (
                  <tr key={entry.id} className="border-b border-border/50">
                    <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                      {format(parseISO(entry.created_at), "MMM d, yyyy h:mm a")}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {entry.actor_id === null ? (
                        <span className="text-muted-foreground/60 italic">System</span>
                      ) : (
                        <span>{entry.actor_name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={`text-[10px] ${colorClass}`}>
                        {entry.type.replace(/[_.]/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs font-medium">
                      <TargetCell entry={entry} />
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <DetailsCell entry={entry} />
                    </td>
                  </tr>
                );
              })}
              {paged.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    {entries.length === 0
                      ? "No change log entries yet"
                      : "No entries match the current filters"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground px-1">
        <div className="flex items-center gap-1.5">
          <ArrowUpRight className="h-3 w-3 text-green-400" />
          <span>Inventory increase</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ArrowDownRight className="h-3 w-3 text-red-400" />
          <span>Inventory decrease</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-muted-foreground" />
          <span>Workflow action</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Info className="h-3 w-3 text-muted-foreground" />
          <span>Metadata only</span>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TargetCell — what the event was about. For inventory rows that's the SKU;
// for audit rows it's the target table + a shortened id (factory_orders /
// 1a2b3c4d…).
// ---------------------------------------------------------------------------
function TargetCell({ entry }: { entry: TimelineEntry }) {
  if (entry.inventory) {
    return (
      <>
        {entry.inventory.product?.sku ?? (
          <span className="text-muted-foreground/60">—</span>
        )}
      </>
    );
  }
  if (entry.audit) {
    const a = entry.audit;
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground/80 text-[10px] uppercase tracking-wider">
          {a.target_table}
        </span>
        <span className="font-mono text-[11px]" title={a.target_id}>
          {a.target_id.slice(0, 8)}…
        </span>
      </div>
    );
  }
  return <span className="text-muted-foreground/60">—</span>;
}

// ---------------------------------------------------------------------------
// DetailsCell — per-row description of what changed.
//   inventory row: quantity arrow + field_affected + notes
//   audit row:     compact list of key details, with human-friendly keys
//                  for the common actions (cancel reason, status transitions)
// ---------------------------------------------------------------------------
function DetailsCell({ entry }: { entry: TimelineEntry }) {
  if (entry.inventory) {
    const t = entry.inventory;
    return (
      <div className="space-y-0.5">
        {t.quantity !== 0 ? (
          <div className="flex items-center gap-1.5">
            {t.quantity > 0 ? (
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-green-400" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-red-400" />
            )}
            <span
              className={cn(
                "tabular-nums font-semibold",
                t.quantity > 0 ? "text-green-400" : "text-red-400",
              )}
            >
              {t.quantity > 0 ? "+" : ""}
              {t.quantity.toLocaleString()}
            </span>
            <span className="text-muted-foreground/80">
              {t.field_affected.replace(/_/g, " ")}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 italic">
            <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <span className="text-muted-foreground">
              {t.field_affected.replace(/_/g, " ")}
            </span>
          </div>
        )}
        {t.notes && <div className="text-muted-foreground/80 truncate max-w-[340px]">{t.notes}</div>}
      </div>
    );
  }

  if (entry.audit) {
    return <AuditSummary audit={entry.audit} />;
  }

  return <span className="text-muted-foreground/60">—</span>;
}

// ---------------------------------------------------------------------------
// AuditSummary — action-aware compact summary. For the actions we see the
// most (cancel, advance, create), surface the most useful details inline.
// For anything else, fall back to a pretty-printed key: value list capped at
// ~3 keys so the row stays one-line-ish.
// ---------------------------------------------------------------------------
function AuditSummary({ audit }: { audit: AuditLogEntry }) {
  const details = audit.details ?? {};

  // Action-specific renderers
  if (audit.action === "factory_order.cancel") {
    const fromStatus = details.from_status as string | undefined;
    const reason = details.reason as string | null | undefined;
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 shrink-0 text-red-400" />
          <span className="text-red-400 font-medium">Canceled</span>
          {fromStatus && (
            <span className="text-muted-foreground/80">
              from <span className="font-mono">{fromStatus.replace(/_/g, " ")}</span>
            </span>
          )}
        </div>
        {reason && <div className="text-muted-foreground/80 truncate max-w-[340px]">{reason}</div>}
      </div>
    );
  }

  if (audit.action === "factory_order.advance") {
    const prev = details.prev_status as string | undefined;
    const next = details.new_status as string | undefined;
    return (
      <div className="flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {prev ?? "?"} → {next ?? "?"}
        </span>
      </div>
    );
  }

  if (audit.action === "freight_shipment.update_tracking") {
    const promoted = details.auto_promoted as boolean | undefined;
    const newStatus = details.new_status as string | undefined;
    const tracking = details.new_tracking_number_requested as string | null | undefined;
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          {promoted ? (
            <span className="text-sky-400 font-medium">
              Auto-promoted → {newStatus}
            </span>
          ) : (
            <span className="text-muted-foreground">Tracking updated</span>
          )}
        </div>
        {tracking && (
          <div className="font-mono text-[11px] text-muted-foreground truncate max-w-[340px]">
            {tracking}
          </div>
        )}
      </div>
    );
  }

  // Generic fallback — show up to 3 detail keys
  const keys = Object.keys(details).slice(0, 3);
  if (keys.length === 0) {
    return (
      <div className="flex items-center gap-1.5 italic">
        <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="text-muted-foreground">workflow event</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="text-muted-foreground truncate max-w-[340px]">
        {keys
          .map((k) => {
            const v = details[k];
            const rendered =
              typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                ? String(v)
                : JSON.stringify(v);
            return `${k.replace(/_/g, " ")}: ${rendered}`;
          })
          .join(" · ")}
      </span>
    </div>
  );
}
