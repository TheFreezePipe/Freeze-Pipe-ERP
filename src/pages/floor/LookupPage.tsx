import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { ResultFlash, type FlashTone } from "@/components/warehouse/ResultFlash";
import { useAuth } from "@/lib/auth-context";
import { useInventory, useLinkBarcode, useProducts, useResolveScan, type WhScanMatch } from "@/lib/hooks";
import { parseScan, type ScanKind } from "@/lib/warehouse/scan";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const FLASH_MS = 900;

const SYMBOLOGY_LABELS: Record<string, string> = {
  upca: "UPC-A",
  upce: "UPC-E",
  ean13: "EAN-13",
  ean8: "EAN-8",
  other: "Other",
};

const KIND_LABELS: Record<ScanKind, string> = {
  location: "Location",
  carton: "Carton",
  practice: "Practice label",
  order: "Order",
  gtin: "Barcode",
  sku: "SKU",
};

/** Kinds a manager may attach to a SKU as a product barcode. */
const LINKABLE: ReadonlySet<ScanKind> = new Set(["gtin", "sku"]);

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function MatchCard({ match }: { match: WhScanMatch }) {
  const { data: inventory = [] } = useInventory();
  const stock = inventory.find((row) => row.sku_id === match.sku_id);
  const finished = stock?.warehouse_finished ?? 0;
  const onHand = stock
    ? (stock.warehouse_raw ?? 0) +
      (stock.warehouse_prefilled_raw ?? 0) +
      (stock.warehouse_in_production ?? 0) +
      (stock.warehouse_finished ?? 0) +
      (stock.warehouse_other ?? 0)
    : null;

  return (
    <Card className="border-green-500/40">
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-4xl font-bold leading-tight break-words">{match.sku}</p>
          <p className="text-lg text-muted-foreground">{match.product_name}</p>
        </div>
        {match.code && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base tabular-nums">{match.code}</span>
            {match.symbology && (
              <Badge variant="outline" className="border-green-500/30 bg-green-500/10 text-[10px] text-green-400">
                {SYMBOLOGY_LABELS[match.symbology] ?? match.symbology}
              </Badge>
            )}
          </div>
        )}
        {stock && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Finished</p>
              <p className="text-3xl font-bold tabular-nums">{finished.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">On hand</p>
              <p className="text-3xl font-bold tabular-nums">{(onHand ?? 0).toLocaleString()}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LinkToSku({ scan, onLinked }: { scan: string; onLinked: () => void }) {
  const { data: products = [] } = useProducts();
  const link = useLinkBarcode();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const options = products
    .filter((p) => p.is_active)
    .filter((p) => !q || p.sku.toLowerCase().includes(q) || p.product_name.toLowerCase().includes(q))
    .slice(0, 8);
  const selected = products.find((p) => p.id === selectedId) ?? null;

  async function submit() {
    if (!selected) return;
    setError(null);
    try {
      const result = await link.mutateAsync({ skuId: selected.id, scan });
      toast({ title: `Linked ${result.code} to ${selected.sku}` });
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link the barcode");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <p className="text-base font-semibold">Link to SKU</p>
        <Input
          placeholder="Search SKU"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-12 text-base"
        />
        <div className="grid grid-cols-2 gap-2">
          {options.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={cn(
                "flex min-h-[56px] flex-col items-start rounded-lg border p-3 text-left transition-all",
                "active:scale-[0.97] touch-manipulation",
                selectedId === p.id
                  ? "border-primary bg-primary/10 ring-1 ring-primary"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <span className="text-sm font-bold">{p.sku}</span>
              <span className="line-clamp-1 text-xs text-muted-foreground">{p.product_name}</span>
            </button>
          ))}
        </div>
        {error && <ErrorBox message={error} />}
        <Button
          type="button"
          className="h-14 w-full text-lg font-semibold touch-manipulation"
          disabled={!selected || link.isPending}
          onClick={submit}
        >
          {link.isPending ? "Linking…" : selected ? `Link to ${selected.sku}` : "Link"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function LookupPage() {
  const { hasRole } = useAuth();
  const canLink = hasRole("admin", "manager");
  const [searchParams, setSearchParams] = useSearchParams();
  const { mutate: resolveScan, data: result, variables, isPending, error, reset } = useResolveScan();
  const [flash, setFlash] = useState<FlashTone | null>(null);
  // ?scan= from the floor home (or a shared link) is looked up once on arrival.
  const initialScan = useRef(searchParams.get("scan"));

  const lookup = useCallback(
    (value: string) => {
      setSearchParams({ scan: value }, { replace: true });
      resolveScan(value, {
        onSuccess: (r) => setFlash(r.match ? "ok" : "fail"),
        onError: () => setFlash("fail"),
      });
    },
    [resolveScan, setSearchParams],
  );

  useEffect(() => {
    const value = initialScan.current;
    initialScan.current = null;
    if (value) lookup(value);
  }, [lookup]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const scanned = variables ?? searchParams.get("scan");
  const parsed = scanned ? parseScan(scanned) : null;
  const match = result?.match ?? null;
  const unknown = !!result && !match;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:space-y-6">
      <ResultFlash tone={flash} label={flash === "ok" ? match?.sku : unknown ? "No match" : undefined} />

      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" className="h-10 w-10 shrink-0 touch-manipulation">
          <Link to="/go" aria-label="Back to floor">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="flex-1 text-2xl font-bold">Look up</h1>
        <ScanSink onScan={lookup} />
      </div>

      {!scanned && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Scan a barcode or label.</CardContent>
        </Card>
      )}

      {scanned && isPending && (
        <Card className="animate-pulse">
          <CardContent className="p-5">
            <p className="break-all font-mono text-2xl tabular-nums">{scanned}</p>
          </CardContent>
        </Card>
      )}

      {error && !isPending && <ErrorBox message={error.message} />}

      {match && !isPending && <MatchCard match={match} />}

      {unknown && !isPending && scanned && parsed && (
        <>
          <Card className="border-red-500/40">
            <CardContent className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-[10px] text-red-400">
                  No match
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    parsed.kind === "practice"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {KIND_LABELS[parsed.kind]}
                </Badge>
              </div>
              <p className="break-all font-mono text-2xl tabular-nums">{scanned}</p>
              {result.candidates.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {result.candidates.map((code) => (
                    <span key={code} className="rounded border px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                      {code}
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          {canLink && LINKABLE.has(parsed.kind) && (
            <LinkToSku
              key={scanned}
              scan={scanned}
              onLinked={() => {
                reset();
                lookup(scanned);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
