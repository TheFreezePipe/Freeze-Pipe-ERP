import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { useUrlFilter } from "@/lib/use-url-filter";
import { useWhCreateCount, useWhLocations, useWhSkuIndex, type WhLocationSummary } from "@/lib/hooks";
import {
  COUNT_KIND_WORDS,
  orderCountPath,
  useWhCountTasks,
  type WhCountStatus,
  type WhCountTaskRow,
} from "@/lib/hooks/use-warehouse-counts";
import type { WhCountKind } from "@/lib/hooks/use-warehouse-map";
import { COUNT_STATUS_COLORS, WH_ZONE_COLORS } from "@/lib/status-colors";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { cn } from "@/lib/utils";
import { Chip, TableShell } from "./shared";
import { ago, errorText, TD, TH } from "./format";

type StatusFilter = "live" | WhCountStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "live", label: "All open" },
  { value: "open", label: "Open" },
  { value: "counting", label: "Counting" },
  { value: "submitted", label: "Submitted" },
];

const LIVE: WhCountStatus[] = ["open", "counting", "submitted"];

/**
 * Count tasks (open, counting, submitted) with their due date, kind, reason
 * and assignee, in walk order within each due date; New count by location,
 * rack face or SKU (rpc_wh_create_count, managers and admins). There is no
 * cancel RPC yet, so a task leaves the list by being counted.
 */
export function CountTasksTab({ highlight }: { highlight: string | null }) {
  const [filter, setFilter] = useUrlFilter<StatusFilter>("tstatus", "live");
  const statuses = filter === "live" ? LIVE : [filter as WhCountStatus];
  const { data: tasks = [], isLoading, error } = useWhCountTasks(statuses);
  const { hasRole } = useAuth();
  const canCreate = hasRole("admin", "manager");
  const [creating, setCreating] = useState(false);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);

  const rows = useMemo(() => {
    const byDue = new Map<string, WhCountTaskRow[]>();
    for (const t of tasks) {
      const k = t.due_date ?? "";
      byDue.set(k, [...(byDue.get(k) ?? []), t]);
    }
    return [...byDue.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, list]) => orderCountPath(list));
  }, [tasks]);

  useEffect(() => {
    if (highlight && highlightRef.current) highlightRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, rows.length]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
          <TabsList aria-label="Task status">
            {STATUS_FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New count
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{errorText(error, "Couldn't load the count tasks")}</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No count tasks{filter === "live" ? " open" : ` ${filter}`}. The scheduler opens A/B/C counts each night once the
            physical layer is live; the reconcile opens counts where a SKU is off.
          </CardContent>
        </Card>
      ) : (
        <TableShell minWidth={900}>
          <thead className="border-b border-border/50">
            <tr>
              <th className={TH}>Location</th>
              <th className={TH}>Kind</th>
              <th className={TH}>Reason</th>
              <th className={TH}>Due</th>
              <th className={TH}>Status</th>
              <th className={TH}>Assignee</th>
              <th className={TH}>Opened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const lit = t.id === highlight;
              const late = t.due_date != null && t.due_date < today && t.status !== "submitted";
              return (
                <tr
                  key={t.id}
                  ref={lit ? highlightRef : undefined}
                  className={cn("border-b border-border/40 last:border-0", lit && "bg-primary/10 ring-1 ring-inset ring-primary/50")}
                >
                  <td className={TD}>
                    <div className="flex items-center gap-2">
                      <LocationCode code={t.location?.code ?? "?"} size="small" />
                      {t.location?.zone && (
                        <Chip className={WH_ZONE_COLORS[t.location.zone] ?? "border-border text-muted-foreground"}>{t.location.zone}</Chip>
                      )}
                    </div>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-muted-foreground")}>{COUNT_KIND_WORDS[t.kind as WhCountKind] ?? t.kind}</td>
                  <td className={cn(TD, "max-w-[22rem] text-xs text-muted-foreground")}>
                    {t.reason ?? "—"}
                    {t.sku && <span className="block text-foreground/80">{t.sku.sku}</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap tabular-nums", late ? "font-semibold text-amber-400" : "text-muted-foreground")}>
                    {t.due_date ?? "—"}
                  </td>
                  <td className={TD}>
                    <Chip className={COUNT_STATUS_COLORS[t.status] ?? "border-border"}>{t.status}</Chip>
                    {t.status === "submitted" && t.submitter && (
                      <span className="block pt-0.5 text-[11px] text-muted-foreground">by {t.submitter.full_name}</span>
                    )}
                  </td>
                  <td className={cn(TD, "text-muted-foreground")}>{t.assignee?.full_name ?? "anyone"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-xs text-muted-foreground")}>{ago(t.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}

      <p className="text-xs text-muted-foreground">
        Counters work from Floor › Count on a phone, in walk order. Cancelling a task needs an RPC that does not exist yet;
        an unwanted task goes away by being counted.
      </p>

      {creating && <NewCountDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

type CreateMode = "location" | "face" | "sku";

function countable(l: WhLocationSummary): boolean {
  return !!l.active && l.kind !== "virtual" && l.kind !== "station";
}

/** New ad hoc counts by location, by rack face or by SKU (every location holding it). */
function NewCountDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const { data: locations = [], isLoading } = useWhLocations();
  const { data: skus = [] } = useWhSkuIndex();
  const create = useWhCreateCount();
  const [mode, setMode] = useState<CreateMode>("location");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [face, setFace] = useState<string>("");
  const [skuId, setSkuId] = useState<string>("");
  const [skuQuery, setSkuQuery] = useState("");
  const [reason, setReason] = useState("");

  const usable = useMemo(() => locations.filter(countable), [locations]);
  const faces = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of usable) if (l.kind === "bay_level" && l.face) m.set(l.face, (m.get(l.face) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [usable]);
  const skuOptions = useMemo(() => {
    const q = skuQuery.trim().toLowerCase();
    return skus.filter((s) => !q || s.sku.toLowerCase().includes(q) || s.product_name.toLowerCase().includes(q)).slice(0, 60);
  }, [skus, skuQuery]);

  const targets: WhLocationSummary[] = useMemo(() => {
    if (mode === "location") return usable.filter((l) => l.id && picked.has(l.id));
    if (mode === "face") return face ? usable.filter((l) => l.kind === "bay_level" && l.face === face) : [];
    if (!skuId) return [];
    return usable.filter((l) => l.contents.some((c) => c.sku_id === skuId && c.qty !== 0));
  }, [mode, usable, picked, face, skuId]);

  const q = query.trim().toUpperCase();
  const listed = usable.filter((l) => !q || (l.code ?? "").toUpperCase().includes(q) || (l.name ?? "").toUpperCase().includes(q)).slice(0, 80);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    const ids = targets.map((l) => l.id).filter((id): id is string => !!id);
    if (ids.length === 0) return;
    const defaultReason =
      mode === "face" ? `Face ${face} count` : mode === "sku" ? `${skus.find((s) => s.id === skuId)?.sku ?? "SKU"} count` : "Ad hoc count";
    create.mutate(
      { locationIds: ids.slice(0, 500), kind: "ad_hoc", reason: reason.trim() || defaultReason },
      {
        onSuccess: (res) => {
          const parts = [`${res.created.length} created`];
          if (res.existing.length) parts.push(`${res.existing.length} already open`);
          if (res.missing.length) parts.push(`${res.missing.length} skipped (inactive, virtual or a station)`);
          toast({ title: "Counts opened", description: parts.join(" · ") });
          onClose();
        },
        onError: (err) => toast({ title: "Couldn't create the counts", description: errorText(err, "Unknown error"), variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New count</DialogTitle>
          <DialogDescription>
            Opens an ad hoc count task per location, due today. A location that already has an open count keeps it.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as CreateMode)}>
          <TabsList className="w-full">
            <TabsTrigger value="location" className="flex-1">By location</TabsTrigger>
            <TabsTrigger value="face" className="flex-1">By rack face</TabsTrigger>
            <TabsTrigger value="sku" className="flex-1">By SKU</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading locations…</p>
        ) : mode === "location" ? (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a location (02-01, IN-01…)" className="pl-8" />
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border/50 p-1">
              {listed.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40">
                  <Checkbox checked={!!l.id && picked.has(l.id)} onCheckedChange={() => l.id && toggle(l.id)} />
                  <span className="font-mono tabular-nums">{l.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {l.zone} · {l.units ?? 0} units{(l.cartons ?? 0) > 0 ? ` · ${l.cartons} cartons` : ""}
                  </span>
                </label>
              ))}
              {listed.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No location matches.</p>}
            </div>
          </div>
        ) : mode === "face" ? (
          <div className="space-y-1.5">
            <Label>Rack face</Label>
            <Select value={face} onValueChange={setFace}>
              <SelectTrigger aria-label="Rack face">
                <SelectValue placeholder="Pick a face" />
              </SelectTrigger>
              <SelectContent>
                {faces.map(([f, n]) => (
                  <SelectItem key={f} value={f}>
                    Face {f} · {n} locations
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Input value={skuQuery} onChange={(e) => setSkuQuery(e.target.value)} placeholder="Find a SKU" />
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border/50 p-1">
              {skuOptions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSkuId(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/40",
                    skuId === s.id && "bg-primary/15",
                  )}
                >
                  <span className="font-medium">{s.sku}</span>
                  <span className="truncate text-xs text-muted-foreground">{s.product_name}</span>
                </button>
              ))}
            </div>
            {skuId && (
              <p className="text-xs text-muted-foreground">
                Every active location holding {skus.find((s) => s.id === skuId)?.sku} today.
              </p>
            )}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="wh-count-reason">Reason (optional)</Label>
          <Input id="wh-count-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Why count it" />
        </div>

        <p className="text-sm">
          {targets.length === 0 ? (
            <span className="text-muted-foreground">Nothing picked yet.</span>
          ) : (
            <>
              <span className="font-semibold tabular-nums">{targets.length}</span> location{targets.length === 1 ? "" : "s"}:{" "}
              <span className="font-mono text-xs text-muted-foreground">
                {targets.slice(0, 12).map((l) => l.code).join(", ")}
                {targets.length > 12 ? ` +${targets.length - 12}` : ""}
              </span>
            </>
          )}
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={targets.length === 0 || create.isPending}>
            {create.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Open {targets.length || ""} count{targets.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
