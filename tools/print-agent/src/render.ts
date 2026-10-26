// The ERP's own label renderer, so a label looks the same whichever path prints it (design §5.5).
import { labelModels, parseLabelPayload, toZpl } from "../../../src/lib/warehouse/labels";

export interface RenderedJob {
  zpl: string;
  labels: number;
  size: string;
  practice: boolean;
}

/** A print job's payload (wh_print_jobs.payload) as ZPL; throws on a payload without labels. */
export function renderJob(payload: unknown): RenderedJob {
  const parsed = parseLabelPayload(payload);
  const count = labelModels(parsed).length;
  if (count === 0) throw new Error("The print job has no labels to print.");
  return { zpl: toZpl(parsed) + "\n", labels: count, size: parsed.size, practice: parsed.practice };
}
