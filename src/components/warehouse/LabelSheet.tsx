import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Printer, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useWhMarkPrinted,
  useWhPrintJob,
  useWhRequestLabels,
  type WhLabelKind,
  type WhPrintJobResult,
  type WhRequestedFrom,
} from "@/lib/hooks";
import {
  barcodeSvg,
  LABEL_INCHES,
  labelModels,
  parseLabelPayload,
  PRACTICE_BAND,
  type LabelModel,
  type LabelSize,
} from "@/lib/warehouse/labels";

/**
 * Label sheet (design §5.5, §9.3): queues a job with rpc_wh_request_labels,
 * then either shows the station printer's progress or, for the browser path
 * (no station printer, or outbound "practice"), renders the labels at their
 * real size and prints them through a hidden iframe with an @page sized to
 * the label stock (or "Save as PDF" in the print dialog). The person confirms
 * the labels came out; only then does rpc_wh_mark_printed stamp them. Closing
 * without confirming cancels the job.
 */

interface LabelSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: WhLabelKind;
  ids: string[];
  from?: WhRequestedFrom;
  /** What is being printed, for the title ("3 location labels"). */
  title?: string;
  onPrinted?: () => void;
}

const PREVIEW_LIMIT = 12;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** One label's markup; the same string is previewed in the dialog and printed in the iframe. */
function labelMarkup(m: LabelModel): string {
  const bar = barcodeSvg(m.barcode);
  const classes = ["whl-label", `whl-${m.size}`, m.practice ? "whl-practice" : "", m.stock === "green" ? "whl-green" : ""]
    .filter(Boolean)
    .join(" ");
  return [
    `<div class="${classes}">`,
    m.practice ? `<div class="whl-band">${escapeHtml(PRACTICE_BAND)}</div>` : "",
    m.badge ? `<div class="whl-badge${m.badge === "RTS" ? " whl-rts" : ""}">${escapeHtml(m.badge)}</div>` : "",
    `<div class="whl-code">${escapeHtml(m.code)}</div>`,
    ...m.lines.map((l) => `<div class="whl-line">${escapeHtml(l)}</div>`),
    `<div class="whl-bar" style="width:${bar.widthMm}mm">${bar.svg}</div>`,
    `</div>`,
  ].join("");
}

function sheetCss(size: LabelSize): string {
  const { width, height } = LABEL_INCHES[size];
  return `
.whl-label{position:relative;box-sizing:border-box;width:${width}in;height:${height}in;overflow:hidden;display:flex;flex-direction:column;
  background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;padding:0.05in 0.15in 0.06in;}
.whl-band{background:#000;color:#fff;font-weight:700;text-align:center;letter-spacing:.08em;margin:-0.05in -0.15in 0.03in;padding:1px 0;font-size:8pt;}
.whl-code{font-weight:700;line-height:1;white-space:nowrap;}
.whl-line{line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.whl-badge{position:absolute;right:0.12in;background:#000;color:#fff;font-weight:700;padding:1px 6px;}
.whl-bar{flex:1 1 auto;min-height:0.18in;margin-top:0.04in;}
.whl-bar svg{display:block;width:100%;height:100%;}
.whl-3x1 .whl-code{font-size:21pt;} .whl-3x1.whl-practice .whl-code{font-size:17pt;}
.whl-3x1 .whl-line{font-size:8pt;} .whl-3x1 .whl-badge{top:0.07in;font-size:10pt;} .whl-3x1.whl-practice .whl-badge{top:0.22in;}
.whl-4x2 .whl-code{font-size:26pt;margin-top:0.03in;} .whl-4x2 .whl-line{font-size:10.5pt;margin-top:1px;}
.whl-4x2 .whl-badge{top:0.08in;font-size:14pt;} .whl-4x2.whl-practice .whl-badge{top:0.26in;}
.whl-4x2 .whl-rts{background:none;color:#000;font-size:40pt;line-height:1;padding:0;}
.whl-4x2 .whl-bar{max-height:0.55in;}
`;
}

function sheetDocument(models: LabelModel[], size: LabelSize): string {
  const { width, height } = LABEL_INCHES[size];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
@page{size:${width}in ${height}in;margin:0;}
html,body{margin:0;padding:0;background:#fff;}
.whl-label{break-after:page;page-break-after:always;}
.whl-label:last-child{break-after:auto;page-break-after:auto;}
${sheetCss(size)}
</style></head><body>${models.map(labelMarkup).join("")}</body></html>`;
}

/** Print a document through a hidden iframe; resolves once the print dialog has been dismissed or handed off. */
function printDocument(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
    const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        frame.remove();
        reject(new Error("The print frame did not load."));
        return;
      }
      win.addEventListener("afterprint", cleanup, { once: true });
      window.setTimeout(cleanup, 120_000);
      try {
        win.focus();
        win.print();
        resolve();
      } catch (err) {
        frame.remove();
        reject(err instanceof Error ? err : new Error("Printing failed."));
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

type Phase = "requesting" | "ready" | "printed" | "error";

interface SheetState {
  /** The request this state belongs to (kind + ids); a different key means a new job is on its way. */
  key: string;
  phase: Phase;
  job: WhPrintJobResult | null;
  error: string | null;
}

export default function LabelSheet({ open, onOpenChange, kind, ids, from = "desktop", title, onPrinted }: LabelSheetProps) {
  const { mutate: requestLabels } = useWhRequestLabels();
  const mark = useWhMarkPrinted();
  const [state, setState] = useState<SheetState | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const requestedFor = useRef<string | null>(null);
  const key = `${kind}:${ids.join(",")}`;
  const current = state?.key === key ? state : null;
  const phase: Phase = current?.phase ?? "requesting";
  const job = current?.job ?? null;
  const error = printError ?? current?.error ?? null;

  const { data: agentJob } = useWhPrintJob(job?.target === "printer" ? job.job_id : null);

  // Queue the job once per opening (a ref, so StrictMode's second effect run does not queue twice).
  useEffect(() => {
    if (!open || ids.length === 0 || requestedFor.current === key) return;
    requestedFor.current = key;
    requestLabels(
      { kind, ids, from },
      {
        onSuccess: (res) => setState({ key, phase: "ready", job: res, error: null }),
        onError: (err) =>
          setState({ key, phase: "error", job: null, error: err instanceof Error ? err.message : "Couldn't queue the labels" }),
      },
    );
  }, [open, key, ids, kind, from, requestLabels]);

  const parsed = useMemo(() => {
    if (!job?.payload) return null;
    try {
      const payload = parseLabelPayload(job.payload);
      return { payload, models: labelModels(payload) };
    } catch {
      return null;
    }
  }, [job]);

  const browserJob = job?.target === "browser" && job.status === "queued";

  function close() {
    if (job && browserJob && phase !== "printed") {
      mark.mutate({ jobId: job.job_id, status: "cancelled" });
    }
    requestedFor.current = null;
    setState(null);
    setPrintError(null);
    onOpenChange(false);
  }

  async function print() {
    if (!parsed) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await printDocument(sheetDocument(parsed.models, parsed.payload.size));
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "Printing failed.");
    } finally {
      setPrinting(false);
    }
  }

  function confirmPrinted() {
    if (!job) return;
    mark.mutate(
      { jobId: job.job_id, status: "printed" },
      {
        onSuccess: () => {
          setState({ key, phase: "printed", job, error: null });
          onPrinted?.();
        },
        onError: (err) => setPrintError(err instanceof Error ? err.message : "Couldn't mark the labels printed"),
      },
    );
  }

  const count = ids.length;
  const heading = title ?? `${count} label${count === 1 ? "" : "s"}`;
  const preview = parsed?.models.slice(0, PREVIEW_LIMIT) ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4" /> Print {heading}
          </DialogTitle>
          <DialogDescription>
            {parsed ? `${parsed.models.length} × ${parsed.payload.size.replace("x", "×")} in` : "Queuing the print job…"}
            {parsed?.payload.practice ? " · practice labels (%Z barcodes), staging only" : ""}
          </DialogDescription>
        </DialogHeader>

        {phase === "requesting" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Queuing {count} label{count === 1 ? "" : "s"}…
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {job && job.target === "none" && (
          <div className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            {job.message ?? "Printing is blocked on this environment."}
          </div>
        )}

        {job && job.target === "printer" && (
          <div className="space-y-2 text-sm">
            <p>
              Sent to <span className="font-medium">{job.printer?.name ?? job.printer?.code ?? "the station printer"}</span>.
            </p>
            <p className="flex items-center gap-2 text-muted-foreground">
              {agentJob?.status === "printed" ? (
                <CheckCircle2 className="h-4 w-4 text-green-400" />
              ) : agentJob?.status === "failed" ? (
                <XCircle className="h-4 w-4 text-destructive" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {agentJob?.status === "failed"
                ? `Failed: ${agentJob.error ?? "unknown error"}`
                : agentJob?.status === "printed"
                  ? "Printed"
                  : agentJob?.status === "claimed"
                    ? "Printing…"
                    : "Waiting for the print agent…"}
            </p>
          </div>
        )}

        {browserJob && (
          <div className="space-y-3">
            {job?.message && <p className="text-xs text-muted-foreground">{job.message}</p>}
            {!parsed ? (
              <p className="text-sm text-destructive">The job came back without printable labels.</p>
            ) : (
              <div className="whl-preview rounded-md border border-border/60 bg-neutral-200 p-3">
                <style>{sheetCss(parsed.payload.size) + ".whl-preview .whl-label{margin:0 auto 8px;box-shadow:0 1px 3px rgba(0,0,0,.3);} .whl-preview .whl-green{background:#bbf7d0;}"}</style>
                {/* Markup built by labelMarkup(): text is HTML-escaped and the SVG comes from bwip-js. */}
                <div dangerouslySetInnerHTML={{ __html: preview.map(labelMarkup).join("") }} />
                {parsed.models.length > PREVIEW_LIMIT && (
                  <p className="text-center text-xs text-neutral-700">+{parsed.models.length - PREVIEW_LIMIT} more</p>
                )}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {phase === "printed" ? (
              <p className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Marked printed.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Print on {parsed?.payload.size === "4x2" ? "4×2" : "3×1"} in label stock at 100% scale, or choose Save as
                PDF in the print dialog. Then confirm below so the labels are stamped printed.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {browserJob && phase !== "printed" && (
            <>
              <Button variant="outline" onClick={print} disabled={!parsed || printing}>
                {printing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
                Print
              </Button>
              <Button onClick={confirmPrinted} disabled={!parsed || mark.isPending}>
                They printed
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={close}>
            {browserJob && phase !== "printed" ? "Cancel job" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
