/**
 * URL-backed filter state helpers.
 *
 * Thin wrapper around react-router's useSearchParams that gives each
 * page a simple per-filter setter + getter with the following behavior:
 *
 *   - Default values are NOT serialized to the URL (keeps the URL short)
 *   - Empty strings and the literal default are considered "default"
 *   - Updates use `setSearchParams({ replace: true })` to avoid
 *     polluting the browser history with every keystroke
 *
 * Example:
 *   const [category, setCategory] = useUrlFilter("category", "all");
 *   // reading category → "all" when URL has no ?category=
 *   // setCategory("Pipes") → URL becomes ?category=Pipes
 *   // setCategory("all")   → URL parameter removed
 */

import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export function useUrlFilter<T extends string>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = (raw ?? defaultValue) as T;

  const setValue = useCallback((next: T) => {
    setParams(
      prev => {
        const sp = new URLSearchParams(prev);
        if (next === defaultValue || next === "" || next == null) {
          sp.delete(key);
        } else {
          sp.set(key, String(next));
        }
        return sp;
      },
      { replace: true },
    );
  }, [key, defaultValue, setParams]);

  return [value, setValue];
}

/** Boolean URL filter. `true` serialized as "1"; false is omitted. */
export function useUrlBoolFilter(
  key: string,
  defaultValue = false,
): [boolean, (next: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw === null ? defaultValue : raw === "1" || raw === "true";

  const setValue = useCallback((next: boolean) => {
    setParams(
      prev => {
        const sp = new URLSearchParams(prev);
        if (next === defaultValue) {
          sp.delete(key);
        } else {
          sp.set(key, next ? "1" : "0");
        }
        return sp;
      },
      { replace: true },
    );
  }, [key, defaultValue, setParams]);

  return [value, setValue];
}

/** Reset a list of URL filter keys back to their defaults (remove from URL). */
export function useUrlFilterReset(keys: string[]): () => void {
  const [, setParams] = useSearchParams();
  return useCallback(() => {
    setParams(
      prev => {
        const sp = new URLSearchParams(prev);
        for (const k of keys) sp.delete(k);
        return sp;
      },
      { replace: true },
    );
  }, [keys, setParams]);
}
