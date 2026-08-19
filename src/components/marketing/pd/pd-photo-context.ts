/**
 * Signed photo URLs for the board's card covers. The board page resolves
 * every cover path in one batched call and provides the map; each card reads
 * its own. (Separate file: the React Compiler lint forbids non-component
 * exports next to components.)
 */
import { createContext, useContext } from "react";

export const PdPhotoUrlContext = createContext<Record<string, string>>({});

export function usePdPhotoUrl(path: string | null): string | null {
  const map = useContext(PdPhotoUrlContext);
  return path ? (map[path] ?? null) : null;
}
