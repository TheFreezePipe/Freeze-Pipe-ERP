import { Fragment } from "react";
import { F } from "@/lib/marketing/sale-format";
import { CODE_KIND, COLUMN_DEF, OFFER_STATUS, RUNWAY } from "@/lib/marketing/sale-labels";
import { judge, type SaleMetrics } from "@/lib/marketing/sale-metrics";
import { Chip, ChipFrom, ExpandCell, ModuleCard, Pair, Pin, PinRow, Skeleton, Th } from "./sale-ui";
import { NONE, TD, colgroup } from "./sale-tokens";

interface Props {
  M: SaleMetrics;
  loading?: boolean;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

/** Offers: one row per offer, its code's redemptions and discount dollars from the ShipStation lines, structure facts per format. */
export function OffersTable({ M, loading, open, onToggle }: Props) {
  const Fu = M.G.full;
  const promoted = M.products.filter((p) => p.role === "member");
  const promotedUnits = promoted.reduce((s, p) => s + p.units, 0);
  const promotedBase = promoted.reduce((s, p) => s + p.base, 0);
  const storeUnits = Fu.A.units;
  const storeBase = Fu.B.units;
  const strip = [
    <>Orders (distinct) <b>{Fu.done ? F.int(Fu.A.orders) : "—"}</b></>,
    promoted.length ? <>Promoted units <Pin j={judge(Fu.done ? promotedUnits : null, promotedBase)} /></> : <>Promoted units <Pin j={Fu.lift.units} /> <span>sitewide</span></>,
    promoted.length ? <>Non-promoted <Pin j={judge(Fu.done ? storeUnits - promotedUnits : null, storeBase - promotedBase)} /></> : null,
    <>Store units <Pin j={judge(Fu.done ? storeUnits : null, storeBase)} /></>,
    Fu.done && M.margin.saleDisc > 0 ? <>Sale codes <b>{F.money(M.margin.saleDisc)}</b> · {F.int(Fu.A.codeOrders)} orders</> : null,
  ];
  const otherCodes = M.codes.filter((c) => c.kind !== "sale" && c.orders > 0).slice(0, 8);

  return (
    <ModuleCard
      id="offers"
      title={"Offers" + (M.live ? " to date" : "")}
      right={<Chip tone="k" label="Codes · ShipStation lines" tip="Discount lines ShipStation receives with each order; operational adjustments are classified apart." />}
      strip={strip}
    >
      {loading ? (
        <Skeleton h={200} rows={4} />
      ) : (
        <table className="w-full table-fixed text-[13px]">
          {colgroup([24, 240, 110, 100, 130, 100, 100, "auto"])}
          <thead>
            <tr>
              <th />
              <Th>Offer</Th>
              <Th>Status</Th>
              <Th right tip={COLUMN_DEF["Promoted units"]}>Promoted units</Th>
              <Th right tip={COLUMN_DEF["Δ Base"]}>Δ Base</Th>
              <Th right tip={COLUMN_DEF.Redemptions}>Redemptions</Th>
              <Th right tip={COLUMN_DEF["Discount $"]}>Discount $</Th>
              <Th>Structure</Th>
            </tr>
          </thead>
          <tbody>
            {M.offers.map((o) => {
              const id = "offer:" + o.id;
              const isOpen = open.has(id);
              const skus = M.products.filter((p) => o.skuIds.includes(p.skuId));
              return (
                <Fragment key={o.id}>
                  <tr className="h-10 border-t border-border/40">
                    <ExpandCell open={isOpen} onToggle={() => onToggle(id)} has={skus.length > 0} label={"SKUs of " + o.label} />
                    <td className={TD + " h-10"}>
                      <div className="truncate font-semibold">{o.label}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{o.kind}</div>
                    </td>
                    <td className={TD}><ChipFrom def={OFFER_STATUS[o.status]} /></td>
                    <td className={TD + " text-right"}>{M.upcoming ? NONE : <Pair a={o.unitsA} b={o.unitsB} />}</td>
                    <td className={TD + " text-right"}>{M.upcoming ? NONE : <PinRow j={o.units} />}</td>
                    <td className={TD + " text-right tabular-nums"}>{o.redemptions == null ? (o.code ? NONE : <span className="text-xs text-muted-foreground">no code</span>) : F.int(o.redemptions)}</td>
                    <td className={TD + " text-right tabular-nums"}>
                      {o.discount == null ? NONE : (
                        <span>
                          {F.cell(o.discount)}
                          {o.giftSkuId && o.redemptions ? <span className="ml-1 text-[11px] text-muted-foreground">{F.dec2(o.discount / o.redemptions)} / order</span> : null}
                        </span>
                      )}
                    </td>
                    <td className={TD + " truncate text-xs"}>
                      {o.structure.map(([k, v], i) => (
                        <span key={k}>
                          {i ? <span className="mx-1.5 text-muted-foreground/60">·</span> : null}
                          <span className="text-muted-foreground">{k}</span> {v}
                        </span>
                      ))}
                    </td>
                  </tr>
                  {isOpen
                    ? skus.map((p) => (
                        <tr key={p.skuId} className="border-t border-border/30 bg-background/30">
                          <td />
                          <td className={TD + " pl-8"}>
                            <span className="font-mono text-xs">{p.sku}</span>
                            <span className="ml-2 text-[11.5px] text-muted-foreground">{p.role}</span>
                          </td>
                          <td className={TD}><ChipFrom def={RUNWAY[p.runway]} /></td>
                          <td className={TD + " text-right"}>{M.upcoming ? NONE : <Pair a={p.units} b={p.base} />}</td>
                          <td className={TD + " text-right"}>{M.upcoming ? NONE : <PinRow j={p.judged} />}</td>
                          <td className={TD} colSpan={2} />
                          <td className={TD + " text-xs text-muted-foreground"}>
                            Finished {F.cell(p.finished)} · raw {F.cell(p.raw)} · {F.rate(M.upcoming ? p.planRate : p.rate)}/d{M.upcoming ? " plan" : ""}
                          </td>
                        </tr>
                      ))
                    : null}
                </Fragment>
              );
            })}
            {otherCodes.length ? (
              <tr className="border-t border-border/40 bg-background/30">
                <td />
                <td className={TD + " text-xs text-muted-foreground"} colSpan={7}>
                  Other codes in the window:{" "}
                  {otherCodes.map((c, i) => (
                    <span key={c.code}>
                      {i ? " · " : ""}
                      <span className="font-mono">{c.code}</span> {F.int(c.orders)} <span className="text-muted-foreground/70">({CODE_KIND[c.kind].toLowerCase()})</span>
                    </span>
                  ))}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </ModuleCard>
  );
}
