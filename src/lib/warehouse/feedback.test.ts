import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFeedbackUnlock,
  playFeedback,
  resetFeedbackForTests,
  TONES,
  toneDuration,
  unlockFeedback,
  VIBRATION,
} from "./feedback";

class FakeParam {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  oscillators: { type: string; frequency: FakeParam; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createBuffer = vi.fn(() => ({}));
  createBufferSource = vi.fn(() => ({ buffer: null, connect: vi.fn(), start: vi.fn() }));
  createGain = vi.fn(() => ({ gain: new FakeParam(), connect: vi.fn() }));
  createOscillator = vi.fn(() => {
    const osc = { type: "sine", frequency: new FakeParam(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    this.oscillators.push(osc);
    return osc;
  });
}

afterEach(() => {
  resetFeedbackForTests();
  FakeAudioContext.instances = [];
  vi.unstubAllGlobals();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("feedback tones", () => {
  it("defines a distinct tone and vibration for green, amber and red", () => {
    expect(TONES.ok.length).toBe(2);
    expect(TONES.warn.every((s) => s.freq === 740)).toBe(true);
    expect(TONES.fail[0].type).toBe("square");
    expect(VIBRATION.fail.length).toBe(3);
    expect(toneDuration("ok")).toBe(70 + 120 + 45);
    expect(toneDuration("fail")).toBe(380);
  });

  it("stays silent (but vibrates) before the audio is unlocked", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate });
    expect(playFeedback("fail")).toBe(false);
    expect(vibrate).toHaveBeenCalledWith(VIBRATION.fail);
  });

  it("schedules one oscillator per step once unlocked", async () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    unlockFeedback();
    const audio = FakeAudioContext.instances[0];
    expect(audio.resume).toHaveBeenCalled();
    await Promise.resolve();
    expect(playFeedback("ok")).toBe(true);
    expect(audio.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([1047, 1568]);
    expect(audio.oscillators.every((o) => o.start.mock.calls.length === 1 && o.stop.mock.calls.length === 1)).toBe(true);
  });

  it("unlocks on the first gesture and removes its listeners", () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    const target = new EventTarget();
    installFeedbackUnlock(target as unknown as Window);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(FakeAudioContext.instances.length).toBe(1);
  });
});
