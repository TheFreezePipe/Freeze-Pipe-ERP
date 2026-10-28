import { lazy, Suspense, useState } from "react";
import { format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { ClipboardCheck, LayoutGrid, Loader2, MoveRight, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  useWhCreateCount,
  useWhFixtureBlocked,
  useWhLocation,
  type WhFixtureRow,
  type WhLayout,
  type WhLocationSummary,
} from "@/lib/hooks";
import { CONTAINER_STATE_COLORS, WH_ZONE_COLORS } from "@/lib/status-colors";
import { locationWords } from "@/lib/warehouse/map-modes";
import { cn } from "@/lib/utils";

const LabelSheet = lazy(() => import("./LabelSheet"));

/**
 * LocationDrawer (design §9.3): a 340 px right sheet for `?loc=<code>`:
 * the code in words, zone / pick / overflow / capacity chips, what is there
 * carton by carton plus loose units, the last count and recent movements;
 * Count now, Print label, Rack view, and Move (slice 3). A fixture with no
 * location of its own (`?fx=<id>`, e.g. the gaylord overflow spot) opens
 * here too, for its `blocked` switch. Non-modal, so the map stays live
 * behind it and another tap switches it.
 */

interface LocationDrawerProps {
  code: string | null;
  fixtureId?: string | null;
  locations: WhLocationSummary[];
  layout: WhLayout | undefined;
  onClose: () => void;
  onSelectLocation: (code: string) => void;
  onRackView: (face: string) => void;
}

const MOVE_WORDS: Record<string, string> = {
  receive: "received",
  void_receipt: "receipt voided",
  putaway: "put away",
  move: "moved",
  open_container: "opened",
  count_adjust: "count adjust",
  write_off: "written off",
  bucket_convert: "bucket change",
  mfg_mirror: "manufacturing",
  ledger_mirror: "ledger",
  ship_settle: "shipped",
  opening_balance: "opening stock",
  relabel: "relabelled",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  return format(parseISO(iso), "MMM d, yyyy");
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", className)}>{children}</span>;
}

function FixtureBlockedRow({ fixture, canEdit }: { fixture: WhFixtureRow; canEdit: boolean }) {
  const { toast } = useToast();
  const blockedMutation = useWhFixtureBlocked();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{fixture.name}</p>
        <p className="text-xs text-muted-foreground">
          {fixture.blocked ? "Blocked: routing will avoid it (Phase 2)" : "Open"}
        </p>
      </div>
      <Switch
        checked={fixture.blocked}
        disabled={!canEdit || blockedMutation.isPending}
        aria-label={`${fixture.name} blocked`}
        title={canEdit ? undefined : "Only an admin can change this"}
        onCheckedChange={(next) =>
          blockedMutation.mutate(
            { id: fixture.id, blocked: next, rowVersion: fixture.row_version },
            {
              onSuccess: () => toast({ title: `${fixture.name} ${next ? "blocked" : "open again"}` }),
              onError: (err) =>
                toast({ title: "Couldn't change it", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
            },
          )
        }
      />
    </div>
  );
}

export function LocationDrawer({ code, fixtureId, locations, layout, onClose, onSelectLocation, onRackView }: LocationDrawerProps) {
  const { toast } = useToast();
  const { hasRole } = useAuth();
  const canCount = hasRole("admin", "manager");
  const isAdmin = hasRole("admin");
  const [labels, setLabels] = useState<{ kind: "location" | "station"; id: string; code: string } | null>(null);

  const row = code ? locations.find((l) => l.code === code) : undefined;
  const fixture = !row && fixtureId ? layout?.fixtures.find((f) => f.id === fixtureId) : undefined;
  const open = !!row || !!fixture || (!!code && locations.length > 0);
  const { data: detail, isLoading } = useWhLocation(row?.id ?? null);
  const createCount = useWhCreateCount();

  const linkedFixtures = row?.id ? (layout?.fixtures ?? []).filter((f) => f.location_id === row.id) : [];
  const siblings =
    row?.kind === "bay_level"
      ? locations
          .filter((l) => l.kind === "bay_level" && l.active !== false && l.face === row.face && l.bay === row.bay)
          .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
      : [];
  const codeById = new Map(locations.filter((l) => l.id).map((l) => [l.id as string, l.code]));
  const loose = (detail?.balances ?? []).filter((b) => !b.container_id);
  const containers = detail?.containers ?? [];
  const units = row?.units ?? 0;

  function countNow() {
    if (!row?.id) return;
    createCount.mutate(
      { locationIds: [row.id], kind: "ad_hoc", reason: `Count now from the map (${row.code})` },
      {
        onSuccess: (res) =>
          toast({
            title:
              res.created.length > 0
                ? `Count task created for ${row.code}`
                : res.existing.length > 0
                  ? `A count is already open for ${row.code}`
                  : `${row.code} can't be counted`,
            description: res.created.length > 0 ? "It is on Stock › Counts and the Floor count list." : undefined,
          }),
        onError: (err) =>
          toast({ title: "Couldn't create the count", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
      },
    );
  }

  return (
    <>
      <Sheet
        open={open}
        modal={false}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent
          side="right"
          className="flex w-[340px] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[340px]"
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {fixture ? (
            <div className="flex flex-col gap-4 p-5">
              <SheetHeader className="space-y-1 text-left">
                <SheetTitle className="pr-6 text-xl">{fixture.name}</SheetTitle>
                <SheetDescription>{fixture.kind.replace("_", " ")} · not a stock location</SheetDescription>
              </SheetHeader>
              <div className="flex flex-wrap gap-1.5">
                {fixture.zone && <Chip className={WH_ZONE_COLORS[fixture.zone]}>{fixture.zone}</Chip>}
                {fixture.blocked && <Chip className="border-red-500/30 bg-red-500/10 text-red-400">Blocked</Chip>}
              </div>
              <FixtureBlockedRow fixture={fixture} canEdit={isAdmin} />
              <p className="text-xs text-muted-foreground">
                {(fixture.width_mm ?? 0) / 1000} × {(fixture.depth_mm ?? 0) / 1000} m at ({(fixture.x_mm / 1000).toFixed(1)},{" "}
                {(fixture.y_mm / 1000).toFixed(1)}) m. Move or resize it in Settings › Warehouse › Layout editor.
              </p>
            </div>
          ) : !row ? (
            <div className="p-5">
              <SheetHeader className="text-left">
                <SheetTitle>{code}</SheetTitle>
                <SheetDescription>There is no active location with this code.</SheetDescription>
              </SheetHeader>
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-5">
              <SheetHeader className="space-y-1 text-left">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Location</p>
                <SheetTitle className="pr-6 text-3xl font-bold tabular-nums tracking-wide">{row.code}</SheetTitle>
                <SheetDescription>{locationWords(row)}</SheetDescription>
              </SheetHeader>

              <div className="flex flex-wrap gap-1.5">
                {row.zone && <Chip className={WH_ZONE_COLORS[row.zone]}>{row.zone}</Chip>}
                {row.pickable && <Chip className="border-green-500/30 bg-green-500/10 text-green-400">Pick face</Chip>}
                {row.is_overflow && <Chip className="border-amber-500/30 bg-amber-500/10 text-amber-400">Overflow</Chip>}
                {row.kind === "bay_level" && !row.pickable && !row.is_overflow && (
                  <Chip className="border-slate-500/30 bg-slate-500/10 text-slate-400">Not pickable</Chip>
                )}
                <Chip className="border-slate-500/30 bg-slate-500/10 text-slate-300">
                  {row.capacity_cartons ? `Cap ${row.capacity_cartons} cartons` : "No capacity set"}
                </Chip>
                {linkedFixtures.some((f) => f.blocked) && <Chip className="border-red-500/30 bg-red-500/10 text-red-400">Blocked</Chip>}
                {row.bucket_lock && <Chip className="border-purple-500/30 bg-purple-500/10 text-purple-400">Bucket {row.bucket_lock}</Chip>}
              </div>

              {siblings.length > 1 && (
                <div className="flex items-center gap-1.5" role="group" aria-label="Levels of this bay">
                  <span className="mr-1 text-xs text-muted-foreground">Level</span>
                  {siblings.map((s) => (
                    <Button
                      key={s.code}
                      size="sm"
                      variant={s.code === row.code ? "secondary" : "ghost"}
                      className="h-8 min-w-8 px-2 tabular-nums"
                      onClick={() => s.code && onSelectLocation(s.code)}
                      aria-pressed={s.code === row.code}
                    >
                      {s.level}
                      {(s.units ?? 0) !== 0 && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
                    </Button>
                  ))}
                </div>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  What is here · {units.toLocaleString()} units · {row.cartons ?? 0} cartons
                </h3>
                {isLoading ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </p>
                ) : containers.length === 0 && loose.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Empty.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {containers.map((c) => (
                      <li key={c.id} className="rounded-md border border-border/60 px-2.5 py-1.5">
                        <div className="flex items-center gap-2">
                          <CartonLink code={c.code} className="text-sm font-semibold" />
                          <Chip className={CONTAINER_STATE_COLORS[c.state]}>{c.state}</Chip>
                          {c.label_stock === "green" && <Chip className="border-green-500/30 bg-green-500/10 text-green-400">RTS</Chip>}
                          <span className="ml-auto text-sm tabular-nums">{c.qty}</span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.sku ? `${c.sku.sku} · ${c.sku.product_name}` : "Mixed carton"}
                        </p>
                      </li>
                    ))}
                    {loose.map((b) => (
                      <li key={b.id} className="flex items-center gap-2 rounded-md border border-dashed border-border/60 px-2.5 py-1.5">
                        <span className="text-sm font-semibold">{b.sku?.sku ?? "?"}</span>
                        <span className="text-xs text-muted-foreground">loose · {b.bucket.replace("_", " ")}</span>
                        <span className={cn("ml-auto text-sm tabular-nums", b.on_hand < 0 && "text-amber-400")}>{b.on_hand}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <Kv label="Last count">{when(row.last_counted_at)}</Kv>
                {row.pick_sequence != null && <Kv label="Walk order">{row.pick_sequence}</Kv>}
                {row.rack_code && <Kv label="Rack">{row.rack_code}</Kv>}
                <Kv label="Label">{row.label_verified_at ? `verified ${when(row.label_verified_at)}` : row.label_printed_at ? `printed ${when(row.label_printed_at)}` : "not printed"}</Kv>
              </section>

              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled title="Arrives in Phase 1, slice 3" className="justify-start">
                  <MoveRight className="mr-1.5 h-4 w-4" /> Move
                  <Badge variant="outline" className="ml-auto px-1 text-[9px] text-muted-foreground">
                    slice 3
                  </Badge>
                </Button>
                {canCount && row.kind !== "station" && row.kind !== "virtual" ? (
                  <Button variant="outline" onClick={countNow} disabled={createCount.isPending} className="justify-start">
                    {createCount.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-1.5 h-4 w-4" />}
                    Count now
                  </Button>
                ) : (
                  <Button variant="outline" disabled className="justify-start" title={canCount ? "Stations and virtual locations are not counted" : "Counts are created by a manager"}>
                    <ClipboardCheck className="mr-1.5 h-4 w-4" /> Count now
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={row.kind === "virtual"}
                  onClick={() => row.id && row.code && setLabels({ kind: row.kind === "station" ? "station" : "location", id: row.id, code: row.code })}
                >
                  <Printer className="mr-1.5 h-4 w-4" /> Print label
                </Button>
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={row.kind !== "bay_level" || !row.face}
                  onClick={() => row.face && onRackView(row.face)}
                >
                  <LayoutGrid className="mr-1.5 h-4 w-4" /> Rack view
                </Button>
              </div>
              <p className="-mt-2 text-[11px] text-muted-foreground">Move arrives with Phase 1, slice 3 (Floor › Move).</p>

              {linkedFixtures.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">On the plan</h3>
                  {linkedFixtures.map((f) => (
                    <FixtureBlockedRow key={f.id} fixture={f} canEdit={isAdmin} />
                  ))}
                </section>
              )}

              <section className="space-y-1.5">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">History</h3>
                {(detail?.movements ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isLoading ? "…" : "No movements yet."}</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {(detail?.movements ?? []).slice(0, 10).map((m) => {
                      const incoming = m.to_location_id === row.id && m.from_location_id !== row.id;
                      const outgoing = m.from_location_id === row.id && m.to_location_id !== row.id;
                      const other = incoming ? m.from_location_id : outgoing ? m.to_location_id : null;
                      return (
                        <li key={m.id} className="flex items-baseline gap-2">
                          <span className="w-16 shrink-0 text-muted-foreground">{formatDistanceToNowStrict(parseISO(m.created_at), { addSuffix: false })}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {MOVE_WORDS[m.type] ?? m.type}{" "}
                            <span className={cn("tabular-nums", incoming && "text-green-400", outgoing && "text-amber-400")}>
                              {incoming ? "+" : outgoing ? "−" : ""}
                              {m.qty}
                            </span>{" "}
                            {m.sku?.sku}
                            {other && codeById.get(other) ? <span className="text-muted-foreground"> {incoming ? "from" : "to"} {codeById.get(other)}</span> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {labels && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => {
              if (!o) setLabels(null);
            }}
            kind={labels.kind}
            ids={[labels.id]}
            title={`${labels.kind === "station" ? "Station" : "Location"} label ${labels.code}`}
          />
        </Suspense>
      )}
    </>
  );
}
