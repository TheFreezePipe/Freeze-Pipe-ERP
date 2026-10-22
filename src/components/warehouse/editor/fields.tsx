import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Compact property fields for the layout editor. Text and number fields
 * are uncontrolled and commit on blur or Enter (Escape restores), so one
 * edit is one undo step; they remount when the value changes from outside
 * (undo, drag).
 */

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)}>
      {label && <span>{label}</span>}
      {children}
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  upper?: boolean;
  maxLength?: number;
  className?: string;
}

export function TextField({ label, value, onCommit, placeholder, upper, maxLength, className }: TextFieldProps) {
  return (
    <Field label={label} className={className}>
      <Input
        key={value}
        defaultValue={value}
        placeholder={placeholder}
        maxLength={maxLength}
        className={cn("h-8 text-sm", upper && "uppercase")}
        onBlur={(e) => {
          const next = upper ? e.target.value.trim().toUpperCase() : e.target.value.trim();
          if (next !== value) onCommit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

interface NumberFieldProps {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Allow clearing to null (else an empty field restores the value). */
  nullable?: boolean;
  suffix?: string;
  /** For a field without a visible label. */
  ariaLabel?: string;
  className?: string;
}

export function NumberField({ label, value, onCommit, min, max, step = 1, nullable, suffix, ariaLabel, className }: NumberFieldProps) {
  const shown = value == null ? "" : String(value);
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} className={className}>
      <Input
        key={shown}
        type="number"
        inputMode="numeric"
        aria-label={ariaLabel}
        defaultValue={shown}
        min={min}
        max={max}
        step={step}
        className="h-8 text-sm tabular-nums"
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            if (nullable && value != null) onCommit(null);
            else e.target.value = shown;
            return;
          }
          let n = Math.round(Number(raw));
          if (!Number.isFinite(n)) {
            e.target.value = shown;
            return;
          }
          if (min != null) n = Math.max(min, n);
          if (max != null) n = Math.min(max, n);
          if (n !== value) onCommit(n);
          else e.target.value = shown;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = shown;
            e.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

interface SelectFieldProps {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  /** Label of an empty choice (null); omit to require a value. */
  noneLabel?: string;
  className?: string;
}

/** A native select styled like the inputs: dense, and touch-friendly. */
export function SelectField({ label, value, options, onChange, noneLabel, className }: SelectFieldProps) {
  return (
    <Field label={label} className={className}>
      <NativeSelect value={value ?? ""} onChange={(v) => onChange(v === "" ? null : v)} ariaLabel={label}>
        {noneLabel != null && <option value="">{noneLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function NativeSelect({
  value,
  onChange,
  children,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </select>
  );
}
