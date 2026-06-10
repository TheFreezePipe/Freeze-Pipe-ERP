import { useCallback, useState, type ReactNode } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared click-to-sort plumbing for data tables.
 *
 * Usage:
 *   const { sort, toggleSort } = useTableSort();
 *   const sorted = applySort(rows, sort, {
 *     sku: (r) => r.product.sku,
 *     demand: (r) => r.demand,
 *   });
 *   <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort}>SKU</SortableTh>
 *
 * Click cycle per column: ascending → descending → back to the page's
 * default order (sort === null). Null/undefined values always sort last
 * regardless of direction, so "no data" rows don't pollute the top.
 */

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export function useTableSort() {
  const [sort, setSort] = useState<SortState | null>(null);
  const toggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  return { sort, toggleSort };
}

export type SortAccessor<Row> = (row: Row) => string | number | null | undefined;

export function applySort<Row>(
  rows: readonly Row[],
  sort: SortState | null,
  accessors: Record<string, SortAccessor<Row>>,
): Row[] {
  if (!sort) return [...rows];
  const acc = accessors[sort.key];
  if (!acc) return [...rows];
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = acc(a);
    const vb = acc(b);
    const aNull = va === null || va === undefined || (typeof va === "number" && Number.isNaN(va));
    const bNull = vb === null || vb === undefined || (typeof vb === "number" && Number.isNaN(vb));
    if (aNull && bNull) return 0;
    if (aNull) return 1; // nulls last, both directions
    if (bNull) return -1;
    if (typeof va === "string" || typeof vb === "string") {
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * mul;
    }
    return ((va as number) - (vb as number)) * mul;
  });
}

interface SortableThProps {
  sortKey: string;
  sort: SortState | null;
  onToggle: (key: string) => void;
  children: ReactNode;
  className?: string;
  title?: string;
  colSpan?: number;
}

export function SortableTh({
  sortKey,
  sort,
  onToggle,
  children,
  className,
  title,
  colSpan,
}: SortableThProps) {
  const active = sort?.key === sortKey;
  return (
    <th
      className={cn("cursor-pointer select-none transition-colors hover:text-foreground", className)}
      onClick={() => onToggle(sortKey)}
      title={title ?? "Click to sort"}
      colSpan={colSpan}
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          sort!.dir === "asc" ? (
            <ArrowUp className="h-3 w-3 shrink-0" />
          ) : (
            <ArrowDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0 opacity-30" />
        )}
      </span>
    </th>
  );
}
