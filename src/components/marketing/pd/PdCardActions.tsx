/**
 * Product Development — the two card-level actions the one-product-one-row
 * rules added (admin / manager; the RPCs enforce the same rule):
 *
 *  Link existing SKU  a card with no SKU takes an existing product
 *                     (rpc_pd_link_sku). On its launch, a plain row for that
 *                     SKU merges into the card's row.
 *  Mark arrived       an Ordered card is filed as arrived by hand
 *                     (rpc_pd_mark_arrived): off the board, still on its
 *                     launch as an Arrived product, dates frozen. The confirm
 *                     lists what changes, row by row.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { PD_STAGE_LABEL, followsLaunch, pdStageLabel } from "@/lib/marketing/pd";
import { MEMBER_STATE_LABEL } from "@/lib/marketing/launch-link";
import { useLinkSku, useMarkArrived, usePdSkuOwners, type PdLinkSkuMember, type PdProjectWithRefs } from "@/lib/hooks/use-pd";
import { useProducts } from "@/lib/hooks/use-products";
import { StageChip } from "@/components/marketing/LaunchLinkParts";
import { fmtDate } from "./pd-field-utils";

// ---------------------------------------------------------------------------
// Link existing SKU
// ---------------------------------------------------------------------------

/** What rpc_pd_link_sku did on the card's launch, in plain words (toast line). */
const LINK_SKU_MEMBER_LABEL: Readonly<Record<PdLinkSkuMember, string | null>> = {
  merged: "Merged with the SKU's line on the launch",
  placeholder_promoted: "Launch line now carries the SKU",
  kept: "Launch line kept",
  none: null,
};

export interface PdLinkSkuDialogProps {
  project: PdProjectWithRefs;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PdLinkSkuDialog({ project, open, onOpenChange }: PdLinkSkuDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link existing SKU</DialogTitle>
          <DialogDescription className="sr-only">{project.name}</DialogDescription>
        </DialogHeader>
        {/* Mounted while open (DialogContent unmounts on close), so every open starts fresh. */}
        <LinkSkuBody project={project} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function LinkSkuBody({ project, close }: { project: PdProjectWithRefs; close: () => void }) {
  const { data: products = [] } = useProducts();
  const { data: owners = [] } = usePdSkuOwners();
  const link = useLinkSku();
  const [query, setQuery] = useState(() => project.sku_code?.trim() ?? "");
  const [skuId, setSkuId] = useState<string | null>(null);

  // A SKU any other card already owns — live or archived (arrived cards keep
  // theirs) — cannot be taken (sku_owned_by_other_card): shown greyed with that card's name.
  const ownedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of owners) if (c.id !== project.id) m.set(c.linked_sku_id, c.name);
    return m;
  }, [owners, project.id]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      products
        .filter((p) => p.is_active)
        .filter((p) => !q || p.sku.toLowerCase().includes(q) || p.product_name.toLowerCase().includes(q))
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .slice(0, 60),
    [products, q],
  );
  const picked = skuId ? products.find((p) => p.id === skuId) ?? null : null;

  async function go() {
    if (!skuId || link.isPending) return;
    try {
      const res = await link.mutateAsync({ projectId: project.id, skuId });
      toast({ title: `Linked ${res.sku}`, description: LINK_SKU_MEMBER_LABEL[res.member] ?? undefined });
      close();
    } catch (e) {
      toast({ title: "Not linked", description: describeError(e), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-3">
      <Input
        autoFocus
        value={query}
        placeholder="SKU or product name"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length === 1 && !ownedBy.has(matches[0].id)) setSkuId(matches[0].id);
        }}
        className="h-8 text-sm"
      />
      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        {matches.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">—</div>}
        {matches.map((p) => {
          const owner = ownedBy.get(p.id) ?? null;
          const on = p.id === skuId;
          return (
            <button
              key={p.id}
              type="button"
              disabled={!!owner}
              onClick={() => setSkuId(p.id)}
              aria-pressed={on}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
                on && "bg-accent",
              )}
            >
              <span className="font-mono text-xs">{p.sku}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.product_name}</span>
              {owner && <StageChip label={owner} />}
              {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={link.isPending}>
          Cancel
        </Button>
        <Button disabled={!picked || link.isPending} onClick={() => void go()}>
          {link.isPending ? "Linking…" : picked ? `Link ${picked.sku}` : "Link"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mark arrived
// ---------------------------------------------------------------------------

export interface PdMarkArrivedDialogProps {
  project: PdProjectWithRefs;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the card is filed (it leaves the board). */
  onDone?: () => void;
}

export function PdMarkArrivedDialog({ project, open, onOpenChange, onDone }: PdMarkArrivedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark arrived</DialogTitle>
          <DialogDescription>{project.name}</DialogDescription>
        </DialogHeader>
        <MarkArrivedBody project={project} close={() => onOpenChange(false)} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}

function MarkArrivedBody({ project: p, close, onDone }: { project: PdProjectWithRefs; close: () => void; onDone?: () => void }) {
  const mark = useMarkArrived();
  const [note, setNote] = useState("");
  const launch = p.linked_launch_id ? p.launch : null;
  const following = !!launch && followsLaunch(p);
  const target = p.target_launch_date ?? launch?.launch_date ?? null;

  async function go() {
    if (mark.isPending) return;
    try {
      await mark.mutateAsync({ projectId: p.id, note: note.trim() || null });
      toast({ title: "Marked arrived" });
      close();
      onDone?.();
    } catch (e) {
      toast({ title: "Not marked", description: describeError(e), variant: "destructive" });
    }
  }

  const rows: { label: string; now: ReactNode; after: ReactNode }[] = [
    {
      label: "Card",
      now: <StageChip label={pdStageLabel(p.stage)} />,
      after: <StageChip label={MEMBER_STATE_LABEL.arrived} />,
    },
    { label: "Board", now: `${PD_STAGE_LABEL.ordered} lane`, after: "Off the board" },
  ];
  if (launch) {
    rows.push({ label: "Launch", now: launch.name, after: launch.name });
    rows.push({
      label: "Date",
      now: `${fmtDate(target)}${following ? " · follows launch" : ""}`,
      after: `${fmtDate(target)} · frozen`,
    });
  } else if (target) {
    rows.push({ label: "Date", now: fmtDate(target), after: `${fmtDate(target)} · frozen` });
  }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-1.5 pr-2 font-semibold" />
            <th className="pb-1.5 pr-2 font-semibold">Now</th>
            <th className="pb-1.5 font-semibold">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border align-middle">
              <td className="py-1.5 pr-2 text-xs text-muted-foreground">{r.label}</td>
              <td className="py-1.5 pr-2 tabular-nums">{r.now}</td>
              <td className="py-1.5 tabular-nums">{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1.5">
        <Label className="text-xs">Note</Label>
        <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-8 text-sm" />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={mark.isPending}>
          Cancel
        </Button>
        <Button disabled={mark.isPending} onClick={() => void go()}>
          {mark.isPending ? "Marking…" : "Mark arrived"}
        </Button>
      </DialogFooter>
    </div>
  );
}
