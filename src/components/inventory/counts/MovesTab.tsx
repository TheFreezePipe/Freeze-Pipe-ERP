import { Check, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUrlFilter } from "@/lib/use-url-filter";
import { useWhMoves, type WhMoveKind, type WhMoveStatus } from "@/lib/hooks/use-warehouse-counts";
import { MOVE_STATUS_COLORS } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { Chip, TableShell } from "./shared";
import { ago, errorText, TD, TH, when } from "./format";

const STATUS_OPTIONS: { value: WhMoveStatus | "all"; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const KIND_OPTIONS: { value: WhMoveKind | "all"; label: string }[] = [
  { value: "all", label: "Any kind" },
  { value: "putaway", label: "Putaway" },
  { value: "replenish", label: "Replenish" },
  { value: "move", label: "Move" },
];

const ORIGIN_WORDS: Record<string, string> = {
  receipt: "check-in",
  rts: "RTS relabel",
  manual: "manual",
  reconcile: "reconcile",
};

/**
 * The moves log (wh_moves): putaway, replenish and move tasks with where
 * each was suggested and where it went, who did it and when. Filters stay
 * in the URL (`mstatus`, `mkind`).
 */
export function MovesTab() {
  const [status, setStatus] = useUrlFilter<WhMoveStatus | "all">("mstatus", "all");
  const [kind, setKind] = useUrlFilter<WhMoveKind | "all">("mkind", "all");
  const { data: moves = [], isLoading, error } = useWhMoves({ status, kind });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as WhMoveStatus | "all")}>
          <SelectTrigger className="w-[160px]" aria-label="Move status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => setKind(v as WhMoveKind | "all")}>
          <SelectTrigger className="w-[160px]" aria-label="Move kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {isLoading ? "" : `${moves.length}${moves.length === 300 ? "+" : ""} move${moves.length === 1 ? "" : "s"}, newest first`}
        </span>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{errorText(error, "Couldn't load the moves")}</p>
      ) : moves.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No moves match these filters.</CardContent>
        </Card>
      ) : (
        <TableShell minWidth={1000}>
          <thead className="border-b border-border/50">
            <tr>
              <th className={TH}>Kind</th>
              <th className={TH}>Status</th>
              <th className={TH}>Origin</th>
              <th className={TH}>What</th>
              <th className={TH}>From</th>
              <th className={TH}>Suggested</th>
              <th className={TH}>To</th>
              <th className={TH}>Who</th>
              <th className={TH}>When</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => {
              const what = m.container
                ? `${m.container.code} · ${m.container.sku?.sku ?? (m.container.sku_id ? "SKU" : "MIXED")} × ${m.container.qty}`
                : `${m.sku?.sku ?? "SKU"} × ${m.qty ?? 0} loose`;
              const at = m.completed_at ?? m.started_at ?? m.created_at;
              return (
                <tr key={m.id} className="border-b border-border/40 last:border-0">
                  <td className={cn(TD, "capitalize")}>{m.kind}</td>
                  <td className={TD}>
                    <Chip className={MOVE_STATUS_COLORS[m.status] ?? "border-border"}>{m.status.replace("_", " ")}</Chip>
                  </td>
                  <td className={cn(TD, "text-muted-foreground")}>{ORIGIN_WORDS[m.origin] ?? m.origin}</td>
                  <td className={TD}>
                    <span className="font-mono text-xs tabular-nums">{what}</span>
                    {m.container?.label_stock === "green" && <Chip className="ml-1.5 border-green-500/35 bg-green-500/10 text-green-400">RTS</Chip>}
                  </td>
                  <td className={cn(TD, "font-mono text-xs tabular-nums")}>{m.from?.code ?? "—"}</td>
                  <td className={cn(TD, "font-mono text-xs tabular-nums text-muted-foreground")}>{m.suggested?.code ?? "—"}</td>
                  <td className={cn(TD, "font-mono text-xs tabular-nums")}>
                    {m.to?.code ?? "—"}
                    {m.followed_suggestion === true && <Check className="ml-1 inline h-3.5 w-3.5 text-green-400" aria-label="followed the suggestion" />}
                    {m.followed_suggestion === false && <X className="ml-1 inline h-3.5 w-3.5 text-amber-400" aria-label="not the suggested location" />}
                  </td>
                  <td className={cn(TD, "text-muted-foreground")}>{m.completer?.full_name ?? m.creator?.full_name ?? "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-xs text-muted-foreground")} title={when(at)}>
                    {ago(at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
