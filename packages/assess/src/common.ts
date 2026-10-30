// Shared shapes and helpers for the assessment's checks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeUntrusted } from "@globalhost/sanitize";

/** A list a check fetched, or why it couldn't. Every check reports "couldn't" instead of throwing. */
export type Listing<T> = { ok: true; items: T[]; truncated: boolean } | { ok: false; reason: string };

export const listed = <T>(items: T[], max: number): Listing<T> => ({ ok: true, items: items.slice(0, max), truncated: items.length > max });
export const unavailable = (reason: string): Listing<never> => ({ ok: false, reason });

/** Runs a binary without a shell. Injectable so tests never call gcloud or gitleaks. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile);

export const defaultExec: Exec = async (file, args, opts = {}) => {
  const { stdout, stderr } = await execFileP(file, [...args], {
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/** "not installed" for ENOENT, otherwise the exit code. Never stderr: a scanner's stderr can echo what it found. */
export function execFailure(tool: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
  if (e.code === "ENOENT") return `${tool} is not installed`;
  if (e.killed) return `${tool} timed out`;
  return `${tool} failed${typeof e.code === "number" ? ` (exit ${e.code})` : ""}`;
}

/** The first line of a gcloud error, which names the cause (e.g. PERMISSION_DENIED) and carries no secrets. */
export function gcloudFailure(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === "ENOENT") return "gcloud is not installed";
  const line = (e.stderr ?? "").split("\n").find((l) => l.trim() !== "");
  return line ? `gcloud failed: ${sanitizeUntrusted(line, { maxLength: 200 })}` : execFailure("gcloud", err);
}

/**
 * Repo-derived text made safe for one markdown table cell in a posted issue: one line, bounded, no HTML, no
 * links, no pings, no table breaks. Applied to every name, path and description the harness renders.
 */
export function cell(text: unknown, max = 160): string {
  return sanitizeUntrusted(text, { maxLength: max })
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[|\\[\]`*_~]/g, (c) => `\\${c}`)
    .replace(/@/g, "@‍");
}
