import { z } from "@globalhost/core";

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
// A URL path to screenshot: starts with "/", no query, fragment, spaces or percent-escapes.
const ROUTE = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/;
// One line of shell; the owner writes it in factory.yaml on the default branch, the only copy that is trusted.
const COMMAND = /^[^\r\n\0]{1,300}$/;

const command = (what: string) => z.string().regex(COMMAND, { error: `must be a single-line ${what} command of 1–300 characters` });

/** `parts.<name>.config` for `profile: web-app`. Every key is optional, so `config` may be omitted. */
export const webAppConfigSchema = z.strictObject({
  /** Port the built app listens on when started for previews and smoke tests. */
  port: z.number().int().min(1).max(65535).default(3000),
  /** Routes the smoke test visits and screenshots (desktop + mobile). */
  routes: z
    .array(z.string().regex(ROUTE, { error: "must be a path starting with '/' (letters, digits, . _ ~ -), no query or fragment" }))
    .max(20)
    .default(() => ["/"]),
  /**
   * Non-secret environment for preview builds and smoke runs, e.g. a dev project's public `NEXT_PUBLIC_*` config.
   * factory.yaml is committed: never put secrets here.
   */
  previewEnv: z
    .record(z.string().regex(ENV_NAME, { error: "must be an environment variable name ([A-Z_][A-Z0-9_]*)" }), z.string().max(1000))
    .refine((env) => Object.keys(env).length <= 50, { error: "at most 50 variables" })
    .default(() => ({})),
  /** Seeds the dev data previews use. */
  seed: command("seed").optional(),
  /** Overrides the lockfile-derived install command, e.g. "npm ci --legacy-peer-deps". */
  install: command("install").optional(),
});

export type WebAppConfig = z.output<typeof webAppConfigSchema>;
