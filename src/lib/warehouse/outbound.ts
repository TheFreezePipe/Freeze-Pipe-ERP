/**
 * Staging outbound guard, client side (design §3.3). The database setting
 * wh_settings.outbound says live / blocked / practice; the browser never
 * believes "live" off production, so a copied production setting on staging
 * still prints and sends nothing.
 */
export type OutboundMode = "live" | "blocked" | "practice";

const MODES: readonly OutboundMode[] = ["live", "blocked", "practice"];

export function effectiveOutboundMode(
  serverMode: unknown,
  appEnv: string | undefined,
): OutboundMode {
  const mode = MODES.includes(serverMode as OutboundMode) ? (serverMode as OutboundMode) : "blocked";
  if (mode === "live" && appEnv !== "prod") return "blocked";
  return mode;
}
