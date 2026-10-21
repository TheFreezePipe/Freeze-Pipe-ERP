import { Link, useNavigate } from "react-router-dom";
import { ArrowDownToLine, ArrowLeftRight, ClipboardCheck, Factory, ScanSearch, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface FloorTile {
  label: string;
  icon: LucideIcon;
  /** Icon chip colours (text + tinted background). */
  tone: string;
  to?: string;
  /** Not built yet: renders disabled with this badge. */
  phase?: string;
  wide?: boolean;
}

const TILES: FloorTile[] = [
  { label: "Put away", icon: ArrowDownToLine, tone: "text-green-400 bg-green-400/10", phase: "Phase 1" },
  { label: "Count", icon: ClipboardCheck, tone: "text-amber-400 bg-amber-400/10", phase: "Phase 1" },
  { label: "Move", icon: ArrowLeftRight, tone: "text-blue-400 bg-blue-400/10", phase: "Phase 1" },
  { label: "Look up", icon: ScanSearch, tone: "text-primary bg-primary/10", to: "/go/lookup" },
  { label: "Manufacture", icon: Factory, tone: "text-orange-400 bg-orange-400/10", to: "/manufacturing/workspace", wide: true },
];

const TILE_CLASS =
  "flex min-h-[88px] flex-col justify-between gap-3 rounded-lg border p-4 text-left transition-all touch-manipulation";

function TileBody({ tile }: { tile: FloorTile }) {
  const Icon = tile.icon;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={cn("rounded-md p-2", tile.tone)}>
          <Icon className="h-5 w-5" />
        </span>
        {tile.phase && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {tile.phase}
          </Badge>
        )}
      </div>
      <span className="text-base font-semibold">{tile.label}</span>
    </>
  );
}

export default function FloorHome() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const firstName = profile?.full_name?.trim().split(/\s+/)[0];

  return (
    <div className="mx-auto max-w-lg space-y-4 md:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{firstName ? `Hi, ${firstName}` : "Floor"}</h1>
        <ScanSink onScan={(value) => navigate(`/go/lookup?scan=${encodeURIComponent(value)}`)} />
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
              <TileBody tile={tile} />
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
    </div>
  );
}
