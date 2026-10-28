import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cartonPath } from "@/lib/inventory-routes";
import { cn } from "@/lib/utils";

interface CartonLinkProps {
  /** The carton's code (its LPN), e.g. C-466-007R1. */
  code: string;
  className?: string;
  /** Custom link text; the code itself when left out. */
  children?: ReactNode;
  title?: string;
  /** Runs on click after the click is stopped at the link (e.g. to close a dialog). */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Open the passport in a new tab, for task screens whose progress lives
   * only in the page (a count being scanned, a relabel being planned), so
   * following the link never throws that work away.
   */
  newTab?: boolean;
}

/**
 * A carton code as a link to its passport (owner decision 2026-10-28: the
 * passport is reached by clicking a carton code wherever one is shown, not
 * from the navigation). Mono with tabular digits like every code; a dotted
 * underline marks it as a link without painting whole tables blue (phones
 * have no hover). The click stops at the link, so a code inside a clickable
 * row opens the passport without also firing the row.
 */
export function CartonLink({ code, className, children, title, onClick, newTab = false }: CartonLinkProps) {
  return (
    <Link
      to={cartonPath(code)}
      title={title ?? `Carton passport: ${code}`}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener noreferrer" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      className={cn(
        "font-mono tabular-nums underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px]",
        "hover:text-primary hover:decoration-solid hover:decoration-primary",
        "focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children ?? code}
    </Link>
  );
}
