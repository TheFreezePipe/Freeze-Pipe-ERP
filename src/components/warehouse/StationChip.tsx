import { useEffect, useState } from "react";
import { Check, Loader2, MapPin, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { isDemoMode } from "@/lib/env";
import {
  readPinnedStation,
  useWhEndStation,
  useWhStartStation,
  useWhStation,
  useWhStations,
  writePinnedStation,
  type WhPrinterRef,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface StationChipProps {
  className?: string;
  /** The task shell's top bar: a 44 px hit area around a narrower pill. */
  compact?: boolean;
}

// One re-confirmation of the pinned station per signed-in user per page load.
let pinnedConfirmedFor: string | null = null;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function printersLine(printers: WhPrinterRef[] | undefined): string {
  const agents = (printers ?? []).filter((p) => p.transport !== "browser");
  if (agents.length === 0) return "No printer at this station: labels print from the browser.";
  return `Labels print on ${agents.map((p) => p.name || p.code).join(", ")}.`;
}

/**
 * The live station session (design §5.5, §9.3): "Mfg desk 2", or "No
 * station". Tapping opens a sheet to pick a station or end the session; a
 * fixed laptop can pin its station (localStorage `wh.pinnedStation`) so it is
 * re-confirmed at every sign-in. Scanning a station label wherever a ScanSink
 * is live does the same as picking it here. Internal roles only.
 */
export function StationChip({ className, compact = false }: StationChipProps) {
  const { user, hasRole, roleResolved } = useAuth();
  if (isDemoMode || !user || !roleResolved || !hasRole("admin", "manager", "user")) return null;
  return <StationChipInner userId={user.id} className={className} compact={compact} />;
}

function StationChipInner({ userId, className, compact }: StationChipProps & { userId: string }) {
  const { data: session, isLoading, isError } = useWhStation();
  const [open, setOpen] = useState(false);
  const { data: stations = [], isLoading: stationsLoading } = useWhStations(open);
  const { mutate: startStation, isPending: starting } = useWhStartStation();
  const { mutate: endStation, isPending: ending } = useWhEndStation();
  const [pinned, setPinned] = useState<string | null>(() => readPinnedStation());

  const liveCode = session?.station?.code ?? null;
  const label = session ? (session.station?.name ?? session.station?.code ?? "Station") : "No station";

  // A pinned laptop re-confirms its station once per sign-in.
  useEffect(() => {
    if (isLoading || isError || !pinned || pinnedConfirmedFor === userId) return;
    pinnedConfirmedFor = userId;
    if (liveCode === pinned) return;
    startStation(
      { scan: `%${pinned}` },
      {
        onSuccess: (r) =>
          toast({ title: `Station: ${r.session.name ?? r.session.code}`, description: "Pinned on this device." }),
        onError: (err) =>
          toast({
            title: "Couldn't start the pinned station",
            description: errorText(err, "Unknown error"),
            variant: "destructive",
          }),
      },
    );
  }, [isLoading, isError, pinned, liveCode, userId, startStation]);

  function pick(code: string) {
    startStation(
      { scan: `%${code}` },
      {
        onSuccess: (r) => {
          setOpen(false);
          if (pinned) {
            writePinnedStation(r.session.code);
            setPinned(r.session.code);
          }
          toast({ title: `Station: ${r.session.name ?? r.session.code}`, description: printersLine(r.printers) });
        },
        onError: (err) =>
          toast({ title: "Couldn't start the station", description: errorText(err, "Unknown error"), variant: "destructive" }),
      },
    );
  }

  function finish() {
    endStation(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast({ title: "Station session ended", description: "Labels print from the browser until you scan a station." });
      },
      onError: (err) =>
        toast({ title: "Couldn't end the session", description: errorText(err, "Unknown error"), variant: "destructive" }),
    });
  }

  function togglePin(on: boolean) {
    const code = on ? liveCode : null;
    writePinnedStation(code);
    setPinned(code);
  }

  const pill = (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        compact ? "max-w-[8.5rem]" : "max-w-[12rem]",
        session ? "border-green-500/40 bg-green-500/10 text-green-400" : "border-border text-muted-foreground",
      )}
    >
      {starting ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <MapPin className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{isLoading ? "Station…" : label}</span>
      {pinned && <Pin className="h-3 w-3 shrink-0 opacity-70" aria-label="Pinned" />}
    </span>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("touch-manipulation", compact && "flex h-11 items-center px-1", className)}
        aria-label={session ? `Station: ${label}. Change station` : "No station. Pick a station"}
      >
        {pill}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:mx-auto sm:max-w-lg sm:rounded-t-xl"
        >
          <SheetHeader>
            <SheetTitle>Station</SheetTitle>
            <SheetDescription>
              Labels you ask for print on this station&apos;s printer. Scanning a station label does the same as picking it
              here.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {stationsLoading && stations.length === 0 ? (
              <p className="col-span-2 flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading stations…
              </p>
            ) : stations.length === 0 ? (
              <p className="col-span-2 py-4 text-sm text-muted-foreground">No station locations yet.</p>
            ) : (
              stations.map((st) => {
                const live = st.code === liveCode;
                return (
                  <button
                    key={st.id}
                    type="button"
                    disabled={starting}
                    onClick={() => pick(st.code)}
                    className={cn(
                      "flex min-h-[52px] flex-col items-start justify-center rounded-lg border px-3 py-2 text-left transition-all touch-manipulation active:scale-[0.98] disabled:opacity-60",
                      live ? "border-green-500/50 bg-green-500/10" : "border-border hover:bg-muted/50",
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-1 text-sm font-semibold">
                      <span className="truncate">{st.name ?? st.code}</span>
                      {live && <Check className="h-4 w-4 shrink-0 text-green-400" />}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{st.code}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">Pin to this device</p>
              <p className="text-xs text-muted-foreground">
                {pinned
                  ? `Pinned to ${pinned}: started again at every sign-in here.`
                  : "For a fixed laptop: start this station at every sign-in."}
              </p>
            </div>
            <Switch
              checked={!!pinned}
              disabled={!liveCode && !pinned}
              onCheckedChange={togglePin}
              aria-label="Pin this station to this device"
            />
          </div>

          {session && (
            <Button variant="outline" className="mt-3 h-[52px] w-full touch-manipulation" onClick={finish} disabled={ending}>
              {ending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              End session at {label}
            </Button>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
