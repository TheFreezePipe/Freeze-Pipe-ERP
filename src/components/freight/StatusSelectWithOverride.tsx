import { useState } from "react";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { FREIGHT_STATUSES, type FreightStatus } from "@/lib/constants";
import {
  useApplyFreightStatusOverride,
  useClearFreightStatusOverride,
} from "@/lib/tracking/manual-status";
import { useAuth } from "@/lib/auth-context";
import type { FreightShipment } from "@/types/database";
import { cn } from "@/lib/utils";

interface Props {
  shipment: FreightShipment;
  /** Compact: short trigger for table rows. Full: standard width for detail page. */
  variant?: "compact" | "full";
  className?: string;
}

/**
 * Status select that:
 *   1. Prompts the user to confirm any manual change.
 *   2. Persists the new status as a "manual override" (tracking polls keep
 *      updating ETA, but no longer change the status).
 *   3. Shows a small "Manual" badge while overridden — click it to revert to
 *      automatic tracking-driven status.
 */
export function StatusSelectWithOverride({ shipment, variant = "compact", className }: Props) {
  const { profile } = useAuth();
  const applyOverride = useApplyFreightStatusOverride();
  const clearOverride = useClearFreightStatusOverride();
  const [pendingStatus, setPendingStatus] = useState<FreightStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOverridden = !!shipment.status_overridden_at;
  const currentStatusInfo =
    FREIGHT_STATUSES[shipment.status as keyof typeof FREIGHT_STATUSES];

  function handleSelect(next: string) {
    const nextStatus = next as FreightStatus;
    if (nextStatus === shipment.status) return;
    setPendingStatus(nextStatus);
  }

  async function confirmOverride() {
    if (!pendingStatus || !profile?.id) return;
    setError(null);
    try {
      await applyOverride.mutateAsync({
        shipment,
        newStatus: pendingStatus,
        actorId: profile.id,
      });
      setPendingStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    }
  }

  async function handleClearOverride() {
    if (!profile?.id) return;
    try {
      await clearOverride.mutateAsync({ shipment, actorId: profile.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    }
  }

  const triggerWidth = variant === "compact" ? "w-[140px]" : "w-[160px]";
  const triggerHeight = variant === "compact" ? "h-7" : "h-9";

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Select value={shipment.status} onValueChange={handleSelect}>
        <SelectTrigger className={cn(triggerHeight, triggerWidth, variant === "compact" && "text-xs")}>
          <StatusBadge
            label={currentStatusInfo.label}
            color={currentStatusInfo.color}
            bgColor={currentStatusInfo.bgColor}
          />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(FREIGHT_STATUSES).map(([key, info]) => (
            <SelectItem key={key} value={key}>
              <StatusBadge label={info.label} color={info.color} bgColor={info.bgColor} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isOverridden && (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[10px] border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClearOverride();
                }}
              >
                Manual
                <X className="h-2.5 w-2.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-1 text-xs">
                <p className="font-medium">Manual override active</p>
                {shipment.status_overridden_at && (
                  <p className="text-muted-foreground">
                    Set {formatDistanceToNow(parseISO(shipment.status_overridden_at), { addSuffix: true })}
                  </p>
                )}
                <p className="text-muted-foreground">Click to resume automatic tracking-based updates.</p>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      <AlertDialog
        open={pendingStatus !== null}
        onOpenChange={(open) => { if (!open) setPendingStatus(null); }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Manually set status to "{pendingStatus ? FREIGHT_STATUSES[pendingStatus].label : ""}"?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This shipment is currently <Badge variant="outline" className="mx-0.5">{currentStatusInfo.label}</Badge>.
                  Manually changing it will <strong>override carrier tracking</strong> — automatic
                  status updates will pause until you clear the override.
                </p>
                {shipment.eta_last_checked_at && (
                  <p className="text-muted-foreground text-xs">
                    Last carrier check: {format(parseISO(shipment.eta_last_checked_at), "MMM d, h:mm a")}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  ETA will continue to update from carrier data.
                </p>
                {pendingStatus === "delivered" && (
                  <p className="text-xs text-amber-400">
                    Setting to Delivered will move every line item's units from
                    in-transit into warehouse raw stock. This is recorded atomically.
                  </p>
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmOverride} disabled={applyOverride.isPending}>
              {applyOverride.isPending ? "Saving…" : "Yes, override"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
