import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ArrowLeft, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { StationChip } from "@/components/warehouse/StationChip";
import { EnvBanner } from "./EnvBanner";
import { Sidebar } from "./Sidebar";
import { cn } from "@/lib/utils";

/**
 * Task-mode shell for the /go floor screens on a phone (design §9.2): a 44 px
 * top bar (exit, title, progress such as "3 of 12", the station chip), an
 * h-dvh column and a bottom action area padded by the safe-area inset.
 * Targets are at least 52 px, primary actions 56 px, location codes 40 px,
 * and nothing asks for typing: a paired scanner hides the iPhone keyboard.
 *
 * Pages talk to it through components, so the same page also renders under
 * the normal Layout from the md breakpoint up ("page" mode):
 *   <TaskHeader>   the title, progress and a right-hand slot (the ScanSink);
 *                  in the shell they move into the top bar.
 *   <TaskActions>  the bottom action area; in the shell it is portalled into
 *                  the safe-area footer, otherwise rendered in place.
 *   <PageModeOnly> content shown only outside the shell.
 */

interface Slots {
  left: HTMLElement | null;
  title: HTMLElement | null;
  right: HTMLElement | null;
  footer: HTMLElement | null;
}

interface TaskShellContextValue {
  mode: "task" | "page";
  slots: Slots;
  /** A TaskHeader is mounted: hide the default exit and title. Returns the release. */
  claimHeader: () => () => void;
}

const NO_SLOTS: Slots = { left: null, title: null, right: null, footer: null };
const PAGE_MODE: TaskShellContextValue = { mode: "page", slots: NO_SLOTS, claimHeader: () => () => undefined };

const TaskShellContext = createContext<TaskShellContextValue>(PAGE_MODE);

/** Default top-bar titles for /go routes whose page sets none. */
const ROUTE_TITLES: Record<string, string> = {
  "/go": "Floor",
  "/go/lookup": "Look up",
  "/go/putaway": "Put away",
};

export function TaskShell() {
  const { pathname } = useLocation();
  const [left, setLeft] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const claimHeader = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);

  const value = useMemo<TaskShellContextValue>(
    () => ({ mode: "task", slots: { left, title, right, footer }, claimHeader }),
    [left, title, right, footer, claimHeader],
  );

  const isHome = pathname === "/go" || pathname === "/go/";
  const claimed = claims > 0;

  return (
    <TaskShellContext.Provider value={value}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background pt-safe pl-safe pr-safe">
        <EnvBanner />
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1">
          <div className="flex shrink-0 items-center">
            {!claimed &&
              (isHome ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 touch-manipulation"
                  onClick={() => setMenuOpen(true)}
                  aria-label="Menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              ) : (
                <ExitButton to="/go" />
              ))}
            <div ref={setLeft} className="contents" />
          </div>
          <div className="min-w-0 flex-1 text-center">
            {!claimed && <p className="truncate text-sm font-semibold">{ROUTE_TITLES[pathname] ?? "Floor"}</p>}
            <div ref={setTitle} className="contents" />
          </div>
          <div ref={setRight} className="flex shrink-0 items-center empty:hidden" />
          <StationChip compact />
        </header>

        <main className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <ErrorBoundary key={pathname} fallbackContext={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <div
          ref={setFooter}
          className="shrink-0 space-y-2 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] empty:hidden"
        />
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-60 p-0 pt-safe">
          <Sidebar collapsed={false} onNavClick={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>
    </TaskShellContext.Provider>
  );
}

function ExitButton({ to, label = "Exit" }: { to: string; label?: string }) {
  return (
    <Button asChild variant="ghost" size="icon" className="h-11 w-11 touch-manipulation">
      <Link to={to} aria-label={label}>
        <X className="h-5 w-5" />
      </Link>
    </Button>
  );
}

interface TaskHeaderProps {
  title: string;
  /** "3 of 12", "14 open". */
  progress?: ReactNode;
  /** Where exit (task mode) and back (page mode) go. */
  exitTo?: string;
  /** Right-hand slot, usually the ScanSink. */
  right?: ReactNode;
}

/**
 * The page's title row. In the task shell its parts are portalled into the
 * top bar; under the normal Layout it renders a back arrow, the title, the
 * progress and the right-hand slot in place.
 */
export function TaskHeader({ title, progress, exitTo = "/go", right }: TaskHeaderProps) {
  const { mode, slots, claimHeader } = useContext(TaskShellContext);
  useEffect(() => (mode === "task" ? claimHeader() : undefined), [mode, claimHeader]);

  if (mode === "task") {
    return (
      <>
        {slots.left && createPortal(<ExitButton to={exitTo} />, slots.left)}
        {slots.title &&
          createPortal(
            <div className="min-w-0 leading-tight">
              <p className={cn("truncate font-semibold", progress != null ? "text-xs text-muted-foreground" : "text-sm")}>
                {title}
              </p>
              {progress != null && <p className="truncate text-[15px] font-bold tabular-nums">{progress}</p>}
            </div>,
            slots.title,
          )}
        {slots.right && right != null && createPortal(right, slots.right)}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="ghost" size="icon" className="h-10 w-10 shrink-0 touch-manipulation">
        <Link to={exitTo} aria-label="Back to floor">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </Button>
      <h1 className="flex-1 text-2xl font-bold">{title}</h1>
      {progress != null && <span className="text-sm font-semibold tabular-nums text-muted-foreground">{progress}</span>}
      {right}
    </div>
  );
}

/** The bottom action area: the shell's safe-area footer on a phone, in place otherwise. */
export function TaskActions({ children, className }: { children: ReactNode; className?: string }) {
  const { mode, slots } = useContext(TaskShellContext);
  if (mode === "task") {
    return slots.footer ? createPortal(<div className={cn("space-y-2", className)}>{children}</div>, slots.footer) : null;
  }
  return <div className={cn("space-y-2", className)}>{children}</div>;
}

/** Rendered only outside the task shell (the md-and-up Layout). */
export function PageModeOnly({ children }: { children: ReactNode }) {
  const { mode } = useContext(TaskShellContext);
  return mode === "page" ? <>{children}</> : null;
}
