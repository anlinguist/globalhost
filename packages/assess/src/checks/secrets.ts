// Secrets (ONBOARDING §1 "Secrets"): gitleaks over the full history of every branch, plus credential-shaped
// files ever committed. Findings carry file path, rule and commit only. A matched value never leaves this
// module: gitleaks runs with --redact, the report parser keeps only those three fields, and stderr is dropped.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@globalhost/runner";
import { z } from "zod";
import { execFailure, type Exec } from "../common.js";

export interface SecretFinding {
  file: string;
  rule: string;
  /** Full commit SHA, or "unknown" when the report's value isn't one. */
  commit: string;
  line?: number;
}

export type GitleaksResult =
  | { status: "ran"; version: string; findings: SecretFinding[]; truncated: boolean }
  | { status: "not-run"; reason: string }
  | { status: "failed"; reason: string };

const MAX_FINDINGS = 200;
const SHA = /^[0-9a-f]{40}$/;
const RULE = /^[A-Za-z0-9._-]{1,80}$/;

// z.object strips unknown keys, so Secret, Match, Author, Email and Message are dropped at parse time.
const ReportSchema = z.array(
  z.object({
    RuleID: z.string(),
    File: z.string(),
    Commit: z.string().optional(),
    StartLine: z.number().int().optional(),
  }),
);

export function parseGitleaksReport(json: unknown): { findings: SecretFinding[]; truncated: boolean } {
  const rows = ReportSchema.parse(json);
  const findings = rows.slice(0, MAX_FINDINGS).map((r) => ({
    file: r.File.slice(0, 300),
    rule: RULE.test(r.RuleID) ? r.RuleID : "unknown-rule",
    commit: r.Commit && SHA.test(r.Commit) ? r.Commit : "unknown",
    ...(r.StartLine === undefined ? {} : { line: r.StartLine }),
  }));
  return { findings, truncated: rows.length > MAX_FINDINGS };
}

/** gitleaks over a bare clone, if the binary is on PATH. The environment is minimal so no user config applies. */
export async function runGitleaks(bareDir: string, exec: Exec): Promise<GitleaksResult> {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  let version: string;
  try {
    version = (await exec("gitleaks", ["version"], { env, timeoutMs: 30_000 })).stdout.trim().slice(0, 40);
  } catch (err) {
    return { status: "not-run", reason: execFailure("gitleaks", err) };
  }
  const dir = await mkdtemp(join(tmpdir(), "globalhost-gitleaks-"));
  try {
    const report = join(dir, "report.json");
    try {
      // --exit-code 0: findings aren't an error here. A bare clone has no work tree, so a .gitleaks.toml or
      // .gitleaksignore committed in the repo can't switch rules off.
      await exec(
        "gitleaks",
        ["git", bareDir, "--report-format", "json", "--report-path", report, "--redact", "--exit-code", "0", "--no-banner", "--log-level", "error"],
        { env, timeoutMs: 15 * 60_000 },
      );
    } catch (err) {
      return { status: "failed", reason: execFailure("gitleaks", err) };
    }
    let parsed;
    try {
      parsed = parseGitleaksReport(JSON.parse(await readFile(report, "utf8")));
    } catch {
      return { status: "failed", reason: "gitleaks wrote a report in an unexpected shape" };
    }
    return { status: "ran", version, ...parsed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type CredentialKind = "env file" | "private key or keystore" | "ssh private key" | "service-account key?" | "credential config" | "terraform state";

export interface CredentialFile {
  path: string;
  kind: CredentialKind;
  /** Still tracked on the default branch (vs. only in history). */
  tracked: boolean;
  /** The commit that first added it. */
  addedIn: string;
}

const ENV_SAFE_SUFFIX = /^\.env\.(?:example|sample|template|dist|defaults|schema)$/i;

/** Credential-shaped by name alone; content is only ever read for the service-account key check. */
export function credentialKind(path: string): CredentialKind | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^\.env(?:\..+)?$/i.test(base) && !ENV_SAFE_SUFFIX.test(base)) return "env file";
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return "ssh private key";
  if (/\.(?:pem|key|p12|pfx|jks|keystore|p8|ppk)$/i.test(base)) return "private key or keystore";
  if (/\.json$/i.test(base) && /(?:service[-_]?account|credential|adminsdk|gcp[-_]?key|sa[-_]key|[-_]key\.json$)/i.test(base)) return "service-account key?";
  if (/^(?:\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.git-credentials)$/.test(base)) return "credential config";
  if (/\.tfstate(?:\.backup)?$/i.test(base)) return "terraform state";
  return undefined;
}

const MAX_CREDENTIAL_FILES = 200;

/** Credential-shaped files added on any branch, with whether the default branch still tracks them. */
export async function credentialFiles(bareDir: string, defaultSha: string): Promise<CredentialFile[]> {
  const tracked = new Set((await git(["ls-tree", "-r", "-z", "--name-only", defaultSha], { cwd: bareDir })).split("\0").filter(Boolean));
  // Oldest first, so the first commit seen for a path is the one that added it.
  const log = await git(["log", "--all", "--reverse", "--diff-filter=A", "--no-renames", "-z", "--name-only", "--format=%x01%H"], { cwd: bareDir });
  const found = new Map<string, CredentialFile>();
  for (const chunk of log.split("\x01").filter(Boolean)) {
    const [head = "", ...paths] = chunk.split("\0");
    const [sha = "", firstPath] = head.split("\n");
    for (const p of [firstPath, ...paths]) {
      const path = p?.replace(/^\n/, "");
      if (!path || found.has(path)) continue;
      const kind = credentialKind(path);
      if (kind) found.set(path, { path, kind, tracked: tracked.has(path), addedIn: sha.trim() });
    }
  }
  for (const path of tracked) {
    const kind = credentialKind(path);
    if (kind && !found.has(path)) found.set(path, { path, kind, tracked: true, addedIn: "unknown" });
  }
  return [...found.values()].slice(0, MAX_CREDENTIAL_FILES);
}

/** The identifying fields of a GCP service-account key file. private_key is never parsed out. */
const ServiceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().regex(/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  private_key_id: z.string().regex(/^[0-9a-f]{20,64}$/),
});

export interface ServiceAccountKeyRef {
  path: string;
  commit: string;
  clientEmail: string;
  /** Used only to ask GCP whether the key is still active; never rendered or written out. */
  keyId: string;
}

const MAX_KEY_FILE_BYTES = 64 * 1024;

/** Reads the candidate key files (at the commit that added them) and keeps the ones that are GCP SA keys. */
export async function serviceAccountKeys(bareDir: string, files: readonly CredentialFile[]): Promise<ServiceAccountKeyRef[]> {
  const out: ServiceAccountKeyRef[] = [];
  for (const f of files) {
    if (f.kind !== "service-account key?" || !/^[0-9a-f]{40}$/.test(f.addedIn)) continue;
    const object = `${f.addedIn}:${f.path}`;
    try {
      const size = Number((await git(["cat-file", "-s", object], { cwd: bareDir })).trim());
      if (!(size > 0 && size <= MAX_KEY_FILE_BYTES)) continue;
      const parsed = ServiceAccountKeySchema.safeParse(JSON.parse(await git(["cat-file", "blob", object], { cwd: bareDir })));
      if (parsed.success) out.push({ path: f.path, commit: f.addedIn, clientEmail: parsed.data.client_email, keyId: parsed.data.private_key_id });
    } catch {
      // Not JSON, or not readable: not a key we can check.
    }
  }
  return out;
}
