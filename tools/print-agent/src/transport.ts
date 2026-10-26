import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Where a printer's ZPL goes, from wh_printers.address:
 *   tcp://host[:port]        raw socket, port 9100 by default (network Zebras)
 *   share://HOST/ShareName   Windows raw spool through a shared printer: the
 *                            ZPL is written to a temp file and `copy /B`'d to
 *                            \\HOST\ShareName (a USB printer on this PC is
 *                            share://localhost/<its share name>)
 *   file://<directory>       writes one .zpl file per job (staging practice,
 *                            or an owner without a printer yet); relative
 *                            paths are taken from the agent's folder
 */
export type PrinterAddress =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "share"; host: string; share: string; unc: string }
  | { kind: "file"; dir: string };

const SHARE_RE = /^share:\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9 ._$-]+?)\/?$/i;
const TCP_RE = /^tcp:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i;

export class AddressError extends Error {}

export function parseAddress(address: string | null | undefined, baseDir: string): PrinterAddress {
  const a = (address ?? "").trim();
  const tcp = TCP_RE.exec(a);
  if (tcp) {
    const port = tcp[2] ? Number(tcp[2]) : 9100;
    if (port < 1 || port > 65535) throw new AddressError(`Port ${port} is out of range in ${a}.`);
    return { kind: "tcp", host: tcp[1], port };
  }
  const share = SHARE_RE.exec(a);
  if (share) {
    return { kind: "share", host: share[1], share: share[2], unc: `\\\\${share[1]}\\${share[2]}` };
  }
  if (/^file:\/\//i.test(a)) {
    let rest = decodeURIComponent(a.slice("file://".length));
    if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1); // file:///C:/labels
    if (!rest) throw new AddressError("file:// needs a directory, like file://C:/labels or file://./out.");
    return { kind: "file", dir: path.resolve(baseDir, rest) };
  }
  throw new AddressError(`Unknown printer address "${a}": use tcp://host:9100, share://HOST/Share or file://<directory>.`);
}

export function describeAddress(addr: PrinterAddress): string {
  switch (addr.kind) {
    case "tcp":
      return `tcp ${addr.host}:${addr.port}`;
    case "share":
      return `share ${addr.unc}`;
    case "file":
      return `file ${addr.dir}`;
  }
}

export interface SendOptions {
  jobId: string;
  printerCode: string;
  timeoutMs?: number;
}

/** Send one job's ZPL. Resolves with where it went (a file path for file://); rejects with a readable error. */
export async function sendZpl(addr: PrinterAddress, zpl: string, opts: SendOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  switch (addr.kind) {
    case "tcp":
      await sendTcp(addr.host, addr.port, zpl, timeoutMs);
      return `${addr.host}:${addr.port}`;
    case "share":
      await sendShare(addr.unc, zpl, opts, timeoutMs * 3);
      return addr.unc;
    case "file":
      return writeZplFile(addr.dir, zpl, opts);
  }
}

function sendTcp(host: string, port: number, data: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done(new Error(`No answer from ${host}:${port} within ${Math.round(timeoutMs / 1000)} s.`));
    });
    socket.once("error", (err) => done(new Error(`${host}:${port}: ${err.message}`)));
    socket.once("connect", () => {
      socket.end(data, "utf8");
    });
    socket.once("close", (hadError) => {
      if (!hadError) done();
    });
  });
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function sendShare(unc: string, zpl: string, opts: SendOptions, timeoutMs: number): Promise<void> {
  if (process.platform !== "win32") throw new Error("share:// printers need the agent to run on Windows.");
  const tmp = path.join(os.tmpdir(), `fp-label-${safeName(opts.jobId)}-${process.pid}.zpl`);
  await fs.writeFile(tmp, zpl, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      // copy /B sends the bytes to the spooler unchanged (RAW); both paths are ours or validated by parseAddress.
      const child = spawn("cmd.exe", ["/d", "/s", "/c", `copy /B "${tmp}" "${unc}"`], {
        windowsVerbatimArguments: true,
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`copy to ${unc} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`copy to ${unc} failed (exit ${code}): ${output.trim().replace(/\s+/g, " ") || "no output"}`));
      });
    });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function writeZplFile(dir: string, zpl: string, opts: SendOptions): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}_${safeName(opts.printerCode)}_${safeName(opts.jobId)}.zpl`);
  const partial = `${file}.partial`;
  await fs.writeFile(partial, zpl, "utf8");
  await fs.rename(partial, file);
  return file;
}
