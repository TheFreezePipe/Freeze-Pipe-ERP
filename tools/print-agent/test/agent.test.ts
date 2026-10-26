import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, PrintAgent } from "../src/agent";
import type { AgentApi, AgentPrinter, ClaimedJob } from "../src/api";
import { SentJournal } from "../src/journal";
import { silentLogger } from "../src/log";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "fp-agent-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PRINTER: AgentPrinter = { id: "p-1", code: "DOCK-1", name: "Dock", address: "file://./out", label_stock: "white_4x2", dpi: 203 };
const PAYLOAD = {
  kind: "location",
  practice: true,
  size: "3x1",
  labels: [{ id: "loc-1", code: "IN-01", barcode: "%ZIN-01", words: "Inbound staging" }],
};

function job(id: string, attempts = 1, printerId = "p-1"): ClaimedJob {
  return { id, kind: "location", printer_id: printerId, payload: PAYLOAD, item_ids: ["loc-1"], attempts };
}

/** A fake ERP: claims hand out `queue` once each; marks are recorded. */
function fakeApi(queue: ClaimedJob[][], maxAttempts = 3) {
  const marks: { id: string; status: string; error: string | null }[] = [];
  const api: AgentApi = {
    loadPrinters: vi.fn(async () => [PRINTER]),
    loadPrinting: vi.fn(async () => ({ maxAttempts, claimTimeoutS: 60 })),
    heartbeat: vi.fn(async () => ({ printers: 1, queued: 0 })),
    claim: vi.fn(async () => queue.shift() ?? []),
    mark: vi.fn(async (id: string, status: "printed" | "failed", error: string | null) => {
      marks.push({ id, status, error });
      return { status };
    }),
    subscribe: vi.fn(() => () => undefined),
  };
  return { api, marks };
}

function agentWith(api: AgentApi, journal: SentJournal, send: (zpl: string, j: ClaimedJob) => Promise<string>) {
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const agent = new PrintAgent({
    api,
    agentId: "agent-dev",
    journal,
    log: silentLogger,
    baseDir: tmp(),
    send: (_p, zpl, j) => send(zpl, j),
    sleep,
  });
  return { agent, sleep };
}

describe("PrintAgent", () => {
  it("heartbeats, claims, renders ZPL with labels.ts, sends once and marks printed", async () => {
    const { api, marks } = fakeApi([[job("j-1")]]);
    const sent: string[] = [];
    const { agent } = agentWith(api, new SentJournal(tmp()), async (zpl) => {
      sent.push(zpl);
      return "out/file.zpl";
    });
    const stats = await agent.runOnce();
    expect(api.heartbeat).toHaveBeenCalledWith("agent-dev", ["p-1"]);
    expect(api.claim).toHaveBeenCalledWith(["p-1"], "agent-dev");
    expect(api.subscribe).toHaveBeenCalledWith(["p-1"], expect.any(Function));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("^XA");
    expect(sent[0]).toContain("%ZIN-01");
    expect(sent[0]).toContain("PRACTICE");
    expect(marks).toEqual([{ id: "j-1", status: "printed", error: null }]);
    expect(stats).toMatchObject({ claimed: 1, printed: 1, failed: 0 });
  });

  it("never sends a job twice: a re-claimed job from the journal is only marked printed", async () => {
    const dir = tmp();
    const journal = new SentJournal(dir);
    journal.record("j-1", "DOCK-1");
    const { api, marks } = fakeApi([[job("j-1", 2)]]);
    const send = vi.fn(async () => "x");
    const { agent } = agentWith(api, new SentJournal(dir), send);
    const stats = await agent.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(marks).toEqual([{ id: "j-1", status: "printed", error: null }]);
    expect(stats.resent).toBe(1);
  });

  it("keeps the sent record when marking fails and does not resend on the next pass", async () => {
    const { api, marks } = fakeApi([[job("j-1")], [job("j-1", 2)]]);
    let failMarks = 4;
    api.mark = vi.fn(async (id: string, status: "printed" | "failed", error: string | null) => {
      if (failMarks-- > 0) throw new Error("network");
      marks.push({ id, status, error });
      return { status };
    });
    const send = vi.fn(async () => "x");
    const { agent } = agentWith(api, new SentJournal(tmp()), send);
    const first = await agent.runOnce();
    expect(first.printed).toBe(0);
    const second = await agent.cycle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(marks.filter((m) => m.status === "printed").map((m) => m.id)).toEqual(["j-1", "j-1"]);
    expect(second.printed).toBeGreaterThanOrEqual(1);
  });

  it("backs off and hands a failed attempt back to the queue, then gives up at max_attempts", async () => {
    const { api, marks } = fakeApi([[job("j-1", 1)], [job("j-1", 2)], [job("j-1", 3)]]);
    const send = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:9100");
    });
    const { agent, sleep } = agentWith(api, new SentJournal(tmp()), send);
    const stats = await agent.runOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
    expect(marks.map((m) => m.status)).toEqual(["failed", "failed", "failed"]);
    expect(marks[0].error).toBe("connect ECONNREFUSED 10.0.0.9:9100");
    expect(stats.failed).toBe(3);
  });

  it("fails a job whose payload cannot be rendered, without sending", async () => {
    const bad = { ...job("j-bad"), payload: { kind: "nope", labels: [] } };
    const { api, marks } = fakeApi([[bad]]);
    const send = vi.fn(async () => "x");
    const { agent } = agentWith(api, new SentJournal(tmp()), send);
    await agent.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(marks[0]).toMatchObject({ id: "j-bad", status: "failed" });
    expect(marks[0].error).toMatch(/Cannot render/);
  });
});

describe("backoffMs", () => {
  it("doubles from 2 s and stays under a third of the claim timeout", () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, 60))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(6, 60)).toBe(20000);
  });
});

describe("SentJournal", () => {
  it("survives a restart and drops old or torn lines", () => {
    const dir = tmp();
    const j = new SentJournal(dir);
    j.record("a", "DOCK-1", new Date("2026-10-01T00:00:00Z"));
    j.record("b", "DOCK-1", new Date("2026-10-22T00:00:00Z"));
    writeFileSync(path.join(dir, "sent-jobs.jsonl"), '{"id":"c","printer":"X","at":"2026-10-22T01:00:00Z"}\n{"id":', { flag: "a" });
    const again = new SentJournal(dir, 14, Date.parse("2026-10-23T00:00:00Z"));
    expect(again.wasSent("a")).toBe(false);
    expect(again.wasSent("b")).toBe(true);
    expect(again.wasSent("c")).toBe(true);
    expect(again.size).toBe(2);
  });
});
