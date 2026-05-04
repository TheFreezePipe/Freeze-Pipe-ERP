import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarDays, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  makeRange,
  rangeLabel,
  type DateRange,
  type RangePreset,
} from "@/lib/performance/date-ranges";

interface Props {
  value: DateRange;
  onChange: (next: DateRange) => void;
}

const PRESETS: { preset: Exclude<RangePreset, "custom">; label: string }[] = [
  { preset: "today", label: "Today" },
  { preset: "yesterday", label: "Yesterday" },
  { preset: "last_7_days", label: "Last 7d" },
  { preset: "last_30_days", label: "Last 30d" },
];

/**
 * Segmented control + Custom popover for the Performance dashboard's date range.
 * Emits a DateRange with ET-aware start/end instants; the caller is responsible
 * for serializing to URL params so links are shareable.
 */
export function DateRangeSelector({ value, onChange }: Props) {
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(value.fromYmd);
  const [to, setTo] = useState(value.toYmd);

  function applyPreset(p: Exclude<RangePreset, "custom">) {
    onChange(makeRange(p));
  }

  function applyCustom() {
    if (!from || !to) return;
    if (from > to) return;
    onChange(makeRange("custom", from, to));
    setCustomOpen(false);
  }

  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
      {PRESETS.map(p => {
        const active = value.preset === p.preset;
        return (
          <button
            key={p.preset}
            type="button"
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
            onClick={() => applyPreset(p.preset)}
          >
            {p.label}
          </button>
        );
      })}

      <Popover open={customOpen} onOpenChange={(o) => {
        setCustomOpen(o);
        if (o) { setFrom(value.fromYmd); setTo(value.toYmd); }
      }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors",
              value.preset === "custom"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            <CalendarDays className="h-3 w-3" />
            {value.preset === "custom" ? rangeLabel(value) : "Custom"}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[280px]">
          <div className="space-y-3">
            <div>
              <Label htmlFor="range-from" className="text-xs text-muted-foreground">From</Label>
              <Input
                id="range-from"
                type="date"
                value={from}
                max={to}
                onChange={e => setFrom(e.target.value)}
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <Label htmlFor="range-to" className="text-xs text-muted-foreground">To</Label>
              <Input
                id="range-to"
                type="date"
                value={to}
                min={from}
                onChange={e => setTo(e.target.value)}
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div className="flex justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setCustomOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!from || !to || from > to}
                onClick={applyCustom}
              >
                Apply
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/50">
              Dates are in Eastern Time
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
