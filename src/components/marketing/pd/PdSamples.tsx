/**
 * Product Development — Samples block (Phase 2). One row per sample round,
 * newest first: dates + verdict are click-to-edit like every other field;
 * photos are a thumbnail strip with a "+" tile. The RPC owns the auto-moves
 * (in hand → Prototype Sent; revise/rejected → back to China Working + next
 * round), so this component only reports what moved.
 */
import { useRef, useState, type ChangeEvent } from "react";
import { ChevronDown, Plus, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import {
  PD_SAMPLE_TYPE_LABEL,
  PD_SAMPLE_TYPES,
  PD_STAGE_LABEL,
  PD_VERDICT_LABEL,
  PD_VERDICTS,
  type PdStage,
  type PdVerdict,
} from "@/lib/marketing/pd";
import {
  useAddPdSamplePhoto,
  usePdPhotoUrls,
  useRemovePdSamplePhoto,
  useSavePdSample,
  type PdProjectWithRefs,
  type PdSamplePatch,
  type PdSampleWithPhotos,
} from "@/lib/hooks/use-pd";
import { EditableValue, FieldRow, SectionTitle, type EditableOption } from "./PdFields";
import { fmtDate } from "./pd-field-utils";

const TYPE_OPTIONS: EditableOption[] = PD_SAMPLE_TYPES.map((t) => ({
  value: t,
  label: PD_SAMPLE_TYPE_LABEL[t],
}));
const VERDICT_OPTIONS: EditableOption[] = PD_VERDICTS.map((v) => ({
  value: v,
  label: PD_VERDICT_LABEL[v],
}));

const VERDICT_TONE: Record<PdVerdict, string> = {
  approved: "border-green-500/50 text-green-400",
  approved_with_changes: "border-amber-500/50 text-amber-400",
  revise: "border-red-500/50 text-red-400",
  rejected: "border-red-500/50 text-red-400",
};

export interface PdSamplesBlockProps {
  project: PdProjectWithRefs;
  /** Gate keys currently missing for the next stage (paints the relevant value red). */
  missing: Set<string>;
  todayIso: string;
}

export function PdSamplesBlock({ project, missing, todayIso }: PdSamplesBlockProps) {
  const save = useSavePdSample();
  const rounds = project.samples;
  const allPaths = rounds.flatMap((r) => r.photos.map((ph) => ph.storage_path));
  const { data: urls = {} } = usePdPhotoUrls(allPaths);

  async function run(patch: PdSamplePatch) {
    try {
      const res = await save.mutateAsync({ projectId: project.id, patch });
      if (res.moved_to) {
        toast({
          title: `→ ${PD_STAGE_LABEL[res.moved_to as PdStage] ?? res.moved_to}`,
          description: res.next_round_id ? `Round ${(res.round_no ?? 0) + 1} opened` : undefined,
        });
      }
    } catch (e) {
      toast({
        title: "Not saved",
        description: describeError(e),
        variant: "destructive",
      });
    }
  }

  const needRound = rounds.length === 0 && (missing.has("sample_received") || missing.has("sample_verdict"));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>Samples</SectionTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending}
          className={cn(needRound && "border-red-500 text-red-400")}
          onClick={() => void run({})}
        >
          <Plus className="h-3.5 w-3.5" />
          Round {rounds.length + 1}
        </Button>
      </div>
      {rounds.length > 0 && (
        <div className="divide-y divide-border rounded-md border border-border">
          {rounds.map((r, i) => (
            <RoundRow
              key={r.id}
              project={project}
              round={r}
              newest={i === 0}
              missing={i === 0 ? missing : EMPTY}
              todayIso={todayIso}
              urls={urls}
              pending={save.isPending}
              onPatch={(patch) => run({ id: r.id, ...patch })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY = new Set<string>();

interface RoundRowProps {
  project: PdProjectWithRefs;
  round: PdSampleWithPhotos;
  newest: boolean;
  missing: Set<string>;
  todayIso: string;
  urls: Record<string, string>;
  pending: boolean;
  onPatch: (patch: Omit<PdSamplePatch, "id">) => void;
}

function RoundRow({ project, round: r, newest, missing, todayIso, urls, pending, onPatch }: RoundRowProps) {
  const [open, setOpen] = useState(newest);
  const verdict = (r.verdict as PdVerdict | null) ?? null;
  const str = (v: string | number | null) => (v == null ? null : String(v));
  const day = (v: string | null) => (v ? v.slice(0, 10) : null);

  return (
    <div className="px-3 py-2">
      {/* Round header — always visible */}
      <div
        className={cn("flex items-center gap-2", !newest && "cursor-pointer select-none")}
        onClick={newest ? undefined : () => setOpen((o) => !o)}
      >
        <span className="text-sm font-medium">Round {r.round_no}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <EditableValue
            kind="select"
            options={TYPE_OPTIONS}
            value={r.sample_type}
            disabled={pending}
            onCommit={(v) => {
              if (v)
                onPatch({
                  sample_type: String(v) as PdSamplePatch["sample_type"],
                });
            }}
            className="text-xs text-muted-foreground"
          />
        </span>
        {r.is_golden && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 px-1.5 text-[11px] text-amber-400">
            <Star className="h-3 w-3 fill-current" />
            Golden
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {!open && r.received_at && <span>In hand {fmtDate(r.received_at)}</span>}
          {!open && verdict && (
            <span className={cn("rounded-full border px-1.5", VERDICT_TONE[verdict])}>{PD_VERDICT_LABEL[verdict]}</span>
          )}
          {!newest && <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />}
        </span>
      </div>

      {open && (
        <>
          <div className="mt-1 grid gap-x-10 md:grid-cols-2">
            <div>
              <FieldRow label="Requested">
                <EditableValue
                  kind="date"
                  value={day(r.requested_at)}
                  max={todayIso}
                  disabled={pending}
                  onCommit={(v) => {
                    if (v) onPatch({ requested_at: String(v) });
                  }}
                />
              </FieldRow>
              <FieldRow label="Factory ETA">
                <EditableValue
                  kind="date"
                  value={day(r.factory_eta)}
                  disabled={pending}
                  onCommit={(v) => onPatch({ factory_eta: str(v) })}
                />
              </FieldRow>
              <FieldRow label="Tracking">
                <EditableValue
                  kind="text"
                  value={r.tracking_no}
                  maxLength={60}
                  disabled={pending}
                  onCommit={(v) => onPatch({ tracking_no: str(v) })}
                />
              </FieldRow>
              <FieldRow label="In hand">
                <EditableValue
                  kind="date"
                  value={day(r.received_at)}
                  max={todayIso}
                  missing={missing.has("sample_received")}
                  disabled={pending || !!verdict}
                  onCommit={(v) => onPatch({ received_at: str(v) })}
                />
              </FieldRow>
            </div>
            <div>
              <FieldRow label="Verdict">
                {verdict ? (
                  <span className={cn("rounded-full border px-1.5 text-xs", VERDICT_TONE[verdict])}>
                    {PD_VERDICT_LABEL[verdict]}
                  </span>
                ) : (
                  <EditableValue
                    kind="select"
                    options={VERDICT_OPTIONS}
                    value={null}
                    missing={missing.has("sample_verdict")}
                    disabled={pending || !r.received_at}
                    onCommit={(v) => {
                      if (v) onPatch({ verdict: String(v) as PdVerdict });
                    }}
                  />
                )}
              </FieldRow>
              <FieldRow label="Notes">
                <EditableValue
                  kind="textarea"
                  value={r.verdict_notes}
                  maxLength={500}
                  disabled={pending}
                  onCommit={(v) => onPatch({ verdict_notes: str(v) })}
                  className="whitespace-pre-wrap"
                />
              </FieldRow>
              <FieldRow label="Feedback sent">
                <EditableValue
                  kind="date"
                  value={day(r.feedback_sent_at)}
                  max={todayIso}
                  disabled={pending}
                  onCommit={(v) => onPatch({ feedback_sent_at: str(v) })}
                />
              </FieldRow>
              <FieldRow label="Factory ack">
                <EditableValue
                  kind="date"
                  value={day(r.factory_acknowledged_at)}
                  max={todayIso}
                  missing={missing.has("sample_verdict") && verdict === "approved_with_changes"}
                  disabled={pending}
                  onCommit={(v) => onPatch({ factory_acknowledged_at: str(v) })}
                />
              </FieldRow>
            </div>
          </div>
          <PhotoStrip project={project} round={r} urls={urls} missing={missing.has("sample_photo")} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

function PhotoStrip({
  project,
  round: r,
  urls,
  missing,
}: {
  project: PdProjectWithRefs;
  round: PdSampleWithPhotos;
  urls: Record<string, string>;
  missing: boolean;
}) {
  const { user } = useAuth();
  const add = useAddPdSamplePhoto();
  const remove = useRemovePdSamplePhoto();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(files.length);
    let order = r.photos.length;
    for (const file of files) {
      try {
        await add.mutateAsync({
          projectId: project.id,
          sampleId: r.id,
          file,
          sortOrder: order++,
          userId: user?.id ?? null,
        });
      } catch (err) {
        toast({
          title: "Photo not added",
          description: describeError(err),
          variant: "destructive",
        });
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }

  async function onRemove(photoId: string, path: string) {
    try {
      await remove.mutateAsync({
        projectId: project.id,
        photoId,
        storagePath: path,
      });
    } catch (err) {
      toast({
        title: "Photo not removed",
        description: describeError(err),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {r.photos.map((ph) => {
        const url = urls[ph.storage_path];
        return (
          <div
            key={ph.id}
            className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted"
          >
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
              </a>
            ) : (
              <div className="h-full w-full animate-pulse" />
            )}
            <button
              type="button"
              aria-label="Remove photo"
              onClick={() => void onRemove(ph.id, ph.storage_path)}
              className="absolute right-0.5 top-0.5 hidden rounded-full bg-background/80 p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      {Array.from({ length: busy }).map((_, i) => (
        <div key={`busy-${i}`} className="h-16 w-16 animate-pulse rounded-md border border-border bg-muted" />
      ))}
      <button
        type="button"
        aria-label="Add photo"
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex h-16 w-16 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:border-foreground/40 hover:text-foreground",
          missing ? "border-red-500 text-red-400" : "border-border",
        )}
      >
        <Plus className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e)}
      />
    </div>
  );
}
