import { DEFAULT_PRINTING, type AgentApi, type AgentPrinter, type ClaimedJob, type PrintingSettings } from "./api";
import type { SentJournal } from "./journal";
import { errorMessage, type Logger } from "./log";
import { renderJob } from "./render";
import { describeAddress, parseAddress, sendZpl } from "./transport";

/** Sends one job's ZPL to its printer; resolves with where it went. */
export type SendFn = (printer: AgentPrinter, zpl: string, job: ClaimedJob) => Promise<string>;

export interface AgentOptions {
  api: AgentApi;
  agentId: string;
  journal: SentJournal;
  log: Logger;
  /** The agent's folder, for relative file:// addresses. */
  baseDir: string;
  pollMs?: number;
  heartbeatMs?: number;
  sendTimeoutMs?: number;
  send?: SendFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface CycleStats {
  claimed: number;
  printed: number;
  failed: number;
  resent: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait before handing a failed attempt back to the queue: 2 s, 4 s, 8 s…, at most a third of the claim timeout. */
export function backoffMs(attempt: number, claimTimeoutS: number): number {
  return Math.min(2000 * 2 ** Math.max(0, attempt - 1), Math.floor((claimTimeoutS * 1000) / 3));
}

/**
 * The print agent (design §5.5). It drives the printers whose agent_id is its
 * own: heartbeats them every 30 s, listens for new jobs over Realtime, claims
 * every 15 s regardless (rpc_wh_claim_print_jobs, FOR UPDATE SKIP LOCKED on
 * the server), renders each payload to ZPL with the ERP's labels.ts and sends
 * it by the printer's address. A send failure waits (backoff) and hands the
 * job back with rpc_wh_mark_printed('failed'), which re-queues it until
 * printing.max_attempts; a job already sent (the journal) is only marked
 * printed, never sent again. Jobs for different printers run side by side,
 * one printer's jobs in order.
 */
export class PrintAgent {
  private readonly api: AgentApi;
  private readonly opts: Required<Omit<AgentOptions, "api" | "journal" | "log" | "send" | "sleep">>;
  private readonly journal: SentJournal;
  private readonly log: Logger;
  private readonly send: SendFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private printers = new Map<string, AgentPrinter>();
  private printing: PrintingSettings = DEFAULT_PRINTING;
  private unsubscribe: (() => void) | null = null;
  private subscribedKey = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private cycling: Promise<CycleStats> | null = null;
  private again = false;
  private readonly unmarked = new Set<string>();
  private beats = 0;
  private stopped = false;

  constructor(options: AgentOptions) {
    this.api = options.api;
    this.journal = options.journal;
    this.log = options.log;
    this.sleep = options.sleep ?? realSleep;
    this.opts = {
      agentId: options.agentId,
      baseDir: options.baseDir,
      pollMs: options.pollMs ?? 15_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      sendTimeoutMs: options.sendTimeoutMs ?? 10_000,
    };
    this.send =
      options.send ??
      ((printer, zpl, job) =>
        sendZpl(parseAddress(printer.address, this.opts.baseDir), zpl, {
          jobId: job.id,
          printerCode: printer.code,
          timeoutMs: this.opts.sendTimeoutMs,
        }));
  }

  get printerList(): AgentPrinter[] {
    return [...this.printers.values()];
  }

  /** Load settings and printers, heartbeat once and subscribe. */
  async prepare(): Promise<void> {
    await this.refreshSettings();
    await this.refreshPrinters();
    await this.heartbeat();
  }

  /** Run until stop(): Realtime plus a poll floor, heartbeats. */
  async start(): Promise<void> {
    await this.prepare();
    this.timers.push(setInterval(() => void this.cycle(), this.opts.pollMs));
    this.timers.push(setInterval(() => void this.tick(), this.opts.heartbeatMs));
    await this.cycle();
  }

  /** One claim-and-print pass for --once and tests; waits for everything it claimed. */
  async runOnce(): Promise<CycleStats> {
    await this.prepare();
    return this.cycle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.cycling) await Promise.race([this.cycling, this.sleep(10_000)]);
  }

  private async tick(): Promise<void> {
    this.beats += 1;
    try {
      if (this.beats % 10 === 0) await this.refreshSettings();
      await this.refreshPrinters();
      await this.heartbeat();
    } catch (err) {
      this.log.warn(`Heartbeat failed: ${errorMessage(err)}`);
    }
  }

  private async refreshSettings(): Promise<void> {
    try {
      this.printing = await this.api.loadPrinting();
    } catch (err) {
      this.log.warn(`Could not read printing settings (${errorMessage(err)}); using max_attempts ${this.printing.maxAttempts}.`);
    }
  }

  private async refreshPrinters(): Promise<void> {
    const list = await this.api.loadPrinters(this.opts.agentId);
    const before = [...this.printers.keys()].sort().join(",");
    this.printers = new Map(list.map((p) => [p.id, p]));
    const after = [...this.printers.keys()].sort().join(",");
    if (before !== after) {
      if (list.length === 0) {
        this.log.warn(`No active printers have agent_id "${this.opts.agentId}". Register one in Settings › Warehouse › Printers.`);
      } else {
        for (const p of list) {
          let where: string;
          try {
            where = describeAddress(parseAddress(p.address, this.opts.baseDir));
          } catch (err) {
            where = `bad address (${errorMessage(err)})`;
          }
          const dpi = p.dpi !== 203 ? ` · ${p.dpi} dpi (labels are drawn at 203 dpi and print smaller)` : "";
          this.log.info(`Printer ${p.code} "${p.name}" · ${p.label_stock} · ${where}${dpi}`);
        }
      }
    }
    if (after !== this.subscribedKey && !this.stopped) {
      this.unsubscribe?.();
      this.unsubscribe = this.api.subscribe([...this.printers.keys()], () => void this.cycle());
      this.subscribedKey = after;
    }
  }

  private async heartbeat(): Promise<void> {
    const ids = [...this.printers.keys()];
    if (ids.length === 0) return;
    const beat = await this.api.heartbeat(this.opts.agentId, ids);
    if (beat.queued > 0) this.log.info(`Heartbeat: ${beat.printers} printer(s), ${beat.queued} job(s) queued.`);
  }

  /** Claim and print until nothing is left; concurrent calls fold into the running pass. */
  cycle(): Promise<CycleStats> {
    if (this.cycling) {
      this.again = true;
      return this.cycling;
    }
    this.cycling = this.runCycle().finally(() => {
      this.cycling = null;
    });
    return this.cycling;
  }

  private async runCycle(): Promise<CycleStats> {
    const stats: CycleStats = { claimed: 0, printed: 0, failed: 0, resent: 0 };
    try {
      await this.retryUnmarked(stats);
      do {
        this.again = false;
        const ids = [...this.printers.keys()];
        if (ids.length === 0 || this.stopped) break;
        const jobs = await this.api.claim(ids, this.opts.agentId);
        if (jobs.length === 0) break;
        stats.claimed += jobs.length;
        // one printer's jobs in order; printers side by side
        const byPrinter = new Map<string, ClaimedJob[]>();
        for (const job of jobs) byPrinter.set(job.printer_id, [...(byPrinter.get(job.printer_id) ?? []), job]);
        await Promise.all(
          [...byPrinter.values()].map(async (list) => {
            for (const job of list) await this.process(job, stats);
          }),
        );
        if (jobs.length >= 20) this.again = true; // the claim takes at most 20
      } while (this.again && !this.stopped);
    } catch (err) {
      this.log.error(`Print pass failed: ${errorMessage(err)}`);
    }
    return stats;
  }

  private async process(job: ClaimedJob, stats: CycleStats): Promise<void> {
    if (this.journal.wasSent(job.id)) {
      this.log.info(`Job ${job.id} was already sent; marking it printed without sending again.`);
      stats.resent += 1;
      if (await this.markPrinted(job.id)) stats.printed += 1;
      return;
    }
    const printer = this.printers.get(job.printer_id);
    if (!printer) {
      await this.markFailed(job, `Printer ${job.printer_id} is not driven by agent ${this.opts.agentId}.`, false);
      stats.failed += 1;
      return;
    }

    let zpl: string;
    let labels = 0;
    try {
      const rendered = renderJob(job.payload);
      zpl = rendered.zpl;
      labels = rendered.labels;
    } catch (err) {
      await this.markFailed(job, `Cannot render the labels: ${errorMessage(err)}`, false);
      stats.failed += 1;
      return;
    }

    let where: string;
    try {
      where = await this.send(printer, zpl, job);
    } catch (err) {
      const message = errorMessage(err);
      const retry = job.attempts < this.printing.maxAttempts;
      if (retry) {
        const wait = backoffMs(job.attempts, this.printing.claimTimeoutS);
        this.log.warn(
          `Job ${job.id} on ${printer.code}, attempt ${job.attempts} of ${this.printing.maxAttempts}: ${message}. Retrying in ${Math.round(wait / 1000)} s.`,
        );
        await this.sleep(wait);
      } else {
        this.log.error(`Job ${job.id} on ${printer.code} failed after ${job.attempts} attempts: ${message}`);
      }
      await this.markFailed(job, message, retry);
      stats.failed += 1;
      if (retry) this.again = true;
      return;
    }

    // Record before marking: if the mark is lost, the job is never sent again.
    this.journal.record(job.id, printer.code);
    this.log.info(`Job ${job.id} (${job.kind}, ${labels} label${labels === 1 ? "" : "s"}) sent to ${printer.code}: ${where}`);
    if (await this.markPrinted(job.id)) stats.printed += 1;
  }

  private async markPrinted(jobId: string): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      try {
        await this.api.mark(jobId, "printed", null);
        this.unmarked.delete(jobId);
        return true;
      } catch (err) {
        this.log.warn(`Marking job ${jobId} printed failed (${errorMessage(err)}); retrying.`);
        await this.sleep(1000 * 2 ** i);
      }
    }
    this.unmarked.add(jobId);
    this.log.error(`Job ${jobId} was printed but could not be marked; will retry next pass (it will not be sent again).`);
    return false;
  }

  private async retryUnmarked(stats: CycleStats): Promise<void> {
    for (const id of [...this.unmarked]) {
      if (await this.markPrinted(id)) stats.printed += 1;
    }
  }

  private async markFailed(job: ClaimedJob, message: string, willRetry: boolean): Promise<void> {
    try {
      const res = await this.api.mark(job.id, "failed", message.slice(0, 900));
      if (!willRetry || res.status === "failed") this.log.warn(`Job ${job.id} marked ${res.status}: ${message}`);
    } catch (err) {
      // The claim times out on the server and the job is queued again.
      this.log.error(`Could not mark job ${job.id} failed: ${errorMessage(err)}`);
    }
  }
}
