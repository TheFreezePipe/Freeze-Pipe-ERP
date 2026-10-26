import { Link, useNavigate } from "react-router-dom";
import { ArrowDownToLine, ArrowLeftRight, ClipboardCheck, Factory, ScanSearch, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { useWhPutawayQueue, useWhStartStation } from "@/lib/hooks";
import { useWhCountTasks } from "@/lib/hooks/use-warehouse-counts";
import { stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "./FloorFlash";
import { useFloorFlash } from "./use-floor-flash";

interface FloorTile {
  label: string;
  icon: LucideIcon;
  /** Icon chip colours (text + tinted background). */
  tone: string;
  to?: string;
  /** Not built yet: renders disabled with this badge. */
  phase?: string;
  wide?: boolean;
  /** Which live count the tile carries. */
  count?: "putaway" | "counts";
}

const TILES: FloorTile[] = [
  { label: "Put away", icon: ArrowDownToLine, tone: "text-green-400 bg-green-400/10", to: "/go/putaway", count: "putaway" },
  { label: "Count", icon: ClipboardCheck, tone: "text-amber-400 bg-amber-400/10", to: "/go/count", count: "counts" },
  { label: "Move", icon: ArrowLeftRight, tone: "text-blue-400 bg-blue-400/10", to: "/go/move" },
  { label: "Look up", icon: ScanSearch, tone: "text-primary bg-primary/10", to: "/go/lookup" },
  { label: "Manufacture", icon: Factory, tone: "text-orange-400 bg-orange-400/10", to: "/manufacturing/workspace", wide: true },
];

const TILE_CLASS =
  "flex min-h-[88px] flex-col justify-between gap-3 rounded-lg border p-4 text-left transition-all touch-manipulation";

function TileBody({ tile, count }: { tile: FloorTile; count?: number }) {
  const Icon = tile.icon;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={cn("rounded-md p-2", tile.tone)}>
          <Icon className="h-5 w-5" />
        </span>
        {tile.phase ? (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {tile.phase}
          </Badge>
        ) : count != null && count > 0 ? (
          <span
            className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-amber-400"
            aria-label={`${count} open`}
          >
            {count}
          </span>
        ) : null}
      </div>
      <span className="text-base font-semibold">{tile.label}</span>
    </>
  );
}

export default function FloorHome() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const firstName = profile?.full_name?.trim().split(/\s+/)[0];
  const { data: putaways } = useWhPutawayQueue({}, { refetchInterval: 60_000 });
  const { data: dueCounts } = useWhCountTasks(["open", "counting"], { refetchInterval: 60_000 });
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();
  const counts = { putaway: putaways?.length, counts: dueCounts?.length };

  function onScan(value: string) {
    // A station label starts (or switches) this person's station session (§5.5).
    if (stationCode(value)) {
      startStation(
        { scan: value },
        {
          onSuccess: (r) => show("ok", r.session.name ?? r.session.code),
          onError: (err) => {
            show("fail", "Station not started");
            toast({
              title: "Couldn't start the station",
              description: err instanceof Error ? err.message : "Unknown error",
              variant: "destructive",
            });
          },
        },
      );
      return;
    }
    navigate(`/go/lookup?scan=${encodeURIComponent(value)}`);
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 md:space-y-6">
      <FloorFlash flash={flash} />

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{firstName ? `Hi, ${firstName}` : "Floor"}</h1>
        <ScanSink onScan={onScan} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {TILES.map((tile) =>
          tile.to && !tile.phase ? (
            <Link
              key={tile.label}
              to={tile.to}
              className={cn(
                TILE_CLASS,
                "border-border hover:bg-muted/50 active:scale-[0.97]",
                tile.wide && "col-span-2",
              )}
            >
              <TileBody tile={tile} count={tile.count ? counts[tile.count] : undefined} />
            </Link>
          ) : (
            <div
              key={tile.label}
              aria-disabled="true"
              className={cn(TILE_CLASS, "cursor-not-allowed border-border/60 opacity-50", tile.wide && "col-span-2")}
            >
              <TileBody tile={tile} />
            </div>
          ),
        )}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Scan any location or carton label to look it up, or a station label to print there.
      </p>
    </div>
  );
}
