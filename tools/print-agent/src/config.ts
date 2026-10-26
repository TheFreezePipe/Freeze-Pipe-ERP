import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/** The agent's folder (tools/print-agent): .env, data/ and relative file:// addresses live here. */
export const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AgentConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string;
  password: string;
  agentId: string;
  dataDir: string;
  pollMs: number;
  heartbeatMs: number;
  sendTimeoutMs: number;
}

export class ConfigError extends Error {}

function seconds(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === "") return fallback * 1000;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}.`);
  return Math.round(n * 1000);
}

/** Read tools/print-agent/.env (or the environment). Never logs the values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, envFile = path.join(AGENT_DIR, ".env")): AgentConfig {
  loadDotenv({ path: envFile, quiet: true } as Parameters<typeof loadDotenv>[0]);
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "AGENT_EMAIL", "AGENT_PASSWORD", "AGENT_ID"].filter(
    (k) => !(env[k] ?? "").trim(),
  );
  if (missing.length) throw new ConfigError(`Missing in ${envFile}: ${missing.join(", ")} (see .env.example).`);

  const supabaseUrl = env.SUPABASE_URL!.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(supabaseUrl)) {
    throw new ConfigError("SUPABASE_URL should look like https://<project-ref>.supabase.co.");
  }
  const agentId = env.AGENT_ID!.trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(agentId)) throw new ConfigError("AGENT_ID: letters, digits, dot, dash or underscore.");

  return {
    supabaseUrl,
    supabaseAnonKey: env.SUPABASE_ANON_KEY!.trim(),
    email: env.AGENT_EMAIL!.trim(),
    password: env.AGENT_PASSWORD!,
    agentId,
    dataDir: path.resolve(AGENT_DIR, (env.AGENT_DATA_DIR ?? "").trim() || "data"),
    pollMs: seconds("POLL_SECONDS", env.POLL_SECONDS, 15, 5, 300),
    heartbeatMs: seconds("HEARTBEAT_SECONDS", env.HEARTBEAT_SECONDS, 30, 10, 300),
    sendTimeoutMs: Number(env.SEND_TIMEOUT_MS) > 0 ? Number(env.SEND_TIMEOUT_MS) : 10_000,
  };
}
