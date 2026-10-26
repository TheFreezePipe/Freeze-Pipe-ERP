import { lazy, Suspense, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Monitor, Printer, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Json } from "@/lib/database.types";
import {
  AGENT_OFFLINE_MS,
  describePrintJob,
  labelStockFor,
  useWhPrintJob,
  useWhPrinters,
  useWhRequestLabels,
  type PrintJobPhase,
  type WhLabelKind,
  type WhRequestedFrom,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";

const LabelSheet = lazy(() => import("./LabelSheet"));

/** A job to print from this browser: the stuck job itself, or a new one the server routed to the browser. */
export interface BrowserPrintJob {
  id: string;
  payload: Json | null;
  kind: WhLabelKind;
  itemIds: string[];
  /** Cancel the job if the sheet closes before "They printed" (true for a job made for the browser). */
  cancelOnClose: boolean;
}

interface PrintJobStatusProps {
  jobId: string;
  /** Where new jobs (Reprint, Print elsewhere) say they came from. */
  from?: WhRequestedFrom;
  /** Handle "Print from browser" yourself (LabelSheet does); otherwise this opens a LabelSheet. */
  onPrintFromBrowser?: (job: BrowserPrintJob) => void;
  /** Reprint or Print elsewhere replaced the job with a new one, now followed here. */
  onJobChange?: (jobId: string) => void;
  /** "row": bordered inline row; "toast": borderless, for a toast description. */
  variant?: "row" | "toast";
  /** "touch" makes the actions 52 px for the floor screens. */
  size?: "default" | "touch";
  className?: string;
}

const STOCK_WORDS: Record<string, string> = { white_4x2: "white 4×2", green_4x2: "green 4×2", white_3x1: "white 3×1" };

function PhaseIcon({ phase }: { phase: PrintJobPhase }) {
  switch (phase) {
    case "printed":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
    case "stale":
    case "blocked":
      return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />;
    case "cancelled":
      return <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  }
}

/**
 * One print job's progress (design §5.5, §9.3): queued, printing at <printer>,
 * printed, or failed with the agent's error. A failed or stale job offers
 * Reprint (a new job on the same printer), Print elsewhere (a new job on
 * another agent printer) and Print from browser (the job's own labels through
 * LabelSheet, which then marks it printed). Polls every 2 s while the job is
 * queued or claimed (useWhPrintJob) and stops when it is done.
 */
export function PrintJobStatus({
  jobId,
  from = "desktop",
  onPrintFromBrowser,
  onJobChange,
  variant = "row",
  size = "default",
  className,
}: PrintJobStatusProps) {
  // Reprint / Print elsewhere follow the new job; a new jobId from the parent starts over.
  const [replaced, setReplaced] = useState<{ from: string; to: string } | null>(null);
  const currentId = replaced?.from === jobId ? replaced.to : jobId;
  const { data: job, isLoading, error, dataUpdatedAt } = useWhPrintJob(currentId);
  const { data: printers = [], isFetched: printersFetched } = useWhPrinters();
  const { mutate: request, isPending: requesting } = useWhRequestLabels();
  const [browserJob, setBrowserJob] = useState<BrowserPrintJob | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const touch = size === "touch";
  const btn = cn(touch ? "h-[52px] px-4 text-sm" : "h-8 px-2.5 text-xs", "touch-manipulation");

  if (isLoading || (!job && !error)) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", variant === "row" && "px-3 py-2", className)}>
        <Loader2 className="h-4 w-4 animate-spin" /> Checking the print job…
      </div>
    );
  }
  if (error || !job) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-destructive", variant === "row" && "px-3 py-2", className)}>
        <XCircle className="h-4 w-4" /> {error instanceof Error ? error.message : "That print job was not found."}
      </div>
    );
  }

  const kind = job.kind as WhLabelKind;
  const known = job.printer_id ? printers.find((p) => p.id === job.printer_id) : undefined;
  const printer = job.printer_id
    ? {
        name: known?.name ?? job.printer?.name ?? "",
        code: known?.code ?? job.printer?.code ?? "",
        // undefined while the printer list loads: do not call the agent offline yet
        last_seen_at: known ? known.last_seen_at : printersFetched ? null : undefined,
      }
    : null;
  const view = describePrintJob(job, printer, dataUpdatedAt);
  const fits = labelStockFor(kind);
  const elsewhere = printers
    .filter((p) => p.active && p.transport === "agent" && p.id !== job.printer_id)
    .sort((a, b) => Number(b.label_stock === fits) - Number(a.label_stock === fits) || a.code.localeCompare(b.code));

  function openBrowser(bj: BrowserPrintJob) {
    if (onPrintFromBrowser) onPrintFromBrowser(bj);
    else setBrowserJob(bj);
  }

  function newJob(printerId: string | null) {
    if (!job) return;
    setNote(null);
    request(
      { kind, ids: job.item_ids, from, printerId },
      {
        onSuccess: (res) => {
          if (res.target === "printer") {
            setReplaced({ from: jobId, to: res.job_id });
            onJobChange?.(res.job_id);
          } else if (res.target === "browser") {
            setNote(res.message ?? "The new job prints from this browser.");
            openBrowser({ id: res.job_id, payload: res.payload ?? null, kind, itemIds: job.item_ids, cancelOnClose: true });
          } else {
            setNote(res.message ?? "Printing is blocked on this environment.");
          }
        },
        onError: (err) => setNote(err instanceof Error ? err.message : "Couldn't queue the labels"),
      },
    );
  }

  const showActions = view.needsAction || view.phase === "printed" || view.phase === "failed";

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 text-sm",
          variant === "row" && "rounded-md border px-3 py-2",
          variant === "row" &&
            (view.phase === "failed"
              ? "border-destructive/40 bg-destructive/5"
              : view.needsAction
                ? "border-amber-500/40 bg-amber-500/5"
                : view.phase === "printed"
                  ? "border-green-500/30"
                  : "border-border/60"),
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <PhaseIcon phase={view.phase} />
          <span className="min-w-0 break-words">{view.text}</span>
        </span>

        {showActions && (
          <span className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className={btn} disabled={requesting} onClick={() => newJob(job.printer_id)}>
              {requesting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}
              Reprint
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={btn} disabled={requesting || elsewhere.length === 0}>
                  <Printer className="mr-1.5 h-3.5 w-3.5" /> Print elsewhere <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Send a new job to</DropdownMenuLabel>
                {elsewhere.map((p) => {
                  const seen = p.last_seen_at ? Date.parse(p.last_seen_at) : null;
                  const online = seen != null && dataUpdatedAt - seen < AGENT_OFFLINE_MS;
                  return (
                    <DropdownMenuItem key={p.id} onSelect={() => newJob(p.id)} className="flex items-start gap-2 py-2">
                      <span
                        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", online ? "bg-green-400" : "bg-muted-foreground/40")}
                        aria-label={online ? "agent online" : "agent offline"}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{p.name || p.code}</span>
                        <span className={cn("block text-xs", p.label_stock === fits ? "text-muted-foreground" : "text-amber-400")}>
                          {p.code}
                          {p.station?.code ? ` · ${p.station.code}` : ""} · {STOCK_WORDS[p.label_stock] ?? p.label_stock}
                          {p.label_stock === fits ? "" : " (other stock)"}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {view.needsAction && (
              <Button
                variant="outline"
                className={btn}
                disabled={requesting || !job.payload}
                onClick={() =>
                  openBrowser({ id: job.id, payload: job.payload, kind, itemIds: job.item_ids, cancelOnClose: false })
                }
              >
                <Monitor className="mr-1.5 h-3.5 w-3.5" /> Print from browser
              </Button>
            )}
          </span>
        )}

        {note && <p className="w-full text-xs text-muted-foreground">{note}</p>}
      </div>

      {browserJob && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => {
              if (!o) setBrowserJob(null);
            }}
            kind={browserJob.kind}
            ids={browserJob.itemIds}
            from={from}
            existingJob={browserJob}
          />
        </Suspense>
      )}
    </>
  );
}
