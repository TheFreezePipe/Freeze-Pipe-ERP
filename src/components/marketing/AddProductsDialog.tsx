/**
 * Launches page — "Add products": attach PD cards to a launch. Cards are
 * grouped by drop; the drop the launch means (launchSuggestion: a drop whose
 * cards already ride it, else the name match) starts ticked, its arrived
 * cards included (link only, dates frozen). Halted cards are listed greyed
 * and cannot be ticked — the attach skips them (attachPlan, the same rules as
 * rpc_pd_attach_launch). Each ticked card shows its target old -> new and the
 * placeholder product it takes over.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { dropColorFor } from "@/lib/marketing/drop-colors";
import { attachPlan, isArrived, launchReadyBy, pdStageLabel, MEMBER_STATE_LABEL } from "@/lib/marketing/launch-link";
import { useAttachLaunch, usePdBoard, usePdDropCards, type MktLaunchWithMembers } from "@/lib/hooks";
import { fmtDay, fmtDayLong, withArrivedDropCards } from "./launch-format";
import { DateShift, StageChip } from "./LaunchLinkParts";
import { useDropColors } from "./pd/pd-field-utils";
import { addProductGroups, defaultAddPick } from "./launch-members";

interface Props {
  open: boolean;
  /** The launch to add to. */
  launch: MktLaunchWithMembers | null;
  todayIso: string;
  onClose: () => void;
}

export function AddProductsDialog({ open, launch, todayIso, onClose }: Props) {
  // Owned here so the dialog stays open while the attach is in flight.
  const attach = useAttachLaunch();
  return (
    <Dialog open={open && !!launch} onOpenChange={(o) => !o && !attach.isPending && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        {launch && <AddProductsBody key={launch.id} launch={launch} todayIso={todayIso} onClose={onClose} attach={attach} />}
      </DialogContent>
    </Dialog>
  );
}

const NO_DROP = "";

const isHalted = (c: { stage: string }) => c.stage === "halted";

function AddProductsBody({
  launch,
  todayIso,
  onClose,
  attach,
}: {
  launch: MktLaunchWithMembers;
  todayIso: string;
  onClose: () => void;
  attach: ReturnType<typeof useAttachLaunch>;
}) {
  const { data: board = [], isLoading } = usePdBoard();
  const [query, setQuery] = useState("");
  // null = the default pick (the matching drop); a Set once the user ticks anything.
  const [picked, setPicked] = useState<Set<string> | null>(null);

  const boardGroups = useMemo(() => addProductGroups(board, launch), [board, launch]);
  // The matching drop's arrived cards are off the board; fetch that one drop.
  const suggestedTag = boardGroups.find((g) => g.suggested)?.tag ?? "";
  const { data: dropCards = [] } = usePdDropCards(suggestedTag);
  const groups = useMemo(() => withArrivedDropCards(boardGroups, dropCards, launch.id), [boardGroups, dropCards, launch.id]);
  const defaultPick = useMemo(() => defaultAddPick(groups), [groups]);

  const selected = picked ?? defaultPick;

  const dropColors = useDropColors();

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          cards: q ? g.cards.filter((c) => c.name.toLowerCase().includes(q) || g.tag.toLowerCase().includes(q)) : g.cards,
        }))
        .filter((g) => g.cards.length > 0),
    [groups, q],
  );

  // Ticked cards in display order — the order the RPC attaches them in (halted cards are never ticked).
  const ordered = useMemo(
    () => groups.flatMap((g) => g.cards).filter((c) => selected.has(c.id) && !isHalted(c)),
    [groups, selected],
  );
  const preview = useMemo(
    () => new Map(attachPlan(ordered, launch, todayIso).rows.map((r) => [r.id, r])),
    [ordered, launch, todayIso],
  );

  function toggle(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  }

  async function submit() {
    if (ordered.length === 0) return;
    try {
      const res = await attach.mutateAsync({ projectIds: ordered.map((c) => c.id), launchId: launch.id });
      toast({ title: `${res.attached} ${res.attached === 1 ? "product" : "products"} added to ${launch.name}` });
      onClose();
    } catch (err) {
      toast({ title: "Couldn't add products", description: describeError(err), variant: "destructive" });
    }
  }

  const readyBy = launchReadyBy(launch);
  const n = ordered.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add products to {launch.name}</DialogTitle>
        <DialogDescription className="flex flex-wrap gap-x-4">
          <span>Launch {fmtDayLong(launch.launch_date)}</span>
          {readyBy && <span>Ready by {fmtDayLong(readyBy)}</span>}
        </DialogDescription>
      </DialogHeader>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cards or drops" className="h-8 pl-8 text-sm" />
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading cards…</div>
      ) : visible.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No cards</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="w-7 py-1.5" />
              <th className="py-1.5 pr-3 font-semibold">Card</th>
              <th className="py-1.5 pr-3 font-semibold">Stage</th>
              <th className="py-1.5 font-semibold">Target</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((g) => {
              // The group tick covers only the cards that can attach.
              const ids = g.cards.filter((c) => !isHalted(c)).map((c) => c.id);
              const on = ids.filter((id) => selected.has(id)).length;
              const color = g.tag !== NO_DROP ? dropColorFor(dropColors, g.tag) : undefined;
              return [
                <tr key={`g:${g.tag}`} className="border-b border-border/50">
                  <td className="py-2 pr-2 align-middle">
                    <Checkbox
                      checked={on === 0 ? false : on === ids.length ? true : "indeterminate"}
                      disabled={ids.length === 0}
                      onCheckedChange={(v) => toggle(ids, v === true)}
                      aria-label={g.tag || "No drop"}
                    />
                  </td>
                  <td colSpan={3} className="py-2">
                    <span
                      className="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium"
                      style={color ? { borderColor: color, color } : undefined}
                    >
                      {g.tag || "No drop"}
                    </span>
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">{g.cards.length}</span>
                  </td>
                </tr>,
                ...g.cards.map((c) => {
                  const halted = isHalted(c);
                  const arrived = isArrived(c);
                  const row = preview.get(c.id);
                  return (
                    <tr key={c.id} className={`border-b border-border/30 ${halted ? "text-muted-foreground/50" : ""}`}>
                      <td className="py-1.5 pr-2 align-middle">
                        <Checkbox
                          checked={!halted && selected.has(c.id)}
                          disabled={halted}
                          onCheckedChange={(v) => toggle([c.id], v === true)}
                          aria-label={c.name}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <span>{c.name}</span>
                        {row?.replaces && (
                          <span className="ml-2 whitespace-nowrap rounded border border-border px-1.5 text-[10px] text-muted-foreground">
                            replaces “{row.replaces}”
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {arrived ? (
                          <StageChip label={MEMBER_STATE_LABEL.arrived} tone="ok" />
                        ) : (
                          <StageChip label={pdStageLabel(c.stage)} tone={halted ? "muted" : "default"} />
                        )}
                      </td>
                      <td className="py-1.5">
                        {halted ? (
                          <span className="whitespace-nowrap text-xs">skipped</span>
                        ) : row ? (
                          <span className="flex flex-col">
                            <DateShift from={row.oldTarget} to={row.newTarget} />
                            {row.fromLaunch && (
                              <span className="whitespace-nowrap text-[10px] text-muted-foreground">leaves {row.fromLaunch.name}</span>
                            )}
                          </span>
                        ) : c.launch ? (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">on {c.launch.name}</span>
                        ) : (
                          <span className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtDay(c.target_launch_date)}</span>
                        )}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={attach.isPending}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={attach.isPending || n === 0}>
          {attach.isPending ? "Adding…" : `Add ${n} ${n === 1 ? "product" : "products"}`}
        </Button>
      </DialogFooter>
    </>
  );
}
