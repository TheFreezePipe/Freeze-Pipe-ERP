import { useSyncExternalStore } from "react";
import { Layout } from "./Layout";
import { TaskShell } from "./TaskShell";

/** Tailwind's md breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/**
 * Layout route for every /go screen (design §9.2), inside RequireAuth: the
 * normal Layout from the md breakpoint up, and below it the task-mode shell
 * (44 px top bar, h-dvh column, safe-area action footer). Crossing the
 * breakpoint swaps the shell, which remounts the page.
 */
export function GoLayout() {
  const desktop = useSyncExternalStore(subscribe, isDesktop, () => true);
  return desktop ? <Layout /> : <TaskShell />;
}
