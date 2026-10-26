import { useCallback, useEffect, useState } from "react";
import { installFeedbackUnlock, playFeedback, type FeedbackTone } from "@/lib/warehouse/feedback";

export type FloorFlashTone = FeedbackTone;

export interface FloorFlashState {
  tone: FloorFlashTone;
  label?: string;
  /** Bumps on every flash so two identical results in a row both show. */
  id: number;
}

/** How long each flash stays up: amber and red carry a sentence worth reading. */
const FLASH_MS: Record<FloorFlashTone, number> = { ok: 800, warn: 1600, fail: 1400 };

/**
 * Full-screen scan feedback for the floor screens: `show(tone, label)` plays
 * the tone (src/lib/warehouse/feedback.ts) and raises a FloorFlash that clears
 * itself. Audio unlocks on the first tap or key press on the page.
 */
export function useFloorFlash() {
  const [flash, setFlash] = useState<FloorFlashState | null>(null);

  useEffect(() => installFeedbackUnlock(), []);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS[flash.tone]);
    return () => clearTimeout(timer);
  }, [flash]);

  const show = useCallback((tone: FloorFlashTone, label?: string) => {
    playFeedback(tone);
    setFlash((prev) => ({ tone, label, id: (prev?.id ?? 0) + 1 }));
  }, []);

  return { flash, show };
}
