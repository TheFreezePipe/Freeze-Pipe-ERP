import { promises as fs } from "node:fs";
import { AGENT_DIR } from "./config";
import { consoleLogger as log, errorMessage } from "./log";
import { renderJob } from "./render";
import { describeAddress, parseAddress, sendZpl } from "./transport";

/**
 * Render a label without signing in, to check a printer or the layout:
 *
 *   npm run render -- --sample location --to file://./out
 *   npm run render -- --sample lpn --to tcp://192.168.1.50:9100
 *   npm run render -- --payload job.json --to share://DOCK-PC/Zebra
 *   npm run render -- --sample station            (prints the ZPL to the console)
 *   npm run render -- --sample lpn4x6 --to tcp://192.168.1.50:9100   (the 4×6 carton pair)
 *
 * A payload file is a wh_print_jobs.payload ({kind, practice, size, copies, labels}).
 */

const SAMPLES: Record<string, unknown> = {
  location: {
    kind: "location",
    practice: true,
    size: "3x1",
    labels: [{ id: "sample-loc", code: "02-01-3", barcode: "%Z02-01-3", words: "Face 02 · Bay 01 · Level 3", overflow: true }],
  },
  station: {
    kind: "station",
    practice: true,
    size: "3x1",
    labels: [{ id: "sample-st", code: "ST-DOCK", barcode: "%ZST-DOCK", name: "Dock", kind: "station" }],
  },
  lpn: {
    kind: "lpn",
    practice: true,
    size: "4x2",
    labels: [
      {
        id: "sample-lpn",
        code: "C-466-007",
        barcode: "%ZC-466-007",
        sku: "BW20",
        product_name: "Sample bowl",
        qty: 12,
        bucket: "raw",
        shipment: "466",
        carton_seq: 7,
        carton_of: 40,
        date: "2026-10-23",
      },
    ],
  },
  // the 4×6 carton pair: one label rotated to read landscape, printed twice (^PQ2)
  lpn4x6: {
    kind: "lpn",
    practice: true,
    size: "4x6",
    copies: 2,
    labels: [
      {
        id: "sample-lpn-4x6",
        code: "C-466-007",
        barcode: "%ZC-466-007",
        sku: "BW20",
        product_name: "Sample bowl",
        qty: 12,
        bucket: "finished",
        shipment: "466",
        carton_seq: 7,
        carton_of: 40,
        date: "2026-10-23",
      },
    ],
  },
  rts4x6: {
    kind: "lpn_rts",
    practice: true,
    size: "4x6",
    copies: 2,
    labels: [
      {
        id: "sample-rts-4x6",
        code: "C-466-007R1",
        barcode: "%ZC-466-007R1",
        sku: "BW20",
        product_name: "Sample bowl",
        qty: 12,
        bucket: "finished",
        label_stock: "green",
        worker: "Ana",
        finished_at: "2026-10-23T18:05:00Z",
        suggested: "02-01-1",
        from_code: "C-466-007",
      },
    ],
  },
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const sample = arg("--sample");
  const payloadFile = arg("--payload");
  const to = arg("--to");
  let payload: unknown;
  if (payloadFile) payload = JSON.parse(await fs.readFile(payloadFile, "utf8"));
  else if (sample && SAMPLES[sample]) payload = SAMPLES[sample];
  else {
    log.error(`Give --sample ${Object.keys(SAMPLES).join("|")} or --payload <file.json>.`);
    return 2;
  }

  const rendered = renderJob(payload);
  if (!to) {
    process.stdout.write(rendered.zpl);
    return 0;
  }
  const addr = parseAddress(to, AGENT_DIR);
  const where = await sendZpl(addr, rendered.zpl, { jobId: `render-${Date.now()}`, printerCode: "TEST" });
  log.info(`${rendered.labels} ${rendered.size} label(s) sent by ${describeAddress(addr)}: ${where}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error(errorMessage(err));
    process.exit(1);
  },
);
