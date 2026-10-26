import { useState } from "react";
import { CalendarClock, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { useSetWarehouseSetting, useWarehouseSettings, type WhScheduleCountsResult } from "@/lib/hooks";
import { useWhScheduleCounts } from "@/lib/hooks/use-warehouse-counts";
import type { Json } from "@/lib/database.types";
import { errorText } from "./format";

interface Cadence {
  A_days: number;
  B_days: number;
  C_days: number;
  daily_cap: number;
}

const DEFAULTS: Cadence = { A_days: 7, B_days: 30, C_days: 90, daily_cap: 20 };
const FIELDS: { key: keyof Cadence; label: string; hint: string }[] = [
  { key: "A_days", label: "A-class every", hint: "days" },
  { key: "B_days", label: "B-class every", hint: "days" },
  { key: "C_days", label: "C-class and unclassified every", hint: "days" },
  { key: "daily_cap", label: "At most", hint: "scheduled counts a day" },
];

function readCadence(value: unknown): Cadence {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const n = (k: keyof Cadence) => (typeof v[k] === "number" ? (v[k] as number) : DEFAULTS[k]);
  return { A_days: n("A_days"), B_days: n("B_days"), C_days: n("C_days"), daily_cap: n("daily_cap") };
}

/**
 * The A/B/C count cadence (§8): a location is due when its last count is
 * older than the shortest cadence of the SKUs it holds; the scheduler opens
 * the most overdue first, up to the daily cap. Admins edit the cadence and
 * can run the scheduler now; everyone else reads it.
 */
export function ScheduleTab() {
  const { toast } = useToast();
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const { data: settings, isLoading } = useWarehouseSettings();
  const save = useSetWarehouseSetting();
  const schedule = useWhScheduleCounts();
  const current = readCadence(settings?.count_schedule);
  const [draft, setDraft] = useState<Cadence | null>(null);
  const [result, setResult] = useState<WhScheduleCountsResult | null>(null);
  const form = draft ?? current;
  const dirty = draft != null && FIELDS.some((f) => draft[f.key] !== current[f.key]);
  const invalid = FIELDS.some((f) => !Number.isInteger(form[f.key]) || form[f.key] < 1 || form[f.key] > 500);

  function saveCadence() {
    if (!draft) return;
    const base = settings?.count_schedule && typeof settings.count_schedule === "object" ? (settings.count_schedule as Record<string, unknown>) : {};
    save.mutate(
      { key: "count_schedule", value: { ...base, ...draft } as unknown as Json },
      {
        onSuccess: () => {
          setDraft(null);
          toast({ title: "Count schedule saved" });
        },
        onError: (err) => toast({ title: "Couldn't save the schedule", description: errorText(err, "Unknown error"), variant: "destructive" }),
      },
    );
  }

  function runNow() {
    schedule.mutate(undefined, {
      onSuccess: (res) => {
        setResult(res);
        toast({ title: `${res.created} count${res.created === 1 ? "" : "s"} scheduled` });
      },
      onError: (err) => toast({ title: "Couldn't run the scheduler", description: errorText(err, "Unknown error"), variant: "destructive" }),
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cadence</CardTitle>
          <CardDescription>
            From each SKU's ABC class on the product: A weekly, B monthly, C quarterly by default. A location takes the
            shortest cadence of what it holds; never counted is most overdue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-3">
                  <Label htmlFor={`cad-${f.key}`} className="w-56 text-sm font-normal text-muted-foreground">
                    {f.label}
                  </Label>
                  {isAdmin ? (
                    <Input
                      id={`cad-${f.key}`}
                      type="number"
                      min={1}
                      max={500}
                      className="w-24 tabular-nums"
                      value={String(form[f.key])}
                      onChange={(e) => setDraft({ ...form, [f.key]: Number(e.target.value) })}
                    />
                  ) : (
                    <span id={`cad-${f.key}`} className="w-24 font-semibold tabular-nums">
                      {form[f.key]}
                    </span>
                  )}
                  <span className="text-sm text-muted-foreground">{f.hint}</span>
                </div>
              ))}
            </div>
          )}
          {isAdmin ? (
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={saveCadence}>
                {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Save cadence
              </Button>
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              )}
              {invalid && <span className="text-xs text-amber-300">Whole numbers from 1 to 500.</span>}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only an admin changes the cadence.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scheduler</CardTitle>
          <CardDescription>
            Runs every night at 09:10 UTC, after the reconcile, once the physical layer is live. It skips transit areas
            (IN, OUT, MFG), stations and locations that already have a count open or waiting for approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdmin ? (
            <Button size="sm" variant="outline" disabled={schedule.isPending} onClick={runNow}>
              {schedule.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Run scheduler now
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Only an admin runs the scheduler by hand.</p>
          )}
          {result && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Result label="Created now" value={result.created} />
              <Result label="Due" value={result.due} />
              <Result label="Already open" value={result.already_open} />
              <Result label="Left for later" value={result.left_for_later} />
              <Result label="Scheduled today" value={`${result.scheduled_today} of ${result.daily_cap}`} />
            </div>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The daily cap counts every scheduled task opened since midnight UTC, so a second run the same day only adds
            what the first left under the cap.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Result({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
