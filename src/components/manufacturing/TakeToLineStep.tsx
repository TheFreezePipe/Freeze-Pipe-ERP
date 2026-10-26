import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { AlertTriangle, Check, Loader2, PackageOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { resolveWhScan, useWhStartStation } from "@/lib/hooks";
import { isAlreadyAtLine, useWhTakeToLine } from "@/lib/hooks/use-warehouse-mfg";
import { NO_CARTON_REASONS, type NoCartonReason, type TakenCarton } from "@/lib/warehouse/rts-cartons";
import { cartonCode, stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "@/pages/floor/FloorFlash";
import { useFloorFlash } from "@/pages/floor/use-floor-flash";

/** What a Workspace step exposes so a scan typed into the SKU box reaches it. */
export interface StepScanTarget {
  scan: (raw: string) => void;
}

interface TakeToLineStepProps {
  ref?: Ref<StepScanTarget>;
  /** The task's SKU once chosen; a carton of another SKU is refused. */
  product: { id: string; sku: string } | null;
  taken: TakenCarton[];
  noCarton: NoCartonReason | null;
  onTaken: (carton: TakenCarton) => void;
  onNoCarton: (reason: NoCartonReason | null) => void;
  disabled?: boolean;
}

interface ScannedCarton {
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  qty: number;
  state: string;
  location_code: string | null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Step 1 of the carton flow (design §5.7) at the start of an emptying task:
 * "Scan the carton you are emptying". A carton scan resolves the label and
 * takes the carton to MFG-LINE (rpc_wh_take_to_line); the step lists each
 * carton with its SKU, units and the bin it came from, and the Workspace
 * pre-fills the quantity from their units. A carton already at the line is
 * accepted silently. "No carton" skips with a reason chip. A station label
 * starts a station session. Anything else flashes red and keeps the step open.
 */
export function TakeToLineStep({ ref, product, taken, noCarton, onTaken, onNoCarton, disabled = false }: TakeToLineStepProps) {
  const takeToLine = useWhTakeToLine();
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function fail(text: string, label: string) {
    show("fail", label);
    setNotice(text);
  }

  function accept(c: ScannedCarton, units: number, fromCode: string | null, atLine: boolean) {
    onTaken({ id: c.id, code: c.code, sku_id: c.sku_id, sku: c.sku, units, from_code: fromCode, already_at_line: atLine });
    setNotice(null);
    show("ok", atLine ? `${c.code} · at the line` : `${c.code} to the line`);
  }

  async function takeCarton(raw: string) {
    const code = cartonCode(raw);
    const r = await resolveWhScan(code ? `%${code}` : raw);
    if (r.kind === "station") {
      startStation(
        { scan: raw },
        {
          onSuccess: (s) => show("ok", s.session.name ?? s.session.code),
          onError: (err) => fail(errorText(err, "Couldn't start the station"), "Station not started"),
        },
      );
      return;
    }
    if (r.kind !== "container" || !r.id || !r.match) {
      fail(r.message ?? `${code ?? raw} is not a carton label. Scan the carton's C- label.`, "Not a carton");
      return;
    }
    const m = r.match as unknown as ScannedCarton;
    const c: ScannedCarton = { ...m, id: r.id, code: r.code ?? m.code };
    if (r.superseded) {
      fail(r.message ?? `${r.scanned_code ?? c.code} was relabelled as ${c.code}.`, "Old label");
      return;
    }
    if (c.state === "void" || c.state === "empty") {
      fail(`${c.code} is ${c.state}; nothing to empty.`, `${c.code} is ${c.state}`);
      return;
    }
    if (taken.some((t) => t.id === c.id)) {
      show("warn", `${c.code} already scanned`);
      return;
    }
    if (product && c.sku_id && c.sku_id !== product.id) {
      fail(`${c.code} holds ${c.sku ?? "another SKU"}, not ${product.sku}. Nothing moved.`, "Wrong SKU");
      return;
    }
    if (c.location_code === "MFG-LINE") {
      accept(c, c.qty, null, true);
      return;
    }
    try {
      const res = await takeToLine.mutateAsync({ containerId: c.id });
      accept(c, res.units, res.from?.code ?? c.location_code, false);
    } catch (err) {
      if (isAlreadyAtLine(err)) {
        accept(c, c.qty, null, true);
        return;
      }
      throw err;
    }
  }

  function scan(raw: string) {
    if (disabled || busyRef.current) return;
    if (stationCode(raw)) {
      startStation(
        { scan: raw },
        {
          onSuccess: (s) => show("ok", s.session.name ?? s.session.code),
          onError: (err) => fail(errorText(err, "Couldn't start the station"), "Station not started"),
        },
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    takeCarton(raw)
      .catch((err: unknown) => fail(errorText(err, "Couldn't take the carton to the line"), "Not taken"))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }

  useImperativeHandle(ref, () => ({ scan }));

  const units = taken.reduce((sum, t) => sum + t.units, 0);

  return (
    <Card className={cn(noCarton && "opacity-80")}>
      <FloorFlash flash={flash} />
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="text-base">Scan the carton you are emptying</CardTitle>
            <CardDescription>
              {taken.length > 0
                ? `${taken.length} carton${taken.length === 1 ? "" : "s"} at the line · ${units} units. Scan another, or log the task.`
                : "The carton moves to the line; its units fill in the quantity."}
            </CardDescription>
          </div>
          {busy && <Loader2 className="mt-2 h-5 w-5 animate-spin text-muted-foreground" />}
          <ScanSink onScan={scan} disabled={disabled} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {taken.map((t) => (
          <div key={t.id} className="flex min-h-[52px] items-center gap-3 rounded-lg border border-green-500/40 px-3 py-2">
            <Check className="h-4 w-4 shrink-0 text-green-400" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[15px] font-semibold tabular-nums">{t.code}</p>
              <p className="truncate text-xs text-muted-foreground">
                {t.sku ?? "MIXED"} · {t.units} units · {t.already_at_line ? "already at the line" : `from ${t.from_code ?? "?"}`}
              </p>
            </div>
          </div>
        ))}

        {notice && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {taken.length === 0 &&
          (noCarton ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm text-muted-foreground">
                <PackageOpen className="h-3.5 w-3.5" /> No carton · {noCarton}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label="Scan a carton instead"
                onClick={() => onNoCarton(null)}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">No carton:</span>
              {NO_CARTON_REASONS.map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  variant="outline"
                  className="h-10 rounded-full px-3 text-sm touch-manipulation"
                  onClick={() => onNoCarton(reason)}
                  disabled={disabled}
                >
                  {reason}
                </Button>
              ))}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
