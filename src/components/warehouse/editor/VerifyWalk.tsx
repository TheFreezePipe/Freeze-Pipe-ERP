import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useWhResequence, type WhLocationSummary } from "@/lib/hooks";
import { patchFace, WALK_DIRS, type DraftLayout } from "@/lib/warehouse/layout-draft";
import { NativeSelect, NumberField } from "./fields";

/**
 * Verify walk (design §9.3, §5.3): the canvas draws the saved pick_sequence
 * path; here the admin reorders faces by their walk pass and direction
 * (draft edits: Save, then Preview and Apply recompute every sequence) and
 * fixes single locations through rpc_wh_resequence (which the next
 * generator run overwrites).
 */

interface VerifyWalkProps {
  draft: DraftLayout;
  locations: WhLocationSummary[];
  onChange: (next: DraftLayout) => void;
}

export function VerifyWalk({ draft, locations, onChange }: VerifyWalkProps) {
  const { toast } = useToast();
  const resequence = useWhResequence();
  const [fixes, setFixes] = useState<Map<string, number | null>>(new Map());

  const faces = useMemo(() => {
    const active = new Set(draft.racks.filter((r) => r.active).map((r) => r.id));
    return draft.faces
      .filter((f) => active.has(f.rack_id))
      .map((f) => ({ face: f, rack: draft.racks.find((r) => r.id === f.rack_id)?.code ?? "?" }))
      .sort((a, b) => a.face.walk_pass - b.face.walk_pass || a.face.face_code.localeCompare(b.face.face_code) || a.face.first_bay_no - b.face.first_bay_no);
  }, [draft]);

  const walk = useMemo(() => {
    const rows = locations
      .filter((l) => l.kind === "bay_level" && l.active !== false && l.pick_sequence != null)
      .sort((a, b) => (a.pick_sequence ?? 0) - (b.pick_sequence ?? 0));
    return rows.map((l, i) => {
      const pass = Math.floor((l.pick_sequence ?? 0) / 1000);
      const header = i === 0 || Math.floor((rows[i - 1].pick_sequence ?? 0) / 1000) !== pass;
      return { l, pass, header, code: l.code, pick_sequence: l.pick_sequence };
    });
  }, [locations]);

  const staged = [...fixes.entries()].filter(([code, seq]) => walk.find((w) => w.code === code)?.pick_sequence !== seq);

  function saveFixes() {
    resequence.mutate(
      staged.map(([code, seq]) => ({ code, pick_sequence: seq })),
      {
        onSuccess: (res) => {
          setFixes(new Map());
          toast({ title: `Pick sequence updated (${res.updated} location${res.updated === 1 ? "" : "s"})` });
        },
        onError: (err) => toast({ title: "Couldn't change the sequence", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="space-y-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Faces by walk pass</h3>
        <p className="text-[11px] text-muted-foreground">
          Faces in one pass interleave by position along the walk (facing faces are picked together). Pass 99 is not routed. Edits here are
          layout changes: Save, then Preview and Apply the locations.
        </p>
        <div className="space-y-1">
          {faces.map(({ face, rack }) => (
            <div key={face.id} className="grid grid-cols-[1fr_72px_64px] items-end gap-2">
              <span className="pb-1.5 text-sm">
                <span className="font-semibold">{face.face_code}</span> <span className="text-muted-foreground">{rack}</span>
                {face.aisle ? <span className="text-xs text-muted-foreground"> · aisle {face.aisle}</span> : null}
              </span>
              <NumberField label="Pass" value={face.walk_pass} min={0} max={99} onCommit={(v) => onChange(patchFace(draft, face.id, { walk_pass: v ?? 99 }))} />
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Dir
                <NativeSelect
                  value={face.walk_dir ?? ""}
                  ariaLabel={`Walk direction of face ${face.face_code}`}
                  onChange={(v) => onChange(patchFace(draft, face.id, { walk_dir: v || null }))}
                >
                  <option value="">—</option>
                  {WALK_DIRS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Saved walk · {walk.length} locations</h3>
          <Button type="button" size="sm" disabled={staged.length === 0 || resequence.isPending} onClick={saveFixes}>
            {resequence.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save {staged.length || ""} fix{staged.length === 1 ? "" : "es"}
          </Button>
        </div>
        <p className="text-[11px] text-amber-400/90">Per-location fixes; the next generator Apply recomputes every sequence and overwrites them.</p>
        <div className="max-h-[42vh] space-y-0.5 overflow-y-auto pr-1">
          {walk.map(({ l, pass, header }) => {
            const value = fixes.has(l.code ?? "") ? (fixes.get(l.code ?? "") ?? null) : l.pick_sequence;
            return (
              <div key={l.id}>
                {header && <p className="pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">Pass {pass}</p>}
                <div className="grid grid-cols-[1fr_96px] items-center gap-2">
                  <span className="text-sm tabular-nums">
                    {l.code}
                    {l.is_overflow ? <span className="text-xs text-muted-foreground"> · overflow</span> : l.pickable ? <span className="text-xs text-green-400"> · pick</span> : null}
                  </span>
                  <NumberField
                    label=""
                    ariaLabel={`Pick sequence of ${l.code}`}
                    value={value}
                    min={1}
                    max={999999}
                    nullable
                    onCommit={(v) =>
                      setFixes((prev) => {
                        const next = new Map(prev);
                        next.set(l.code ?? "", v);
                        return next;
                      })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
