import { Fragment } from "react";
import { bayParts } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";

type LocationCodeSize = "hero" | "large" | "small";

interface LocationCodeProps {
  /** A bay-level code (02-01-3) or a named one (IN-01, SPARES-01). */
  code: string | null | undefined;
  /** hero 56 px (the putaway target), large 40 px (the task shell's minimum), small inline. */
  size?: LocationCodeSize;
  /**
   * The words line under the code: true for "Face 02 · Bay 01 · Level 3"
   * (bay-levels only), or a string for a named location ("Inbound staging").
   */
  words?: boolean | string | null;
  /** Show "Overflow" after the words (level 3 of a pallet rack). */
  overflow?: boolean;
  className?: string;
}

const CODE_CLASS: Record<LocationCodeSize, string> = {
  hero: "text-[56px] font-extrabold leading-[1.05] tracking-wide",
  large: "text-[40px] font-bold leading-tight tracking-wide",
  small: "text-base font-semibold",
};

const WORDS_CLASS: Record<LocationCodeSize, string> = {
  hero: "mt-1.5 gap-x-3.5 text-sm",
  large: "mt-1 gap-x-3 text-sm",
  small: "gap-x-2 text-xs",
};

/**
 * A location code set for reading at arm's length (design §9.3): tabular
 * digits, faint dashes between face, bay and level, and optionally the
 * label's words line. Named codes render as they are.
 */
export function LocationCode({ code, size = "small", words = false, overflow = false, className }: LocationCodeProps) {
  const parts = bayParts(code);
  const value = code?.trim() || "—";

  return (
    <span className={cn("inline-flex flex-col", size !== "small" && "items-center", className)}>
      <span className={cn("whitespace-nowrap tabular-nums", CODE_CLASS[size])} aria-label={value}>
        {parts
          ? [parts.face, parts.bay, parts.level].map((seg, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="px-[0.04em] text-muted-foreground/60">-</span>}
                <span>{seg}</span>
              </Fragment>
            ))
          : value}
      </span>
      {words && (
        <span className={cn("flex flex-wrap justify-center text-muted-foreground", WORDS_CLASS[size])}>
          {parts && words === true ? (
            <>
              <span>
                Face <b className="font-semibold text-foreground/90 tabular-nums">{parts.face}</b>
              </span>
              <span>
                Bay <b className="font-semibold text-foreground/90 tabular-nums">{parts.bay}</b>
              </span>
              <span>
                Level <b className="font-semibold text-foreground/90 tabular-nums">{parts.level}</b>
              </span>
            </>
          ) : typeof words === "string" ? (
            <span>{words}</span>
          ) : null}
          {overflow && <span className="font-semibold text-amber-400">Overflow</span>}
        </span>
      )}
    </span>
  );
}
