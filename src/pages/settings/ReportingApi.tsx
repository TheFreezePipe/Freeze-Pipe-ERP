import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check, KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO, formatDistanceToNow } from "date-fns";

const BASE_URL = "https://pnqujtugddxusllkikje.supabase.co/functions/v1/reporting-api";

const ENDPOINTS = [
  { path: "/kpis", desc: "headline numbers" },
  { path: "/sales-daily?days=90", desc: "per-day per-SKU units" },
  { path: "/stock-levels", desc: "per-SKU stock, transit, on-order (free vs allocated), DOS" },
  { path: "/incoming-shipments", desc: "open shipments + check-in progress" },
  { path: "/low-stock?threshold=7", desc: "the 8am email's low-stock list" },
];

/**
 * Admin-only panel managing the read-only reporting API used by external
 * dashboards. Server-side enforcement matches the UI gate: api_keys RLS is
 * admin-SELECT-only and both RPCs verify the caller's role themselves —
 * hiding the tab is convenience, not the security boundary.
 */
export default function ReportingApi() {
  const { profile, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const { data: keys = [] } = useQuery({
    queryKey: ["api-keys"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_keys")
        .select("*")
        .eq("name", "reporting")
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data ?? [];
    },
  });
  const active = keys.find((k) => !k.revoked_at) ?? null;

  const rotate = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("rpc_rotate_reporting_key", {
        p_actor_id: profile!.id,
      });
      if (error) throw error;
      const result = data as { ok: boolean; key?: string; error?: string };
      if (!result.ok || !result.key) throw new Error(result.error ?? "Rotation failed");
      return result.key;
    },
    onSuccess: (key) => {
      setFreshKey(key);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => toast({ title: "Couldn't generate key", description: describeError(err), variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("rpc_revoke_reporting_key", {
        p_actor_id: profile!.id,
      });
      if (error) throw error;
      const result = data as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? "Revoke failed");
    },
    onSuccess: () => {
      toast({ title: "API key revoked", description: "External dashboards using it will stop working immediately." });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => toast({ title: "Couldn't revoke key", description: describeError(err), variant: "destructive" }),
  });

  async function copy(text: string, tag: string) {
    await navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!isAdmin) return null;

  return (
    <Card className="max-w-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Reporting API
          <span className="text-xs font-normal text-muted-foreground">read-only · for external dashboards</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Base URL — paste this (plus the key) into the dashboard app</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted/40 px-2.5 py-1.5 font-mono text-xs">{BASE_URL}</code>
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => copy(BASE_URL, "url")}>
              {copied === "url" ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The base URL is self-describing: opening it lists every endpoint and its fields — an AI coding
            agent can build a dashboard from that page alone.
          </p>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">API key</p>
          {active ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-xs">{active.key_hint}</Badge>
              <span className="text-xs text-muted-foreground">
                created {format(parseISO(active.created_at), "MMM d, yyyy")}
                {active.last_used_at
                  ? ` · last used ${formatDistanceToNow(parseISO(active.last_used_at), { addSuffix: true })}`
                  : " · never used"}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No active key — generate one to enable access.</p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant={active ? "outline" : "default"}
              onClick={() => (active ? setConfirmRotate(true) : rotate.mutate())}
              disabled={rotate.isPending}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {rotate.isPending ? "Generating…" : active ? "Rotate key" : "Generate key"}
            </Button>
            {active && (
              <Button size="sm" variant="ghost" className="text-red-400" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
                <ShieldOff className="mr-1.5 h-3.5 w-3.5" /> Revoke
              </Button>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Endpoints</p>
          <div className="space-y-1">
            {ENDPOINTS.map((e) => (
              <p key={e.path} className="text-xs">
                <code className="font-mono text-cyan-300/90">{e.path}</code>
                <span className="text-muted-foreground"> — {e.desc}</span>
              </p>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Exposes operational counts and aggregate valuations only — no per-SKU costs, margins, or
            supplier pricing. Requests send the key as an <code className="font-mono">x-api-key</code> header.
          </p>
        </div>
      </CardContent>

      {/* Rotate confirmation — rotating kills the old key instantly. */}
      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate the API key?</DialogTitle>
            <DialogDescription>
              The current key ({active?.key_hint}) stops working the moment the new one is created.
              Any dashboard using it must be updated with the new key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRotate(false)}>Cancel</Button>
            <Button onClick={() => { setConfirmRotate(false); rotate.mutate(); }}>Rotate key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time plaintext reveal */}
      <Dialog open={!!freshKey} onOpenChange={(o) => !o && setFreshKey(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Copy it now — this is the only time it will ever be shown. The system stores only a hash.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted/40 px-2.5 py-2 font-mono text-xs">{freshKey}</code>
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => freshKey && copy(freshKey, "key")}>
              {copied === "key" ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setFreshKey(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
