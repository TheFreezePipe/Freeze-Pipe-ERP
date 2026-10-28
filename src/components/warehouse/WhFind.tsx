import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, MapPin, Package, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { useWhContainers, useWhLocations, useWhSkuIndex, type WhLocationSummary } from "@/lib/hooks";
import { INVENTORY_ROUTES } from "@/lib/inventory-routes";

/**
 * WhFind (design §9.3): a command palette (Ctrl+K or the Find button) over
 * SKUs, carton LPNs and location codes. Picking a result jumps to the map
 * with `?q=` lighting every match and `?loc=` opening the best location:
 * a SKU's pick bin first, a carton's bin, or the location itself. A
 * carton's code is also a link to its passport (closing the palette).
 */

export interface WhFindJump {
  q: string;
  loc: string | null;
}

interface WhFindProps {
  /** Defaults to navigating to /inventory/stock?view=map&q=&loc=. */
  onJump?: (jump: WhFindJump) => void;
  /** Listen for Ctrl+K / Cmd+K while mounted. */
  hotkey?: boolean;
  className?: string;
}

const LIMIT = 8;

/** Where a SKU is best shown: a pickable bin holding it, else any bin, by walk order. */
function bestBinFor(skuId: string, rows: WhLocationSummary[]): WhLocationSummary | undefined {
  const holding = rows.filter((r) => r.active !== false && r.contents.some((c) => c.sku_id === skuId && c.qty > 0));
  const byWalk = (a: WhLocationSummary, b: WhLocationSummary) => (a.pick_sequence ?? 1e9) - (b.pick_sequence ?? 1e9);
  return holding.filter((r) => r.pickable).sort(byWalk)[0] ?? holding.sort(byWalk)[0];
}

export function WhFind({ onJump, hotkey = true, className }: WhFindProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: skus = [] } = useWhSkuIndex();
  const { data: locations = [] } = useWhLocations();
  const { data: containers = [] } = useWhContainers();

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  const stockedSkuIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of locations) for (const c of r.contents) if (c.qty > 0) s.add(c.sku_id);
    return s;
  }, [locations]);

  const q = query.trim().toUpperCase().replace(/^%/, "");
  const results = useMemo(() => {
    const has = (v: string | null | undefined) => (v ?? "").toUpperCase().includes(q);
    const starts = (v: string | null | undefined) => (v ?? "").toUpperCase().startsWith(q);
    const rank = (exact: boolean, prefix: boolean) => (exact ? 0 : prefix ? 1 : 2);
    if (!q) {
      return {
        skus: skus.filter((s) => stockedSkuIds.has(s.id)).slice(0, LIMIT),
        lpns: [] as typeof containers,
        locs: locations.filter((l) => l.kind !== "bay_level" && l.kind !== "virtual" && l.active !== false).slice(0, LIMIT),
      };
    }
    const skuHits = skus
      .filter((s) => has(s.sku) || has(s.product_name) || (s.upc_code ?? "").includes(q))
      .sort(
        (a, b) =>
          rank(a.sku.toUpperCase() === q, starts(a.sku)) - rank(b.sku.toUpperCase() === q, starts(b.sku)) ||
          Number(stockedSkuIds.has(b.id)) - Number(stockedSkuIds.has(a.id)) ||
          a.sku.localeCompare(b.sku),
      )
      .slice(0, LIMIT);
    const lpnHits = containers
      .filter((c) => has(c.code))
      .sort((a, b) => rank(a.code.toUpperCase() === q, starts(a.code)) - rank(b.code.toUpperCase() === q, starts(b.code)) || a.code.localeCompare(b.code))
      .slice(0, LIMIT);
    const locHits = locations
      .filter((l) => l.active !== false && (has(l.code) || has(l.name)))
      .sort(
        (a, b) =>
          rank((a.code ?? "").toUpperCase() === q, starts(a.code)) - rank((b.code ?? "").toUpperCase() === q, starts(b.code)) ||
          (a.pick_sequence ?? 1e9) - (b.pick_sequence ?? 1e9) ||
          (a.code ?? "").localeCompare(b.code ?? ""),
      )
      .slice(0, LIMIT);
    return { skus: skuHits, lpns: lpnHits, locs: locHits };
  }, [q, skus, containers, locations, stockedSkuIds]);

  function jump(j: WhFindJump) {
    setOpen(false);
    setQuery("");
    if (onJump) onJump(j);
    else {
      const sp = new URLSearchParams({ view: "map", q: j.q });
      if (j.loc) sp.set("loc", j.loc);
      navigate(`${INVENTORY_ROUTES.stock}?${sp.toString()}`);
    }
  }

  const empty = results.skus.length + results.lpns.length + results.locs.length === 0;

  return (
    <>
      <Button type="button" variant="outline" size="sm" className={className} onClick={() => setOpen(true)} aria-keyshortcuts="Control+K">
        <Search className="mr-1.5 h-4 w-4" />
        Find
        <kbd className="ml-2 hidden rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground sm:inline">Ctrl K</kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQuery("");
        }}
        title="Find a SKU, carton or location"
        shouldFilter={false}
      >
        <CommandInput value={query} onValueChange={setQuery} placeholder="SKU, LPN (C-…) or location (02-01-2, IN-01)" />
        <CommandList className="max-h-[420px]">
          {empty && <CommandEmpty>Nothing matches “{query.trim()}”.</CommandEmpty>}
          {results.skus.length > 0 && (
            <CommandGroup heading={q ? "SKUs" : "SKUs on the shelves"}>
              {results.skus.map((s) => {
                const bin = bestBinFor(s.id, locations);
                return (
                  <CommandItem key={s.id} value={`sku-${s.id}`} onSelect={() => jump({ q: s.sku, loc: bin?.code ?? null })}>
                    <Package />
                    <span className="font-semibold">{s.sku}</span>
                    <span className="truncate text-muted-foreground">{s.product_name}</span>
                    <CommandShortcut>{bin?.code ?? (stockedSkuIds.has(s.id) ? "" : "not on a shelf")}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {results.lpns.length > 0 && (
            <CommandGroup heading="Cartons">
              {results.lpns.map((c) => (
                <CommandItem key={c.id} value={`lpn-${c.id}`} onSelect={() => jump({ q: c.code, loc: c.location?.code ?? null })}>
                  <Boxes />
                  <CartonLink
                    code={c.code}
                    className="font-semibold"
                    onClick={() => {
                      setOpen(false);
                      setQuery("");
                    }}
                  />
                  <span className="truncate text-muted-foreground">
                    {c.sku?.sku ?? "mixed"} · {c.qty} · {c.state}
                  </span>
                  <CommandShortcut>{c.location?.code ?? ""}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.locs.length > 0 && (
            <CommandGroup heading="Locations">
              {results.locs.map((l) => (
                <CommandItem key={l.id ?? l.code} value={`loc-${l.id}`} onSelect={() => l.code && jump({ q: l.code, loc: l.code })}>
                  <MapPin />
                  <span className="font-semibold tabular-nums">{l.code}</span>
                  <span className="truncate text-muted-foreground">
                    {l.name ?? l.zone}
                    {(l.units ?? 0) !== 0 ? ` · ${l.units} units` : ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
