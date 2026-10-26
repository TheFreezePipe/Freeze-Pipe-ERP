/** Timestamped console lines. Nothing secret (password, tokens) is ever passed here. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function stamp(): string {
  return new Date().toISOString();
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${stamp()} INFO  ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN  ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}
