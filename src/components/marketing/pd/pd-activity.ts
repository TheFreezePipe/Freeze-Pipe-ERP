/**
 * Product Development — the card sheet's Activity wording for stage events.
 * The launch-link and arrival events (launch_moved, restore, link_sku,
 * archive as arrived) read through pdActivityText — plain words with launch
 * names, never a raw enum; the board's own moves keep the sheet's wording.
 */
import { humanizeEnum } from "@/lib/utils";
import { pdStageLabel } from "@/lib/marketing/pd";
import { pdActivityText, type LaunchNameMap, type PdActivityEvent } from "@/lib/marketing/launch-link";

export function eventText(e: PdActivityEvent, launchNames: LaunchNameMap): string {
  const linked = pdActivityText(e, launchNames);
  if (linked) return linked;
  const label = (s: string | null) => (s ? pdStageLabel(s) : "—");
  const reason = e.reason ? ` · ${e.reason}` : "";
  switch (e.outcome) {
    case "advance":
      return `advanced ${label(e.from_stage)} → ${label(e.to_stage)}`;
    case "recycle":
      return `recycled → ${label(e.to_stage)}${reason}`;
    case "revive":
      return `revived → ${label(e.to_stage)}${reason}`;
    case "kill":
      return `killed${reason}`;
    case "archive":
      return `archived${reason}`;
    case "link_fo":
      return "linked factory order";
    default:
      return `${humanizeEnum(e.outcome)}${reason}`;
  }
}
