import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Printer, XCircle } from "lucide-react";
import { PrintJobStatus, type BrowserPrintJob } from "@/components/warehouse/PrintJobStatus";
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
  useWhRequestLabels,
  type WhLabelKind,
  type WhPrintJobResult,
  type WhRequestedFrom,
} from "@/lib/hooks";
import {
  contentInches,
  LABEL_INCHES,
  labelBarcodeSvg,
  labelModels,
  LANDSCAPE,
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
 *
 * A job that went to a station printer shows PrintJobStatus (queued,
 * printing at <printer>, printed, failed) with Reprint, Print elsewhere and
 * Print from browser; the last switches this sheet to the browser path for
 * that job's own labels. `existingJob` opens the sheet straight on that path
 * for a job made elsewhere (PrintJobStatus on other pages).
 *
 * A 4×6 carton label reads landscape: the preview shows it 6 in × 4 in, and
 * the print document puts each copy on its own 4 × 6 in portrait page with
 * the landscape box turned 90° clockwise (the same way the ZPL `R` fields
 * sit on the media). A job of `copies` per item prints that many pages per
 * label; the title still counts labels ("3 carton labels · 2 each").
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
  /** Print this existing job from the browser instead of queuing a new one. */
  existingJob?: BrowserPrintJob | null;
}

const PREVIEW_LIMIT = 12;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * The 4×6 code's type size: 49 pt, smaller for a long code so it stays clear
 * of the RTS badge (Arial Bold is much wider than the printer's condensed
 * font; its capitals and digits run about 0.6 em, and the badge leaves 3.6 in
 * of the 5.6 in between the margins). Other sizes keep their stylesheet size.
 */
function codeStyle(m: LabelModel): string {
  if (!LANDSCAPE[m.size]) return "";
  const roomIn = m.badge ? 3.6 : 5.6;
  const pt = Math.min(49, Math.floor((roomIn * 72) / (Math.max(1, m.code.length) * 0.6)));
  return ` style="font-size:${pt}pt"`;
}

/** One label's markup; the same string is previewed in the dialog and printed in the iframe. */
function labelMarkup(m: LabelModel): string {
  const bar = labelBarcodeSvg(m);
  const classes = ["whl-label", `whl-${m.size}`, m.practice ? "whl-practice" : "", m.stock === "green" ? "whl-green" : ""]
    .filter(Boolean)
    .join(" ");
  return [
    `<div class="${classes}">`,
    m.practice ? `<div class="whl-band">${escapeHtml(PRACTICE_BAND)}</div>` : "",
    m.badge ? `<div class="whl-badge${m.badge === "RTS" ? " whl-rts" : ""}">${escapeHtml(m.badge)}</div>` : "",
    `<div class="whl-code"${codeStyle(m)}>${escapeHtml(m.code)}</div>`,
    ...m.lines.map((l) => `<div class="whl-line">${escapeHtml(l)}</div>`),
    `<div class="whl-bar" style="width:${bar.widthMm}mm">${bar.svg}</div>`,
    // the 4×6 label prints the barcode's value under the bars, as the ZPL does
    LANDSCAPE[m.size] ? `<div class="whl-human">${escapeHtml(m.barcode)}</div>` : "",
    `</div>`,
  ].join("");
}

/** "4×6 in" */
function sizeWords(size: LabelSize): string {
  return `${size.replace("x", "×")} in`;
}

function sheetCss(size: LabelSize): string {
  // the box as it reads: 6 in × 4 in for the landscape 4×6 label
  const { width, height } = contentInches(size);
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
.whl-4x6{padding:0.2in;}
.whl-4x6 .whl-band{margin:-0.2in -0.2in 0.06in;padding:2px 0;font-size:15pt;}
.whl-4x6 .whl-code{font-size:49pt;}
.whl-4x6 .whl-line{font-size:15.5pt;line-height:1.08;margin-top:2px;}
.whl-4x6 .whl-code+.whl-line{font-size:23pt;margin-top:6px;}
.whl-4x6 .whl-code+.whl-line+.whl-line{font-size:18pt;}
.whl-4x6 .whl-badge{top:0.05in;right:0.2in;} .whl-4x6.whl-practice .whl-badge{top:0.29in;}
.whl-4x6 .whl-rts{background:none;color:#000;font-size:62pt;line-height:1;padding:0;}
.whl-4x6 .whl-bar{flex:0 0 auto;height:1.28in;margin-top:auto;}
.whl-4x6 .whl-human{font-size:11.5pt;line-height:1;margin-top:0.03in;white-space:nowrap;}
`;
}

/** Each label `copies` times, in order: the pages of the print document. */
function printPages(models: LabelModel[]): LabelModel[] {
  return models.flatMap((m) => Array.from({ length: Math.max(1, m.copies) }, () => m));
}

/**
 * The print document: one page per copy of each label, the page the media
 * size. A landscape label (4×6) sits in a portrait page box and is turned 90°
 * clockwise about the point half its height in from its top-left corner, which
 * lands the 6 × 4 box exactly on the 4 × 6 page (its top edge along the
 * page's right side, as the ZPL `R` fields print).
 */
function sheetDocument(models: LabelModel[], size: LabelSize): string {
  const { width, height } = LABEL_INCHES[size];
  const pages = printPages(models);
  const landscape = LANDSCAPE[size];
  const turn = contentInches(size).height / 2;
  const pageCss = landscape
    ? `.whl-page{position:relative;width:${width}in;height:${height}in;overflow:hidden;break-after:page;page-break-after:always;}
.whl-page:last-child{break-after:auto;page-break-after:auto;}
.whl-page>.whl-label{position:absolute;top:0;left:0;transform-origin:${turn}in ${turn}in;transform:rotate(90deg);}`
    : `.whl-label{break-after:page;page-break-after:always;}
.whl-label:last-child{break-after:auto;page-break-after:auto;}`;
  const body = landscape
    ? pages.map((m) => `<div class="whl-page">${labelMarkup(m)}</div>`).join("")
    : pages.map(labelMarkup).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
@page{size:${width}in ${height}in;margin:0;}
html,body{margin:0;padding:0;background:#fff;}
${pageCss}
${sheetCss(size)}
</style></head><body>${body}</body></html>`;
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

export default function LabelSheet({
  open,
  onOpenChange,
  kind,
  ids,
  from = "desktop",
  title,
  onPrinted,
  existingJob = null,
}: LabelSheetProps) {
  const { mutate: requestLabels } = useWhRequestLabels();
  const mark = useWhMarkPrinted();
  const [state, setState] = useState<SheetState | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  // "Print from browser" on a station job: that job (or its replacement) prints here instead.
  const [fallback, setFallback] = useState<{ key: string; job: BrowserPrintJob } | null>(null);
  const requestedFor = useRef<string | null>(null);
  const key = existingJob ? `job:${existingJob.id}` : `${kind}:${ids.join(",")}`;
  const current = state?.key === key ? state : null;
  const phase: Phase = current?.phase ?? (existingJob ? "ready" : "requesting");
  const job = current?.job ?? null;
  const error = printError ?? current?.error ?? null;

  // The job this browser prints, if any: one handed in, a station job switched here, or a browser job.
  const browser: BrowserPrintJob | null = existingJob
    ? existingJob
    : fallback?.key === key
      ? fallback.job
      : job?.target === "browser" && job.status === "queued"
        ? { id: job.job_id, payload: job.payload ?? null, kind, itemIds: ids, cancelOnClose: true }
        : null;

  // Queue the job once per opening (a ref, so StrictMode's second effect run does not queue twice).
  useEffect(() => {
    if (!open || existingJob || ids.length === 0 || requestedFor.current === key) return;
    requestedFor.current = key;
    requestLabels(
      { kind, ids, from },
      {
        onSuccess: (res) => setState({ key, phase: "ready", job: res, error: null }),
        onError: (err) =>
          setState({ key, phase: "error", job: null, error: err instanceof Error ? err.message : "Couldn't queue the labels" }),
      },
    );
  }, [open, existingJob, key, ids, kind, from, requestLabels]);

  const viewPayload = browser?.payload ?? job?.payload ?? null;
  const parsed = useMemo(() => {
    if (!viewPayload) return null;
    try {
      const payload = parseLabelPayload(viewPayload);
      return { payload, models: labelModels(payload) };
    } catch {
      return null;
    }
  }, [viewPayload]);

  const browserJob = !!browser;

  function close() {
    if (browser && browser.cancelOnClose && phase !== "printed") {
      mark.mutate({ jobId: browser.id, status: "cancelled" });
    }
    requestedFor.current = null;
    setState(null);
    setFallback(null);
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
    if (!browser) return;
    mark.mutate(
      { jobId: browser.id, status: "printed" },
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
  const copies = parsed?.payload.copies ?? 1;
  // labels, not pages: "3 carton labels · 2 each"
  const heading = (title ?? `${count} label${count === 1 ? "" : "s"}`) + (copies > 1 ? ` · ${copies} each` : "");
  const preview = parsed?.models.slice(0, PREVIEW_LIMIT) ?? [];
  const size = parsed?.payload.size ?? null;
  const landscape = size ? LANDSCAPE[size] : false;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4" /> Print {heading}
          </DialogTitle>
          <DialogDescription>
            {parsed && size ? `${parsed.models.length} × ${sizeWords(size)}` : "Queuing the print job…"}
            {parsed && copies > 1 ? ` · ${copies} copies of each, ${parsed.models.length * copies} pages` : ""}
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

        {job && job.target === "printer" && !browser && (
          <div className="space-y-2 text-sm">
            <p>
              Sent to <span className="font-medium">{job.printer?.name ?? job.printer?.code ?? "the station printer"}</span>.
            </p>
            <PrintJobStatus jobId={job.job_id} from={from} onPrintFromBrowser={(bj) => setFallback({ key, job: bj })} />
          </div>
        )}

        {browserJob && (
          <div className="space-y-3">
            {job?.message && !existingJob && !fallback && <p className="text-xs text-muted-foreground">{job.message}</p>}
            {!parsed ? (
              <p className="text-sm text-destructive">The job came back without printable labels.</p>
            ) : (
              <div className="whl-preview overflow-x-auto rounded-md border border-border/60 bg-neutral-200 p-3">
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
                Print on {sizeWords(size ?? "3x1")} label stock
                {landscape ? ", portrait (each label is turned to read across the 6 in)," : ""} at 100% scale, or choose
                Save as PDF in the print dialog. Then confirm below so the labels are stamped printed.
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
            {browserJob && phase !== "printed" && browser?.cancelOnClose ? "Cancel job" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
