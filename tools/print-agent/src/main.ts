import { PrintAgent } from "./agent";
import { createSupabaseClient, signIn, supabaseApi } from "./api";
import { AGENT_DIR, ConfigError, loadConfig } from "./config";
import { SentJournal } from "./journal";
import { consoleLogger as log, errorMessage } from "./log";

/**
 *   npm start         run until stopped (a Windows service runs this)
 *   npm run once      sign in, heartbeat, print whatever is queued, exit
 */
async function main(): Promise<number> {
  const once = process.argv.includes("--once");
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(err instanceof ConfigError ? err.message : errorMessage(err));
    return 2;
  }

  const client = createSupabaseClient(config);
  try {
    await signIn(client, config, log);
  } catch (err) {
    log.error(errorMessage(err));
    return 1;
  }

  const journal = new SentJournal(config.dataDir);
  const agent = new PrintAgent({
    api: supabaseApi(client, log),
    agentId: config.agentId,
    journal,
    log,
    baseDir: AGENT_DIR,
    pollMs: config.pollMs,
    heartbeatMs: config.heartbeatMs,
    sendTimeoutMs: config.sendTimeoutMs,
  });
  log.info(`Print agent ${config.agentId} starting (journal ${journal.size} job(s), ${once ? "one pass" : "running"}).`);

  if (once) {
    try {
      const stats = await agent.runOnce();
      log.info(`One pass: claimed ${stats.claimed}, printed ${stats.printed}, failed ${stats.failed}, already sent ${stats.resent}.`);
      await agent.stop();
      await client.auth.signOut().catch(() => undefined);
      return stats.failed > 0 ? 3 : 0;
    } catch (err) {
      log.error(errorMessage(err));
      return 1;
    }
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal}: stopping.`);
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await agent.start();
  } catch (err) {
    log.error(`Could not start: ${errorMessage(err)}`);
    return 1;
  }
  return new Promise<number>(() => undefined); // runs until a signal
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error(errorMessage(err));
    process.exit(1);
  },
);
