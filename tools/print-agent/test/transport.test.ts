import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AddressError, parseAddress, sendZpl } from "../src/transport";

const base = path.resolve("C:/agent");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseAddress", () => {
  it("reads tcp addresses, 9100 by default", () => {
    expect(parseAddress("tcp://192.168.1.50:9100", base)).toEqual({ kind: "tcp", host: "192.168.1.50", port: 9100 });
    expect(parseAddress("TCP://zebra-dock", base)).toEqual({ kind: "tcp", host: "zebra-dock", port: 9100 });
    expect(() => parseAddress("tcp://host:99999", base)).toThrow(AddressError);
  });

  it("reads Windows shares as a UNC path", () => {
    expect(parseAddress("share://DOCK-PC/Zebra ZD421", base)).toEqual({
      kind: "share",
      host: "DOCK-PC",
      share: "Zebra ZD421",
      unc: "\\\\DOCK-PC\\Zebra ZD421",
    });
    // nothing that could break out of the quoted copy command
    expect(() => parseAddress('share://DOCK-PC/Zebra" & del x', base)).toThrow(AddressError);
    expect(() => parseAddress("share://DOCK PC/Zebra", base)).toThrow(AddressError);
  });

  it("reads file directories, absolute or relative to the agent", () => {
    expect(parseAddress("file://C:/labels", base)).toEqual({ kind: "file", dir: path.resolve("C:/labels") });
    expect(parseAddress("file:///C:/labels/out%20put", base)).toEqual({ kind: "file", dir: path.resolve("C:/labels/out put") });
    expect(parseAddress("file://./out", base)).toEqual({ kind: "file", dir: path.resolve(base, "out") });
    expect(() => parseAddress("file://", base)).toThrow(AddressError);
  });

  it("refuses anything else", () => {
    expect(() => parseAddress("Zebra ZD421", base)).toThrow(/tcp:\/\/host:9100/);
    expect(() => parseAddress(null, base)).toThrow(AddressError);
  });
});

describe("sendZpl", () => {
  it("writes one .zpl file per job through a partial file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fp-agent-"));
    tmpDirs.push(dir);
    const where = await sendZpl({ kind: "file", dir }, "^XA^XZ\n", { jobId: "job-1", printerCode: "DOCK-1" });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_DOCK-1_job-1\.zpl$/);
    expect(where).toBe(path.join(dir, files[0]));
    expect(readFileSync(where, "utf8")).toBe("^XA^XZ\n");
  });

  it("sends raw bytes over TCP and resolves when the printer closes", async () => {
    let received = "";
    const server = net.createServer((socket) => {
      socket.on("data", (d) => (received += d.toString()));
      socket.on("end", () => socket.end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      await sendZpl({ kind: "tcp", host: "127.0.0.1", port }, "^XA^FDhi^FS^XZ", { jobId: "j", printerCode: "P" });
      expect(received).toBe("^XA^FDhi^FS^XZ");
    } finally {
      server.close();
    }
  });

  it("rejects with the host when nothing listens", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      sendZpl({ kind: "tcp", host: "127.0.0.1", port }, "^XA^XZ", { jobId: "j", printerCode: "P", timeoutMs: 2000 }),
    ).rejects.toThrow(`127.0.0.1:${port}`);
  });
});
