/**
 * Confirm step before a launch with attached PD cards changes date (calendar
 * drag or the launch form). Lists, from movePreview, every card that follows
 * the launch (target and order by, old -> new) and the own-date cards that
 * stay. Nothing is saved until Confirm; Cancel leaves everything as it was.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { MovePreview } from "@/lib/marketing/launch-link";
import { fmtDayLong } from "./launch-format";
import { DateShift, OwnDateChip, StageChip } from "./LaunchLinkParts";

interface Props {
  open: boolean;
  launchName: string;
  preview: MovePreview | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function LaunchMoveConfirm({ open, launchName, preview, pending, onCancel, onConfirm }: Props) {
  const moving = preview?.moving ?? [];
  const staying = preview?.staying ?? [];
  const l = preview?.launch;
  const movingCount = moving.filter((r) => r.moves).length;
  const cleared = !!l && !l.newDate;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {cleared ? `Clear the date on ${launchName}?` : `Move ${launchName} to ${fmtDayLong(l?.newDate)}?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {l && (
                <>
                  <span>
                    Launch <DateShift from={l.oldDate} to={l.newDate} />
                  </span>
                  {(l.oldReadyBy || l.newReadyBy) && (
                    <span>
                      Ready by <DateShift from={l.oldReadyBy} to={l.newReadyBy} />
                    </span>
                  )}
                  {(l.oldOrderBy || l.newOrderBy) && (
                    <span>
                      Order by <DateShift from={l.oldOrderBy} to={l.newOrderBy} />
                    </span>
                  )}
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {moving.length + staying.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-3 font-semibold">Product</th>
                <th className="py-1.5 pr-3 font-semibold">Stage</th>
                <th className="py-1.5 pr-3 font-semibold">Target</th>
                <th className="py-1.5 font-semibold">Order by</th>
              </tr>
            </thead>
            <tbody>
              {moving.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="py-2 pr-3">{r.name}</td>
                  <td className="py-2 pr-3"><StageChip label={r.stageLabel} /></td>
                  <td className="py-2 pr-3"><DateShift from={r.oldTarget} to={r.newTarget} /></td>
                  <td className="py-2"><DateShift from={r.oldOrderBy} to={r.newOrderBy} /></td>
                </tr>
              ))}
              {staying.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="py-2 pr-3">{r.name}</td>
                  <td className="py-2 pr-3"><StageChip label={r.stageLabel} /></td>
                  <td className="py-2 pr-3"><OwnDateChip date={r.oldTarget} /></td>
                  <td className="py-2"><DateShift from={r.oldOrderBy} to={r.newOrderBy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending
              ? "Saving…"
              : cleared
                ? "Clear date"
                : movingCount > 0
                  ? `Move launch and ${movingCount} ${movingCount === 1 ? "product" : "products"}`
                  : "Move launch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
