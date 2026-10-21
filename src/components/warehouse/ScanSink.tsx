import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

/** Typing that pauses this long is a person, not a scanner: drop it. */
const IDLE_CLEAR_MS = 400;

interface ScanSinkProps {
  /** Called with the trimmed value when a scan ends (Enter). */
  onScan: (value: string) => void;
  /** Stop capturing, e.g. while a form on the page owns the keyboard. */
  disabled?: boolean;
  className?: string;
}

/** Elements that legitimately own the keyboard; the sink never steals from them. */
function ownsKeyboard(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  // Open Radix dialogs, selects and menus manage their own focus.
  return !!el.closest('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[role="combobox"]');
}

/**
 * Keyboard-wedge (HID) scanner sink. A paired scanner "types" the barcode
 * followed by Enter; this keeps a tiny always-focused input to receive it.
 *
 * - inputMode="none": focusing it never raises the phone's soft keyboard.
 * - Characters accumulate; Enter commits; an empty buffer is ignored; 400 ms
 *   of silence clears the buffer so stray typing never becomes a scan.
 * - Re-focuses itself on blur unless another input/textarea/select (or an
 *   open dialog/listbox) now has focus.
 * - Fallback: keys arriving while focus sits on a button or the page body are
 *   routed into the buffer, so a scan still lands after a tap elsewhere.
 */
export function ScanSink({ onScan, disabled = false, className }: ScanSinkProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState(false);
  const emitScan = useEffectEvent((value: string) => onScan(value));

  useEffect(() => {
    const input = inputRef.current;
    if (disabled || !input) return;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let refocusTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        input.value = "";
      }, IDLE_CLEAR_MS);
    };
    const commit = () => {
      clearIdle();
      const value = input.value.trim();
      input.value = "";
      if (value) emitScan(value);
    };
    const focusSink = () => {
      if (document.activeElement === input || ownsKeyboard(document.activeElement)) return;
      input.focus({ preventScroll: true });
    };

    const onInput = () => armIdle();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commit();
    };
    // Let the new focus target settle before deciding whether to take it back.
    const onBlur = () => {
      if (refocusTimer) clearTimeout(refocusTimer);
      refocusTimer = setTimeout(focusSink, 0);
    };
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.target === input || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ownsKeyboard(e.target instanceof Element ? e.target : null)) return;
      if (e.key === "Enter") {
        // Empty buffer: leave Enter to the focused button.
        if (!input.value.trim()) return;
        e.preventDefault();
        commit();
        return;
      }
      if (e.key.length === 1 && e.key !== " ") {
        e.preventDefault();
        input.value += e.key;
        armIdle();
        focusSink();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") focusSink();
    };

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("focus", focusSink);
    document.addEventListener("visibilitychange", onVisibility);
    focusSink();

    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("focus", focusSink);
      document.removeEventListener("visibilitychange", onVisibility);
      clearIdle();
      if (refocusTimer) clearTimeout(refocusTimer);
      input.value = "";
    };
  }, [disabled]);

  return (
    <label
      className={cn(
        "relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors",
        armed && !disabled ? "text-green-400" : "text-muted-foreground/50",
        className,
      )}
      title={armed && !disabled ? "Scanner ready" : "Tap to scan"}
    >
      <ScanLine className="h-5 w-5" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        inputMode="none"
        enterKeyHint="go"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label="Scan"
        disabled={disabled}
        onFocus={() => setArmed(true)}
        onBlur={() => setArmed(false)}
        className="absolute inset-0 h-full w-full cursor-default border-0 bg-transparent p-0 text-base text-transparent caret-transparent opacity-0 outline-none"
      />
    </label>
  );
}
