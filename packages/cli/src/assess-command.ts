// `globalhost assess <owner/repo>` (PLAN P1-08, ONBOARDING Stage 1). Trusted checks, then the assessor in a
// Managed Agents session (same keyless auth as `globalhost run`), then an onboarding issue body. Dry run by
// default; --post opens the issue with the owner's GITHUB_TOKEN, which never reaches the session.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assess, issueTitle, postIssue, type Exec, type Owner, type ReleaseProposer } from "@globalhost/assess";
import { GCP_PROJECT_PATTERN } from "@globalhost/core";
import { GitHubClient, asPostable } from "@globalhost/dispatch";
import { GitHubReader, parseRepo, startAssessment, type RunDeps } from "@globalhost/runner";
import { PROFILES, SKILL_DIRS, defaultDeps, printable } from "./main.js";
import { UsageError, eventPrinter, makeApi, positiveNumber, type RunIo } from "./run-command.js";

export const ASSESS_USAGE = `Usage:
  globalhost assess <owner/repo> [options]

Runs the deterministic onboarding checks and the assessor role (ONBOARDING Stage 1, read-only). By default it only
writes the onboarding issue body to the output directory; --post opens the issue in the repo.

Options:
  --gcp-project <id>    Also list Cloud Build triggers, Cloud Run services and Firestore databases in this project,
                        and check committed service-account keys, with read-only gcloud calls (your gcloud login)
  --asks-file <path>    Owner's open items to raise (markdown). If the file has an "Open items" heading (as an
                        ADR does), only that section is used
  --owner <login:id>    An owner for the proposed factory.yaml; repeatable (default: the repo's owner account)
  --budget <usd>        Session budget (default 4)
  --timeout <minutes>   Wall-clock limit (default 45)
  --model <id>          Model for the assessor agent
  --out <dir>           Where outputs go (default .globalhost/runs/<run-id>)
  --post                Open the onboarding issue with GITHUB_TOKEN (needs Issues: write on the repo)
  --post-from <dir>     Don't run anything: open the issue from a reviewed dry run's assessment.md
  --verbose             Also print the agent's messages

Environment: as for globalhost run (globalhost run --help). GITHUB_TOKEN is optional for a public repo's dry run.`;

export interface AssessIo extends RunIo {
  /** Test seams for gcloud/gitleaks and for cloning. */
  exec?: Exec;
  cloneAll?: (cloneUrl: string, token?: string) => Promise<string>;
  cloneRepo?: RunDeps["cloneRepo"];
}

/** Keeps the existing deploy: the one enabled Cloud Build trigger that builds the default branch of this repo. */
export const proposeCloudBuildRelease: ReleaseProposer = ({ profile, gcp, repo, defaultBranch }) => {
  if (!gcp?.triggers.ok || !profile.release.allowedAdapters.includes("cloud-build-trigger")) return undefined;
  const name = repo.split("/")[1]!.toLowerCase();
  const builds = (pattern: string) => {
    try {
      return new RegExp(pattern).test(defaultBranch);
    } catch {
      return false;
    }
  };
  const matches = gcp.triggers.items.filter(
    (t) =>
      !t.disabled &&
      t.pushBranch !== undefined &&
      builds(t.pushBranch) &&
      (t.repo === undefined || t.repo.toLowerCase() === repo.toLowerCase() || t.repo.toLowerCase().endsWith(`/${name}`)),
  );
  if (matches.length !== 1) return undefined;
  const t = matches[0]!;
  return { adapter: "cloud-build-trigger", config: { project: gcp.project, trigger: /^[A-Za-z0-9_-]{1,64}$/.test(t.name) ? t.name : t.id } };
};

/** An ADR's "Open items…" section, or the whole file. */
export function ownerAsks(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+open items\b/i.test(l));
  if (start === -1) return text.trim();
  const level = /^#+/.exec(lines[start]!)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

function parseOwner(raw: string): Owner {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?):([1-9][0-9]{0,15})$/.exec(raw);
  if (!m) throw new UsageError("--owner must be <login>:<user id>, e.g. anlinguist:47403803");
  return { login: m[1]!, id: Number(m[2]) };
}

export async function assessCommand(argv: readonly string[], io: AssessIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(`${ASSESS_USAGE}\n`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({
      args: [...argv.slice(1)],
      options: {
        "gcp-project": { type: "string" },
        "asks-file": { type: "string" },
        owner: { type: "string", multiple: true },
        budget: { type: "string" },
        timeout: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
        post: { type: "boolean" },
        "post-from": { type: "string" },
        verbose: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const [repo] = positionals;
    if (!repo || positionals.length > 1) throw new UsageError("expected <owner/repo>");
    try {
      parseRepo(repo);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const gcpProject = values["gcp-project"];
    if (gcpProject !== undefined && !GCP_PROJECT_PATTERN.test(gcpProject)) throw new UsageError("--gcp-project must be a GCP project id");
    const budgetUsd = positiveNumber("budget", values.budget, 4, 50);
    const timeoutMinutes = positiveNumber("timeout", values.timeout, 45, 240);
    const owners = values.owner?.map(parseOwner);
    const token = io.env.GITHUB_TOKEN || undefined;
    // Check before spending anything: posting needs the owner's token.
    if ((values.post || values["post-from"]) && !token) throw new UsageError("--post needs GITHUB_TOKEN (a token that can open issues on the repo)");
    if (values["post-from"]) {
      if (values.post) throw new UsageError("--post and --post-from don't combine");
      const body = await readFile(join(resolve(io.cwd, values["post-from"]), "assessment.md"), "utf8");
      // The owner may have edited it; posting still neutralizes pings and hidden comments.
      const issue = await postIssue(new GitHubClient(token, io.fetchImpl), repo, issueTitle(repo), asPostable(body, 60_000));
      io.out(`posted    ${printable(issue.url)}\n`);
      return 0;
    }
    const ownerNotes = values["asks-file"] ? ownerAsks(await readFile(resolve(io.cwd, values["asks-file"]), "utf8")) : undefined;

    const api = makeApi(io);
    const log = (line: string) => io.err(`${printable(line)}\n`);
    const reader = io.github ?? new GitHubReader(token, io.fetchImpl);
    const gh = new GitHubClient(token, io.fetchImpl);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const runId = `${stamp}-assessor-${randomBytes(3).toString("hex")}`;
    const outDir = resolve(io.cwd, values.out ?? join(".globalhost", "runs", runId));

    const result = await assess(
      {
        runId,
        repo,
        profiles: PROFILES,
        registry: defaultDeps().registry,
        outDir,
        budgetUsd,
        timeoutMinutes,
        gcpProject,
        owners,
        ownerNotes,
        proposeRelease: proposeCloudBuildRelease,
        model: values.model,
        skillDirs: [...(io.skillDirs ?? SKILL_DIRS)],
      },
      {
        gh,
        githubToken: token,
        exec: io.exec,
        cloneAll: io.cloneAll,
        log,
        runAssessor: (spec) =>
          startAssessment(spec, {
            api,
            github: reader,
            githubToken: token,
            log,
            onEvent: eventPrinter(io, values.verbose ?? false),
            cloneRepo: io.cloneRepo,
          }),
      },
    );

    const r = result.record;
    const lines = [
      "",
      `status    ${r.status} (${r.stopReason})`,
      `cost      $${r.costUsd.toFixed(2)} of $${r.budgetUsd.toFixed(2)}, ${r.wallSeconds}s wall`,
      `session   ${r.sessionId}`,
      `readiness ${result.readiness.total}/100`,
      `factory   ${result.proposal.errors.length === 0 ? "proposal validates" : `proposal has ${result.proposal.errors.length} validation error(s)`}`,
      `issue     ${join(outDir, "assessment.md")}`,
      `outputs   ${outDir}`,
    ];
    for (const p of [...r.problems, ...result.problems]) lines.push(`problem   ${printable(p)}`);
    io.out(`${lines.join("\n")}\n`);

    if (r.status !== "succeeded") {
      if (values.post) io.err("not posting: the assessor run didn't succeed\n");
      return 1;
    }
    if (values.post) {
      const issue = await postIssue(gh, repo, result.title, result.body);
      io.out(`posted    ${printable(issue.url)}\n`);
    } else io.out(`post      review ${join(outDir, "assessment.md")}, then post it with: globalhost assess ${repo} --post-from ${outDir}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${printable((err as Error).message)}\n\n${ASSESS_USAGE}\n`);
      return 2;
    }
    io.err(`error: ${printable((err as Error).message)}\n`);
    return 1;
  }
}
