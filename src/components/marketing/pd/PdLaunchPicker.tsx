/**
 * Product Development — launch picker, drop attach confirm, create-launch
 * wrapper. The picker is PdDropPicker's twin for launches: type-ahead, a
 * Suggested row for the launch that already carries a card of the drop (else
 * the one whose name matches it), upcoming launches (kind · date · product
 * count), "Create launch" when the drop has no launch, "Detach from launch".
 * The launch is the date authority: a card that attaches follows the launch
 * date (rpc_pd_attach_launch). Halted cards never attach: the drop confirm
 * lists them greyed as Skipped and sends only the live rows.
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { MEMBER_STATE_LABEL, attachPlan, launchReadyBy, type DropCardRef } from "@/lib/marketing/launch-link";
import { useLaunches, type MktLaunchWithMembers } from "@/lib/hooks/use-marketing";
import { useAttachLaunch, type PdProjectWithRefs } from "@/lib/hooks/use-pd";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { fmtDayLong, launchKindLabel } from "@/components/marketing/launch-format";
import { DateShift, StageChip } from "@/components/marketing/LaunchLinkParts";
import { launchProductCount } from "@/components/marketing/launch-members";
import { LAUNCH_DOT_CLASS, cardCount, launchPickerSections, type LaunchFormPrefill } from "./pd-launch-utils";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

export interface PdLaunchPickerProps {
  todayIso: string;
  /** The card's / drop's tag: drives the Suggested row and the Create row. */
  dropTag: string | null;
  /** The drop's cards (live + arrived): a launch already carrying one is suggested first and hides Create. */
  dropCards?: readonly DropCardRef[];
  /** The launch the card rides now (checked in the list). */
  currentLaunchId?: string | null;
  /** Cards "Create launch" would carry; the Create row shows only with onCreate. */
  createCount?: number;
  onPick: (launch: MktLaunchWithMembers) => void;
  onCreate?: () => void;
  onDetach?: () => void;
  align?: "start" | "center" | "end";
  /** The trigger (rendered asChild). */
  children: ReactElement;
}

export function PdLaunchPicker({
  todayIso,
  dropTag,
  dropCards,
  currentLaunchId,
  createCount = 0,
  onPick,
  onCreate,
  onDetach,
  align = "start",
  children,
}: PdLaunchPickerProps) {
  const { data: launches = [], isLoading, isError } = useLaunches();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { suggested, upcoming, offerCreate } = launchPickerSections(launches, { query: draft, dropTag, todayIso, dropCards });
  const tag = dropTag?.trim() || null;
  // Never offer Create before the launches are known: a matching launch may still be loading.
  const showCreate = !isLoading && !isError && !!onCreate && offerCreate && !!tag && createCount > 0;

  function pick(l: MktLaunchWithMembers) {
    setOpen(false);
    setDraft("");
    onPick(l);
  }

  const row = (l: MktLaunchWithMembers, sug: boolean) => (
    <button
      key={l.id}
      type="button"
      onClick={() => pick(l)}
      aria-current={l.id === currentLaunchId ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
        sug && "bg-violet-500/10",
      )}
    >
      <span className={LAUNCH_DOT_CLASS} />
      <span className="min-w-0 flex-1 truncate">{l.name}</span>
      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
        {[launchKindLabel(l.kind), l.launch_date ? fmtDayLong(l.launch_date) : null, String(launchProductCount(l))]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {l.id === currentLaunchId && <Check className="h-3.5 w-3.5 shrink-0 text-violet-300" />}
    </button>
  );

  const hdr = (label: string) => (
    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
  );

  return (
    <span onClick={stop} onKeyDown={stop} className="contents">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setDraft("");
        }}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align={align} className="w-80 p-2" onClick={stop} onKeyDown={stop}>
          <Input
            autoFocus
            value={draft}
            placeholder="Launch name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = suggested ?? upcoming[0];
                if (first) pick(first);
              }
              if (e.key === "Escape") setOpen(false);
            }}
            className="h-8 text-sm"
          />
          <div className="mt-1.5 max-h-72 overflow-y-auto">
            {isLoading && <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>}
            {suggested && (
              <>
                {hdr("Suggested")}
                {row(suggested, true)}
              </>
            )}
            {upcoming.length > 0 && (
              <>
                {hdr("Upcoming")}
                {upcoming.map((l) => row(l, false))}
              </>
            )}
            {showCreate && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onCreate?.();
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-accent"
              >
                Create “{tag}” launch from {cardCount(createCount)}
              </button>
            )}
          </div>
          {onDetach && currentLaunchId && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDetach();
              }}
              className="mt-1.5 flex w-full items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" /> Detach from launch
            </button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attach a whole drop: confirm with one row per card (+ the placeholder row);
// halted cards greyed as Skipped, arrived cards link only (dates frozen)
// ---------------------------------------------------------------------------

export interface PdAttachDropDialogProps {
  dropTag: string;
  launch: MktLaunchWithMembers | null;
  /** The drop's cards (live + arrived; usePdDropCards). */
  cards: readonly PdProjectWithRefs[];
  todayIso: string;
  onClose: () => void;
}

export function PdAttachDropDialog({ dropTag, launch, cards, todayIso, onClose }: PdAttachDropDialogProps) {
  const attach = useAttachLaunch();
  const plan = launch ? attachPlan(cards, launch, todayIso) : { rows: [], skipped: [] };
  const { rows, skipped } = plan;
  const readyBy = launch ? launchReadyBy(launch) : null;

  async function confirm() {
    if (!launch || rows.length === 0 || attach.isPending) return;
    try {
      const res = await attach.mutateAsync({ projectIds: rows.map((r) => r.id), launchId: launch.id });
      const skippedNames = res.skipped.map((s) => s.name);
      toast({
        title: `${cardCount(res.attached)} attached to ${launch.name}`,
        description: skippedNames.length > 0 ? `Skipped · ${skippedNames.join(", ")}` : undefined,
      });
      onClose();
    } catch (e) {
      toast({ title: "Not attached", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <Dialog
      open={!!launch}
      onOpenChange={(o) => {
        if (!o && !attach.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {launch && (
          <>
            <DialogHeader>
              <DialogTitle>
                Attach {dropTag} to {launch.name}
              </DialogTitle>
              <DialogDescription className="tabular-nums">
                {launch.launch_date ? `Launch ${fmtDayLong(launch.launch_date)}` : "Launch date —"}
                {readyBy && ` · ready by ${fmtDayLong(readyBy)}`}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[55vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="pb-1.5 pr-2 font-semibold">Card</th>
                    <th className="pb-1.5 pr-2 font-semibold">Stage</th>
                    <th className="pb-1.5 pr-2 font-semibold">Target</th>
                    <th className="pb-1.5 font-semibold">Order by</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border align-middle">
                      <td className="py-1.5 pr-2">
                        <div>{r.name}</div>
                        {r.fromLaunch && (
                          <div className="text-[11px] text-muted-foreground">from {r.fromLaunch.name}</div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        <StageChip label={r.archived ? MEMBER_STATE_LABEL.arrived : r.stageLabel} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <DateShift from={r.oldTarget} to={r.newTarget} />
                      </td>
                      <td className="py-1.5">
                        <DateShift from={r.oldOrderBy} to={r.newOrderBy} />
                      </td>
                    </tr>
                  ))}
                  {rows
                    .filter((r) => r.replaces)
                    .map((r) => (
                      <tr key={`ph-${r.id}`} className="border-b border-border align-middle">
                        <td className="py-1.5 pr-2 text-muted-foreground/60 line-through">{r.replaces}</td>
                        <td className="py-1.5 pr-2">
                          <StageChip label="Placeholder" />
                        </td>
                        <td colSpan={2} className="py-1.5 text-muted-foreground">
                          → {r.name}
                        </td>
                      </tr>
                    ))}
                  {skipped.map((s) => (
                    <tr key={`skip-${s.id}`} className="border-b border-border align-middle opacity-50">
                      <td className="py-1.5 pr-2 text-muted-foreground">{s.name}</td>
                      <td className="py-1.5 pr-2">
                        <StageChip label={s.stageLabel} />
                      </td>
                      <td colSpan={2} className="py-1.5 text-muted-foreground">
                        Skipped
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={attach.isPending}>
                Cancel
              </Button>
              <Button onClick={() => void confirm()} disabled={rows.length === 0 || attach.isPending}>
                {attach.isPending ? "Attaching…" : `Attach ${cardCount(rows.length)}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create a launch from a drop (the normal launch form, prefilled)
// ---------------------------------------------------------------------------

/** Open while `prefill` is set; the prefill is snapshotted by the opener so a board refetch never resets the form. */
export function PdCreateLaunchDialog({ prefill, onClose }: { prefill: LaunchFormPrefill | null; onClose: () => void }) {
  return (
    <LaunchFormDialog
      open={!!prefill}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      prefill={prefill ?? undefined}
    />
  );
}
