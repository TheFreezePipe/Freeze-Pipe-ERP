/**
 * Scan feedback you can hear and feel (design §9.3, ResultFlash): short Web
 * Audio tones plus a vibration where the device has one. Browsers only let a
 * page play sound after a user gesture, so floor pages call
 * installFeedbackUnlock() once; the first tap or key press creates and
 * resumes the AudioContext (and plays a silent buffer, which is what iOS
 * Safari needs). Before that, playFeedback() still vibrates but stays silent.
 */

export type FeedbackTone = "ok" | "warn" | "fail";

export interface ToneStep {
  /** Hz */
  freq: number;
  /** Duration in milliseconds. */
  ms: number;
  type: OscillatorType;
}

/** Green: rising two-note chirp. Amber: two equal beeps. Red: one low buzz. */
export const TONES: Record<FeedbackTone, ToneStep[]> = {
  ok: [
    { freq: 1047, ms: 70, type: "sine" },
    { freq: 1568, ms: 120, type: "sine" },
  ],
  warn: [
    { freq: 740, ms: 110, type: "triangle" },
    { freq: 740, ms: 110, type: "triangle" },
  ],
  fail: [{ freq: 196, ms: 380, type: "square" }],
};

/** Vibration patterns (ms on, off, on…). */
export const VIBRATION: Record<FeedbackTone, number[]> = {
  ok: [40],
  warn: [70, 60, 70],
  fail: [220, 80, 220],
};

const GAP_MS = 45;
const VOLUME = 0.22;

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Create (once) and resume the AudioContext. Call from inside a user gesture. */
export function unlockFeedback(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    // A one-sample silent buffer unlocks output on iOS Safari.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // No audio on this device; vibration still works.
  }
}

/**
 * Unlock audio on the first pointer or key event. Returns a cleanup that
 * removes the listeners (they also remove themselves after the first event).
 */
export function installFeedbackUnlock(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const events = ["pointerdown", "touchend", "keydown"] as const;
  const handler = () => {
    unlockFeedback();
    remove();
  };
  function remove() {
    for (const e of events) target.removeEventListener(e, handler, true);
  }
  for (const e of events) target.addEventListener(e, handler, true);
  return remove;
}

/** Total length of a tone in milliseconds, gaps included. */
export function toneDuration(tone: FeedbackTone): number {
  const steps = TONES[tone];
  return steps.reduce((sum, s) => sum + s.ms, 0) + GAP_MS * Math.max(0, steps.length - 1);
}

/**
 * Play the tone for a scan result and vibrate. Returns true when a tone was
 * scheduled (false before the first gesture or on a device without Web Audio).
 */
export function playFeedback(tone: FeedbackTone): boolean {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(VIBRATION[tone]);
  } catch {
    // Some browsers throw when vibration is disallowed; sound still plays.
  }
  if (!ctx || ctx.state !== "running") return false;
  try {
    let at = ctx.currentTime + 0.01;
    for (const step of TONES[tone]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const end = at + step.ms / 1000;
      osc.type = step.type;
      osc.frequency.setValueAtTime(step.freq, at);
      // short attack and release so the tone does not click
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(VOLUME, at + 0.005);
      gain.gain.setValueAtTime(VOLUME, Math.max(at + 0.005, end - 0.02));
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(end + 0.01);
      at = end + GAP_MS / 1000;
    }
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the AudioContext. */
export function resetFeedbackForTests(): void {
  ctx = null;
}
