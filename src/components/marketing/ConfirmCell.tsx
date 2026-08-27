/**
 * Binary confirm control for sales + launches (owner decision 2026-08-27:
 * the old draft → proposed → confirmed track collapsed to confirmed-or-not;
 * legacy "proposed" rows read as unconfirmed). Confirmed still stamps
 * ops_confirmed_by/at, renders solid on the calendar, and clears the
 * "[unconfirmed]" note on the ordering screens.
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { normalizeApproval } from "@/lib/marketing-format";

export interface ConfirmCellProps {
  status: string | null | undefined;
  canEdit: boolean;
  pending: boolean;
  onSet: (confirmed: boolean) => void;
}

export function ConfirmCell({ status, canEdit, pending, onSet }: ConfirmCellProps) {
  const confirmed = normalizeApproval(status) === "confirmed";

  if (confirmed) {
    return (
      <span
        className="group inline-flex items-center gap-1 rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-400"
        onClick={(e) => e.stopPropagation()}
      >
        confirmed
        {canEdit && (
          <button
            type="button"
            aria-label="Unconfirm"
            disabled={pending}
            onClick={() => onSet(false)}
            className="hidden group-hover:inline-flex"
          >
            <X className="h-3 w-3 hover:text-foreground" />
          </button>
        )}
      </span>
    );
  }

  if (!canEdit) {
    return (
      <span className="rounded border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
        unconfirmed
      </span>
    );
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-[11px]"
        disabled={pending}
        onClick={() => onSet(true)}
      >
        Confirm
      </Button>
    </span>
  );
}
