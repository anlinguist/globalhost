/** Container entrypoint: validate env, listen, drain on SIGTERM. */
import { ConfigError, loadConfig } from "./config.js";
import { createGuard } from "./guard.js";
import { jsonLogger } from "./log.js";

// Cloud Run sends SIGTERM and allows 10 s before SIGKILL.
const SHUTDOWN_GRACE_MS = 8_000;

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  const message = err instanceof ConfigError ? err.message : "invalid configuration";
  jsonLogger("ERROR", "access-guard refusing to start", { reason: "config", detail: message });
  process.exit(1);
}

const guard = createGuard(config, { log: jsonLogger });
guard.server.listen(config.port, () => {
  jsonLogger("INFO", "access-guard listening", {
    port: config.port,
    upstreamPort: config.upstreamPort,
    issuer: config.issuer,
    audiences: config.audiences.length,
  });
});

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  jsonLogger("INFO", "access-guard shutting down", { signal });
  guard.shutdown(SHUTDOWN_GRACE_MS).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
