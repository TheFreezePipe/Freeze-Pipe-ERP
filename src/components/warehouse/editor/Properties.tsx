import { Copy, Plus, RotateCw, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { WhLocationSummary } from "@/lib/hooks";
import { WH_ZONE_COLORS } from "@/lib/status-colors";
import {
  FACE_SIDES,
  FIXTURE_KINDS,
  FIXTURE_LABELS,
  RACK_ZONES,
  addFace,
  isNewId,
  patchFace,
  patchFixture,
  patchRack,
  rackCodes,
  rackStock,
  removeFace,
  type DraftLayout,
  type DraftTarget,
  type FaceRow,
} from "@/lib/warehouse/layout-draft";
import { pad2 } from "@/lib/warehouse/map-geometry";
import { cn } from "@/lib/utils";
import { Field, NativeSelect, NumberField, SelectField, TextField } from "./fields";

/**
 * Properties of the selected rack (code, template, bays, levels, position,
 * and every face: code, side, aisle, walk pass and direction, first bay,
 * zone by bay, pickable levels) or fixture (name, kind, zone, blocked,
 * linked location, size, position). Every change is one undo step.
 */

const ALL_ZONES = ["RTS", "RAW", "BOX", "WIP", "ACC", "MISC", "IN", "OUT", "MFG", "PACK", "SPARE"];

interface PropertiesProps {
  draft: DraftLayout;
  selected: DraftTarget | null;
  locations: WhLocationSummary[];
  onChange: (next: DraftLayout) => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2.5 border-t border-border/50 pt-3 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FaceCard({ face, draft, levels, bays, onChange }: { face: FaceRow; draft: DraftLayout; levels: number; bays: number; onChange: (d: DraftLayout) => void }) {
  const set = (patch: Parameters<typeof patchFace>[2]) => onChange(patchFace(draft, face.id, patch));
  const zones = Array.from({ length: bays }, (_, i) => face.zone_by_bay?.[i] ?? face.zone_by_bay?.[face.zone_by_bay.length - 1] ?? "MISC");
  return (
    <div className="space-y-2.5 rounded-md border border-border/70 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Face {face.face_code}</span>
        {isNewId(face.id) && (
          <Badge variant="outline" className="text-[10px] text-primary">
            new
          </Badge>
        )}
        {isNewId(face.id) ? (
          <Button type="button" size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove face ${face.face_code}`} onClick={() => onChange(removeFace(draft, face.id))}>
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <TextField label="Code" value={face.face_code} maxLength={2} onCommit={(v) => set({ face_code: v })} />
        <SelectField
          label="Side"
          value={face.side}
          noneLabel="—"
          options={FACE_SIDES.map((s) => ({ value: s, label: s }))}
          onChange={(v) => set({ side: v })}
        />
        <TextField label="Aisle" value={face.aisle ?? ""} maxLength={8} upper onCommit={(v) => set({ aisle: v || null })} />
        <NumberField label="Walk pass" value={face.walk_pass} min={0} max={99} onCommit={(v) => set({ walk_pass: v ?? 99 })} />
        <NumberField label="First bay" value={face.first_bay_no} min={1} max={99} onCommit={(v) => set({ first_bay_no: v ?? 1 })} />
      </div>
      <Field label="Walk direction (bay 01 is reached first)">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={face.walk_dir ?? "none"}
          onValueChange={(v) => v && set({ walk_dir: v === "none" ? null : v })}
          className="justify-start"
        >
          {["N", "S", "E", "W", "none"].map((d) => (
            <ToggleGroupItem key={d} value={d} className="h-7 min-w-8 px-2 text-xs data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
              {d === "none" ? "—" : d}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field label="Zone by bay">
        <div className="grid grid-cols-4 gap-1">
          {zones.map((z, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <span className="text-[10px] tabular-nums">bay {pad2(face.first_bay_no + i)}</span>
              <NativeSelect
                value={z}
                ariaLabel={`Zone of bay ${pad2(face.first_bay_no + i)}`}
                className={cn("h-7 px-1 text-xs", WH_ZONE_COLORS[z])}
                onChange={(v) => {
                  const next = [...zones];
                  next[i] = v;
                  set({ zone_by_bay: next });
                }}
              >
                {RACK_ZONES.map((zz) => (
                  <option key={zz} value={zz}>
                    {zz}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ))}
        </div>
      </Field>
      <Field label="Pickable levels (RTS and ACC; never an overflow level)">
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: levels }, (_, i) => i + 1).map((l) => (
            <span key={l} className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <Checkbox
                checked={face.pickable_levels.includes(l)}
                aria-label={`Level ${l} pickable`}
                onCheckedChange={(c) =>
                  set({
                    pickable_levels: c ? [...new Set([...face.pickable_levels, l])].sort((a, b) => a - b) : face.pickable_levels.filter((x) => x !== l),
                  })
                }
              />
              {l}
            </span>
          ))}
        </div>
      </Field>
    </div>
  );
}

export function Properties({ draft, selected, locations, onChange, onRotate, onDuplicate, onRemove }: PropertiesProps) {
  const rack = selected?.type === "rack" ? draft.racks.find((r) => r.id === selected.id && r.active) : undefined;
  const fixture = selected?.type === "fixture" ? draft.fixtures.find((f) => f.id === selected.id && !f._deleted) : undefined;

  const actions = (
    <div className="flex flex-wrap gap-1.5">
      <Button type="button" size="sm" variant="outline" onClick={onRotate}>
        <RotateCw className="mr-1 h-3.5 w-3.5" /> Rotate 90°
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onDuplicate}>
        <Copy className="mr-1 h-3.5 w-3.5" /> Duplicate
      </Button>
    </div>
  );

  if (rack) {
    const faces = draft.faces.filter((f) => f.rack_id === rack.id);
    const tpl = draft.templates.find((t) => t.id === rack.template_id);
    const stock = isNewId(rack.id) ? { units: 0, cartons: 0, locations: 0 } : rackStock(locations, rack.id);
    const codes = rackCodes(draft, rack.id);
    const set = (patch: Parameters<typeof patchRack>[2]) => onChange(patchRack(draft, rack.id, patch));
    return (
      <div className="flex flex-col gap-3 p-3">
        <Section
          title="Rack"
          aside={
            isNewId(rack.id) ? (
              <Badge variant="outline" className="text-[10px] text-primary">
                new
              </Badge>
            ) : null
          }
        >
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold">{rack.code}</span>
            {tpl && <span className="text-xs text-muted-foreground">{tpl.name}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <TextField label="Code" value={rack.code} upper maxLength={16} onCommit={(v) => set({ code: v })} />
            <SelectField
              label="Template"
              value={rack.template_id}
              options={draft.templates.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))}
              onChange={(v) => v && set({ template_id: v })}
            />
            <TextField label="Description" value={rack.description ?? ""} className="col-span-2" onCommit={(v) => set({ description: v || null })} />
            <NumberField label="Bays" value={rack.bays} min={1} max={99} onCommit={(v) => set({ bays: v ?? rack.bays })} />
            <NumberField label="Levels" value={rack.levels} min={1} max={9} onCommit={(v) => set({ levels: v ?? rack.levels })} />
            <NumberField label="X" suffix="mm" step={100} value={rack.x_mm} onCommit={(v) => set({ x_mm: v ?? rack.x_mm })} />
            <NumberField label="Y" suffix="mm" step={100} value={rack.y_mm} onCommit={(v) => set({ y_mm: v ?? rack.y_mm })} />
            <NumberField label="Length" suffix="mm" step={10} min={100} nullable value={rack.width_mm} onCommit={(v) => set({ width_mm: v })} />
            <NumberField label="Depth" suffix="mm" step={10} min={50} nullable value={rack.depth_mm} onCommit={(v) => set({ depth_mm: v })} />
          </div>
          <p className="text-xs text-muted-foreground">
            Rotation {rack.rot_deg}° · bays run {rack.rot_deg === 90 || rack.rot_deg === 270 ? "north–south" : "east–west"}
          </p>
          {actions}
        </Section>

        <Section
          title={`Faces (${faces.length})`}
          aside={
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => onChange(addFace(draft, rack.id))}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add face
            </Button>
          }
        >
          {faces.length === 0 && <p className="text-xs text-amber-400">No face: this rack generates no locations.</p>}
          {faces.map((f) => (
            <FaceCard key={f.id} face={f} draft={draft} levels={rack.levels} bays={rack.bays} onChange={onChange} />
          ))}
          <p className="text-[11px] text-muted-foreground">Saved faces cannot be removed here (the layout RPC has no face delete); unsaved ones can.</p>
        </Section>

        <Section title="Codes this rack generates">
          {codes.map((c) => (
            <p key={c.faceId} className="text-xs tabular-nums">
              <span className="font-medium">{c.first}</span> … <span className="font-medium">{c.last}</span>{" "}
              <span className="text-muted-foreground">({c.count} locations)</span>
            </p>
          ))}
          <p className="text-[11px] text-muted-foreground">After saving, Preview locations shows what the generator would create, move or deactivate.</p>
        </Section>

        <Section title="Remove">
          {stock.locations > 0 ? (
            <p className="text-xs text-amber-400">
              {rack.code} still holds {stock.units.toLocaleString()} units in {stock.locations} location{stock.locations === 1 ? "" : "s"}
              {stock.cartons ? ` (${stock.cartons} cartons)` : ""}. Move or count it out before removing the rack.
            </p>
          ) : null}
          <Button type="button" size="sm" variant="outline" className="text-red-400" disabled={stock.locations > 0} onClick={onRemove}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove rack (empty only)
          </Button>
          {!isNewId(rack.id) && (
            <p className="text-[11px] text-muted-foreground">
              Saved as inactive; applying the generator then deactivates its locations, and refuses any that hold stock by then.
            </p>
          )}
        </Section>
      </div>
    );
  }

  if (fixture) {
    const set = (patch: Parameters<typeof patchFixture>[2]) => onChange(patchFixture(draft, fixture.id, patch));
    const named = locations.filter((l) => l.kind !== "bay_level" && l.kind !== "virtual" && l.active !== false && l.id);
    return (
      <div className="flex flex-col gap-3 p-3">
        <Section
          title="Fixture"
          aside={
            isNewId(fixture.id) ? (
              <Badge variant="outline" className="text-[10px] text-primary">
                new
              </Badge>
            ) : null
          }
        >
          <TextField label="Name" value={fixture.name} maxLength={80} onCommit={(v) => set({ name: v })} />
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Kind"
              value={fixture.kind}
              options={FIXTURE_KINDS.map((k) => ({ value: k, label: FIXTURE_LABELS[k] }))}
              onChange={(v) => v && set({ kind: v })}
            />
            <SelectField label="Zone" value={fixture.zone} noneLabel="—" options={ALL_ZONES.map((z) => ({ value: z, label: z }))} onChange={(v) => set({ zone: v })} />
            <SelectField
              label="Linked location"
              className="col-span-2"
              value={fixture.location_id}
              noneLabel="None"
              options={named.map((l) => ({ value: l.id as string, label: `${l.code}${l.name ? ` · ${l.name}` : ""}` }))}
              onChange={(v) => set({ location_id: v })}
            />
            <NumberField label="Width" suffix="mm" step={10} min={50} nullable value={fixture.width_mm} onCommit={(v) => set({ width_mm: v })} />
            <NumberField label="Depth" suffix="mm" step={10} min={50} nullable value={fixture.depth_mm} onCommit={(v) => set({ depth_mm: v })} />
            <NumberField label="X" suffix="mm" step={100} value={fixture.x_mm} onCommit={(v) => set({ x_mm: v ?? fixture.x_mm })} />
            <NumberField label="Y" suffix="mm" step={100} value={fixture.y_mm} onCommit={(v) => set({ y_mm: v ?? fixture.y_mm })} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2 text-sm">
            <span>
              Blocked
              <span className="block text-[11px] text-muted-foreground">Phase 2 routing keeps carts away from it.</span>
            </span>
            <Switch checked={fixture.blocked} onCheckedChange={(c) => set({ blocked: c })} aria-label="Blocked" />
          </label>
          <p className="text-xs text-muted-foreground">Rotation {fixture.rot_deg}°</p>
          {actions}
        </Section>
        <Section title="Remove">
          <Button type="button" size="sm" variant="outline" className="text-red-400" onClick={onRemove}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove fixture
          </Button>
        </Section>
      </div>
    );
  }

  const activeRacks = draft.racks.filter((r) => r.active);
  return (
    <div className="flex flex-col gap-3 p-3 text-sm text-muted-foreground">
      <p>Select a rack or fixture on the plan to edit it, or drag a template or fixture in from the palette.</p>
      <p className="text-xs">
        {activeRacks.length} racks · {draft.faces.filter((f) => activeRacks.some((r) => r.id === f.rack_id)).length} faces ·{" "}
        {draft.fixtures.filter((f) => !f._deleted).length} fixtures
      </p>
      <p className="text-xs">
        Changes stay on this screen until Save layout, which sends them in one go; anyone else's save in between shows as a conflict.
      </p>
    </div>
  );
}
