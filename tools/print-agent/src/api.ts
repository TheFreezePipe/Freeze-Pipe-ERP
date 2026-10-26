import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentConfig } from "./config";
import { errorMessage, type Logger } from "./log";

/** A printer this agent drives (wh_printers row with agent_id = AGENT_ID). */
export interface AgentPrinter {
  id: string;
  code: string;
  name: string;
  address: string | null;
  label_stock: string;
  dpi: number;
}

/** One claimed job (rpc_wh_claim_print_jobs). `attempts` counts claims, this one included. */
export interface ClaimedJob {
  id: string;
  kind: string;
  printer_id: string;
  payload: unknown;
  item_ids: string[];
  attempts: number;
}

export interface PrintingSettings {
  maxAttempts: number;
  claimTimeoutS: number;
}

/** Everything the agent asks of the ERP; the Supabase implementation is below, tests use a fake. */
export interface AgentApi {
  loadPrinters(agentId: string): Promise<AgentPrinter[]>;
  loadPrinting(): Promise<PrintingSettings>;
  heartbeat(agentId: string, printerIds: string[]): Promise<{ printers: number; queued: number }>;
  claim(printerIds: string[], agentId: string): Promise<ClaimedJob[]>;
  mark(jobId: string, status: "printed" | "failed", error: string | null): Promise<{ status: string }>;
  /** Realtime: call onQueued when a job for these printers is inserted or re-queued. Returns the unsubscribe. */
  subscribe(printerIds: string[], onQueued: () => void): () => void;
}

interface Envelope {
  ok?: boolean;
  error?: string;
  message?: string;
}

export const DEFAULT_PRINTING: PrintingSettings = { maxAttempts: 3, claimTimeoutS: 60 };

/** The envelope of a warehouse RPC, unwrapped the way the web app does it (message wins over the code). */
async function call<T>(client: SupabaseClient, fn: string, args: object): Promise<T & Envelope> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  const env = data as (T & Envelope) | null;
  if (!env?.ok) throw new Error(`${fn}: ${env?.message ?? env?.error ?? "no answer"}`);
  return env;
}

export function createSupabaseClient(config: AgentConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

/** Sign in as the print-agent user and check its profile carries is_print_agent. */
export async function signIn(client: SupabaseClient, config: AgentConfig, log: Logger): Promise<void> {
  const { data, error } = await client.auth.signInWithPassword({ email: config.email, password: config.password });
  if (error || !data.user) throw new Error(`Sign-in as ${config.email} failed: ${error?.message ?? "no user"}`);
  const { data: profile, error: pErr } = await client
    .from("profiles")
    .select("role, is_active, is_print_agent")
    .eq("id", data.user.id)
    .maybeSingle();
  if (pErr) log.warn(`Could not read the agent's profile: ${pErr.message}`);
  else if (!profile) log.warn("The agent's profile row is missing.");
  else if (!(profile as { is_print_agent?: boolean }).is_print_agent) {
    throw new Error(`${config.email} is signed in but its profile lacks is_print_agent (the database owner sets it).`);
  }
  log.info(`Signed in as ${config.email}.`);
}

export function supabaseApi(client: SupabaseClient, log: Logger): AgentApi {
  return {
    async loadPrinters(agentId) {
      const { data, error } = await client
        .from("wh_printers")
        .select("id, code, name, address, label_stock, dpi")
        .eq("agent_id", agentId)
        .eq("transport", "agent")
        .eq("active", true)
        .order("code");
      if (error) throw new Error(`wh_printers: ${error.message}`);
      return (data ?? []) as AgentPrinter[];
    },

    async loadPrinting() {
      const res = await call<{ settings?: { printing?: { max_attempts?: number; claim_timeout_s?: number } } }>(
        client,
        "rpc_wh_get_settings",
        {},
      );
      const p = res.settings?.printing ?? {};
      return {
        maxAttempts: Number(p.max_attempts) > 0 ? Number(p.max_attempts) : DEFAULT_PRINTING.maxAttempts,
        claimTimeoutS: Number(p.claim_timeout_s) > 0 ? Number(p.claim_timeout_s) : DEFAULT_PRINTING.claimTimeoutS,
      };
    },

    async heartbeat(agentId, printerIds) {
      const res = await call<{ printers: number; queued: number }>(client, "rpc_wh_agent_heartbeat", {
        p_agent_id: agentId,
        p_printer_ids: printerIds,
      });
      return { printers: res.printers, queued: res.queued };
    },

    async claim(printerIds, agentId) {
      const res = await call<{ jobs: ClaimedJob[]; released: number }>(client, "rpc_wh_claim_print_jobs", {
        p_printer_ids: printerIds,
        p_agent_id: agentId,
      });
      if (res.released > 0) log.info(`The server released ${res.released} timed-out claim(s).`);
      return res.jobs ?? [];
    },

    async mark(jobId, status, error) {
      const res = await call<{ status: string }>(client, "rpc_wh_mark_printed", {
        p_job_id: jobId,
        p_status: status,
        p_error: error,
      });
      return { status: res.status };
    },

    subscribe(printerIds, onQueued) {
      if (printerIds.length === 0) return () => undefined;
      const filter = `printer_id=in.(${printerIds.join(",")})`;
      const handler = (payload: { new?: { status?: string } }) => {
        if (payload.new?.status === "queued") onQueued();
      };
      let channel: RealtimeChannel | null = null;
      try {
        channel = client
          .channel(`wh-print-agent-${Date.now()}`)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "wh_print_jobs", filter }, handler)
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "wh_print_jobs", filter }, handler)
          .subscribe((status, err) => {
            if (status === "SUBSCRIBED") log.info("Realtime: listening for new print jobs.");
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              log.warn(`Realtime ${status.toLowerCase()}${err ? `: ${errorMessage(err)}` : ""}; polling continues.`);
            }
          });
      } catch (err) {
        log.warn(`Realtime unavailable (${errorMessage(err)}); polling only.`);
      }
      return () => {
        if (channel) void client.removeChannel(channel);
      };
    },
  };
}
