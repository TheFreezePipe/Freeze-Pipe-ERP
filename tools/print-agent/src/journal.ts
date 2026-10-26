import fs from "node:fs";
import path from "node:path";

/**
 * The jobs this installation has already sent to a printer, on disk, so a
 * job is never sent twice: when marking it printed fails, or the server
 * releases a claim that timed out and the agent claims the job again, the
 * journal says "sent" and the agent only marks it printed.
 *
 * One JSON line per job ({id, printer, at}), appended and fsynced before
 * the job is marked printed; entries older than `keepDays` are dropped when
 * the agent starts.
 */
export class SentJournal {
  private readonly file: string;
  private readonly sent = new Map<string, number>();

  constructor(dir: string, keepDays = 14, now = Date.now()) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "sent-jobs.jsonl");
    const cutoff = now - keepDays * 24 * 3600 * 1000;
    const kept: string[] = [];
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { id?: string; at?: string };
          const at = entry.at ? Date.parse(entry.at) : NaN;
          if (entry.id && !Number.isNaN(at) && at >= cutoff) {
            this.sent.set(entry.id, at);
            kept.push(line);
          }
        } catch {
          // a torn last line after a crash: drop it
        }
      }
      fs.writeFileSync(this.file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
    }
  }

  wasSent(jobId: string): boolean {
    return this.sent.has(jobId);
  }

  record(jobId: string, printerCode: string, at = new Date()): void {
    const line = JSON.stringify({ id: jobId, printer: printerCode, at: at.toISOString() }) + "\n";
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.sent.set(jobId, at.getTime());
  }

  get size(): number {
    return this.sent.size;
  }
}
