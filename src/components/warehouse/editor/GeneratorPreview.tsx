import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WhGenerateResult } from "@/lib/hooks";

/**
 * The generator's dry run (rpc_wh_generate_locations p_dry_run = true) as
 * four lists, then Apply for real. Conflicts are never written: a changed
 * code, a code taken by another location, or a bay-level to deactivate that
 * still holds stock.
 */

const REASONS: Record<string, string> = {
  code_changed: "the code would change (rename the face back, or move its stock and retire the old code)",
  code_taken: "another location already has this code",
  duplicate_in_layout: "two faces generate the same code",
  not_empty: "still holds stock, so it stays active",
};

interface GeneratorPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: WhGenerateResult | null;
  applied: boolean;
  applying: boolean;
  onApply: () => void;
}

function CodeList({ codes, limit = 60 }: { codes: string[]; limit?: number }) {
  if (codes.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <p className="text-xs leading-relaxed tabular-nums">
      {codes.slice(0, limit).join(" · ")}
      {codes.length > limit ? ` … +${codes.length - limit} more` : ""}
    </p>
  );
}

export function GeneratorPreview({ open, onOpenChange, result, applied, applying, onApply }: GeneratorPreviewProps) {
  const create = result?.create ?? [];
  const update = result?.update ?? [];
  const conflicts = result?.conflicts ?? [];
  const deactivate = result?.deactivate ?? [];
  const nothing = create.length + deactivate.length + conflicts.length === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{applied ? "Locations generated" : "Preview locations"}</DialogTitle>
          <DialogDescription>
            {applied
              ? `Created ${result?.created ?? 0}, updated ${result?.updated ?? 0}, deactivated ${result?.deactivated ?? 0}. Every pick sequence was recomputed.`
              : "What the generator would do with the saved layout. Nothing changes until Apply."}
          </DialogDescription>
        </DialogHeader>
        {!result ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running the dry run…
          </p>
        ) : (
          <div className="space-y-4">
            <section className="space-y-1">
              <h3 className="text-sm font-medium">
                Create <span className="text-muted-foreground">({create.length})</span>
              </h3>
              <CodeList codes={create} />
            </section>
            <section className="space-y-1">
              <h3 className="text-sm font-medium">
                Update in place <span className="text-muted-foreground">({update.length})</span>
              </h3>
              <p className="text-xs text-muted-foreground">Geometry, zone and pick flags follow the layout; codes stay.</p>
              <CodeList codes={update} limit={30} />
            </section>
            <section className="space-y-1">
              <h3 className="text-sm font-medium">
                Deactivate <span className="text-muted-foreground">({deactivate.length})</span>
              </h3>
              <CodeList codes={deactivate} />
            </section>
            <section className="space-y-1">
              <h3 className={conflicts.length ? "text-sm font-medium text-amber-400" : "text-sm font-medium"}>
                Conflicts <span className="text-muted-foreground">({conflicts.length})</span>
              </h3>
              {conflicts.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {conflicts.map((c) => (
                    <li key={`${c.code}-${c.reason}`} className="tabular-nums">
                      <span className="font-semibold">{c.code}</span>
                      {c.existing_code && c.existing_code !== c.code ? ` (now ${c.existing_code})` : ""}: {REASONS[c.reason] ?? c.reason}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {!applied && nothing && (
              <p className="text-xs text-muted-foreground">The saved layout matches the locations; applying only recomputes the pick sequence.</p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {applied ? "Close" : "Cancel"}
          </Button>
          {!applied && (
            <Button onClick={onApply} disabled={!result || applying}>
              {applying && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
