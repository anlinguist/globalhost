// Two renderings of an assessment: the facts for the assessor's task message (repo-derived parts fenced as
// untrusted), and the onboarding issue body (every repo- or agent-derived string neutralized for posting).
import { asPostable } from "@globalhost/dispatch";
import { fenceUntrusted, sanitizeUntrusted } from "@globalhost/sanitize";
import { cell, type Listing } from "./common.js";
import type { AssessmentFacts } from "./facts.js";
import type { Proposal } from "./proposal.js";
import { RUBRIC, type Readiness, type ReadinessId, type Scored } from "./readiness.js";

/** ONBOARDING §1 Stage 1, in order. The issue always has every one of these. */
export const SECTIONS = [
  "Stack & parts",
  "Branches & flow",
  "Current CI/deploy",
  "Tests",
  "Secrets",
  "Data",
  "Visibility & people",
  "Agent-readiness",
  "Proposed factory.yaml",
  "Multi-repo",
  "Risks & asks",
] as const;

const MAX_BODY = 60_000;

/** Only a private repo's issue may name where secrets were found; a public issue would publish an open finding. */
export const secretDetailsPostable = (f: AssessmentFacts) => f.github.visibility === "private";

/** The facts as the assessor sees them; for a public repo, secret findings are reduced to counts. */
function agentFacts(f: AssessmentFacts): unknown {
  const detailed = secretDetailsPostable(f);
  const gl = f.secrets.gitleaks;
  return {
    ...f,
    secrets: detailed
      ? f.secrets
      : {
          gitleaks: gl.status === "ran" ? { status: gl.status, version: gl.version, findingCount: gl.findings.length, rules: [...new Set(gl.findings.map((x) => x.rule))] } : gl,
          credentialFileCount: f.secrets.credentialFiles.length,
          trackedCredentialFileCount: f.secrets.credentialFiles.filter((c) => c.tracked).length,
          serviceAccountKeyCount: f.secrets.serviceAccountKeys.length,
          activeServiceAccountKeyCount: f.secrets.serviceAccountKeys.filter((k) => k.active).length,
          note: "Locations withheld: this repo is public, so the onboarding issue must not say where secrets are. The owner has the details locally.",
        },
  };
}

export function promptFacts(f: AssessmentFacts, scored: Partial<Record<ReadinessId, Scored>>, proposal: Proposal): string {
  const out: string[] = [];
  out.push("### Readiness items the harness scored (these scores are final)", "");
  const factIds = RUBRIC.filter((r) => scored[r.id]);
  for (const r of factIds) out.push(`- \`${r.id}\`: ${scored[r.id]!.points}/${r.max}`);
  if (factIds.length === 0) out.push("- none");
  out.push("", `Score these yourself in report.json \`readiness\`: ${RUBRIC.filter((r) => !scored[r.id]).map((r) => `\`${r.id}\``).join(", ")}.`, "");
  out.push(
    `### Visibility`,
    "",
    `The repository is ${f.github.visibility}.${secretDetailsPostable(f) ? "" : " Your assessment is posted publicly: never say where a secret is (no file paths, commits or line numbers for findings), only how many there are and the rotation steps."}`,
    "",
  );
  out.push(
    "### Facts (JSON)",
    "",
    fenceUntrusted({ source: "assessment-facts", text: JSON.stringify(agentFacts(f), null, 2) }, { maxLength: 80_000, normalization: "NFC" }),
    "",
  );
  out.push(
    `### Proposed factory.yaml (${proposal.errors.length === 0 ? "passes validation" : "does NOT pass validation"})`,
    "",
    fenceUntrusted({ source: "proposed-factory-yaml", text: proposal.text }, { normalization: "NFC" }),
    "",
  );
  if (proposal.errors.length) out.push("Validation errors:", "", fenceUntrusted({ source: "validator", text: proposal.errors.join("\n") }), "");
  if (proposal.notes.length) out.push("Notes on the proposal:", "", ...proposal.notes.map((n) => `- ${sanitizeUntrusted(n)}`), "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// The issue body

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADING = /^##\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

interface AgentSections {
  intro: string;
  byTitle: Map<(typeof SECTIONS)[number], string>;
  extra: { title: string; body: string }[];
}

/** Splits the agent's markdown on `##` headings (outside code fences) and matches them to SECTIONS. */
export function splitSections(md: string): AgentSections {
  const out: AgentSections = { intro: "", byTitle: new Map(), extra: [] };
  let title: string | undefined;
  let buf: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (title === undefined) {
      out.intro = body;
      return;
    }
    const key = norm(title);
    const match = SECTIONS.find((s) => key.startsWith(norm(s)) || norm(s).startsWith(key));
    if (match && key.length >= 4 && !out.byTitle.has(match)) out.byTitle.set(match, body);
    else out.extra.push({ title, body });
  };
  for (const line of md.split("\n")) {
    const f = FENCE.exec(line);
    if (f) fence = fence === undefined ? f[1]![0] : line.trimStart().startsWith(fence) ? undefined : fence;
    const h = fence === undefined ? HEADING.exec(line) : null;
    if (h) {
      flush();
      title = h[1]!;
    } else buf.push(line);
  }
  flush();
  return out;
}

/**
 * Agent-written markdown made safe to post inside the issue: sanitized (secret-shaped strings masked), raw HTML
 * escaped outside code blocks (so an unclosed <details> can't hide the harness's sections), unclosed code
 * fences closed. Pings and HTML comments are neutralized for the whole body by asPostable.
 */
export function agentMarkdown(md: string, max = 12_000): string {
  const clean = sanitizeUntrusted(md, { maxLength: max, normalization: "NFC" });
  let fence: string | undefined;
  const lines = clean.split("\n").map((line) => {
    const f = FENCE.exec(line);
    if (f) {
      fence = fence === undefined ? f[1]![0] : line.trimStart().startsWith(fence) ? undefined : fence;
      return line;
    }
    return fence === undefined ? line.replace(/</g, "&lt;") : line;
  });
  if (fence !== undefined) lines.push(fence.repeat(3));
  return lines.join("\n");
}

function listingLine<T>(l: Listing<T>, what: string, render: (items: T[]) => string[]): string[] {
  if (!l.ok) return [`- ${what}: unavailable (${cell(l.reason, 200)})`];
  if (l.items.length === 0) return [`- ${what}: none`];
  return [...render(l.items), ...(l.truncated ? [`- …more ${what} not shown`] : [])];
}

function harnessBlock(section: (typeof SECTIONS)[number], i: IssueInput): string[] {
  const f = i.facts;
  switch (section) {
    case "Stack & parts":
      return [
        "| Path | Profile | Confidence | Evidence |",
        "|---|---|---|---|",
        ...f.stack.candidates.map((c) => `| ${cell(c.path)} | ${cell(c.profile)} | ${c.confidence.toFixed(2)} | ${c.evidence.map((e) => cell(e, 120)).join("; ")} |`),
        "",
        `Proposed: ${f.stack.proposed.map((p) => `${cell(p.path)} as ${cell(p.profile)}`).join(", ") || "nothing"}${f.stack.lowConfidence ? " (low confidence: the owner must confirm)" : ""}.`,
      ];
    case "Branches & flow":
      return [
        `- Default branch: ${cell(f.branches.defaultBranch)} at ${f.branches.defaultSha.slice(0, 12)}`,
        ...listingLine(f.branches.others, "other branches", (items) => [
          "",
          "| Branch | Ahead | Behind | Last commit |",
          "|---|---|---|---|",
          ...items.map((b) => `| ${cell(b.name)} | ${b.ahead} | ${b.behind} | ${cell(b.lastCommitAt.slice(0, 10))} |`),
        ]),
      ];
    case "Current CI/deploy": {
      const lines = listingLine(f.github.workflows, "GitHub workflows", (items) => items.map((w) => `- Workflow ${cell(w.name)} (${cell(w.path)}), ${cell(w.state)}`));
      if (!f.gcp) lines.push("- GCP: not checked (pass `--gcp-project <id>` for Cloud Build triggers and Cloud Run services)");
      else {
        lines.push(
          ...listingLine(f.gcp.triggers, `Cloud Build triggers in ${cell(f.gcp.project)}`, (items) => [
            "",
            "| Trigger | Repo | Push branch | PR branch | Config | Disabled |",
            "|---|---|---|---|---|---|",
            ...items.map((t) => `| ${cell(t.name)} | ${cell(t.repo ?? "")} | ${cell(t.pushBranch ?? "")} | ${cell(t.pullRequestBranch ?? "")} | ${cell(t.filename ?? "")} | ${t.disabled ? "yes" : "no"} |`),
            "",
          ]),
          ...listingLine(f.gcp.services, "Cloud Run services", (items) => items.map((s) => `- Cloud Run ${cell(s.name)} (${cell(s.region ?? "?")}) ${cell(s.url ?? "")}`)),
        );
      }
      return lines;
    }
    case "Tests":
      return [`- Test-like files on the default branch: ${f.tests.count}${f.tests.sample.length ? ` (e.g. ${f.tests.sample.slice(0, 5).map((s) => cell(s)).join(", ")})` : ""}`];
    case "Secrets":
      return secretsBlock(f);
    case "Data":
      if (!f.gcp) return ["- Firestore: not checked (no `--gcp-project`)"];
      return listingLine(f.gcp.firestore, `Firestore databases in ${cell(f.gcp.project)}`, (items) => items.map((d) => `- Firestore ${cell(d.name)} (${cell(d.type ?? "?")}, ${cell(d.location ?? "?")})`));
    case "Visibility & people":
      return [
        `- Visibility: ${f.github.visibility}${f.github.archived ? ", archived" : ""}${f.github.fork ? ", a fork" : ""}`,
        `- Owner: ${cell(f.github.owner.login)} (${cell(f.github.owner.type)}, ID ${f.github.owner.id})`,
        ...listingLine(f.github.collaborators, "collaborators", (items) => [`- Collaborators: ${items.map((c) => `${cell(c.login)} (${cell(c.role)})`).join(", ")}`]),
        ...listingLine(f.github.outsideContributors, "outside contributors", (items) => [`- Outside contributors: ${items.map((c) => `${cell(c.login)} (${c.contributions})`).join(", ")}`]),
      ];
    case "Agent-readiness":
      return [
        `**Score: ${i.readiness.total}/100**`,
        "",
        "| Item | Points | Scored by | Evidence |",
        "|---|---|---|---|",
        ...i.readiness.items.map((r) => `| ${r.label} | ${r.points ?? "–"}/${r.max} | ${r.source === "facts" ? "harness" : r.source} | ${cell(r.evidence, 300)} |`),
      ];
    case "Proposed factory.yaml": {
      const agentOk = i.agentYaml?.ok === true;
      const shown = i.agentYaml?.ok ? i.agentYaml.text : i.proposal.text;
      const lines = [
        agentOk
          ? "The assessor's version, which passes `globalhost validate` and keeps the harness's owners, product and autonomy:"
          : i.proposal.errors.length === 0
            ? "Passes `globalhost validate`:"
            : "**Does not pass `globalhost validate`:**",
        "",
        "```yaml",
        sanitizeUntrusted(shown, { maxLength: 8000, normalization: "NFC" }).replace(/`{3,}/g, "'''").trimEnd(),
        "```",
      ];
      if (!agentOk && i.proposal.errors.length) lines.push("", ...i.proposal.errors.map((e) => `- ${cell(e, 300)}`));
      if (i.agentYaml && !i.agentYaml.ok) lines.push("", "The assessor's own factory.yaml was not used:", ...i.agentYaml.errors.slice(0, 10).map((e) => `- ${cell(e, 300)}`));
      if (i.proposal.notes.length) lines.push("", ...i.proposal.notes.map((n) => `- ${cell(n, 400)}`));
      return lines;
    }
    case "Multi-repo":
      return [];
    case "Risks & asks":
      return i.ownerNotes?.trim() ? ["The owner's open items:", "", sanitizeUntrusted(i.ownerNotes, { maxLength: 4000, normalization: "NFC" }).replace(/</g, "&lt;")] : [];
  }
}

function secretsBlock(f: AssessmentFacts): string[] {
  const gl = f.secrets.gitleaks;
  const detailed = secretDetailsPostable(f);
  const lines: string[] = [];
  if (gl.status !== "ran") lines.push(`- gitleaks: ${gl.status === "not-run" ? "not run" : "failed"} (${cell(gl.reason)}); history was not scanned`);
  else if (gl.findings.length === 0) lines.push(`- gitleaks ${cell(gl.version)} over every branch's history: no findings`);
  else {
    lines.push(`- gitleaks ${cell(gl.version)} over every branch's history: **${gl.findings.length}${gl.truncated ? "+" : ""} finding(s)**`);
    if (detailed) lines.push("", "| File | Rule | Commit | Line |", "|---|---|---|---|", ...gl.findings.map((x) => `| ${cell(x.file)} | ${cell(x.rule)} | ${x.commit.slice(0, 12)} | ${x.line ?? ""} |`), "");
    else lines.push(`  - Rules: ${[...new Set(gl.findings.map((x) => cell(x.rule)))].join(", ")}`);
  }
  const creds = f.secrets.credentialFiles;
  if (creds.length === 0) lines.push("- Credential-shaped files ever committed: none");
  else if (detailed) lines.push(`- Credential-shaped files ever committed:`, ...creds.map((c) => `  - ${cell(c.path)} (${c.kind}; ${c.tracked ? "still tracked" : "history only"}; added in ${c.addedIn.slice(0, 12)})`));
  else lines.push(`- Credential-shaped files ever committed: ${creds.length} (${creds.filter((c) => c.tracked).length} still tracked)`);
  const keys = f.secrets.serviceAccountKeys;
  if (keys.length > 0) {
    const status = (k: (typeof keys)[number]) => (k.active === true ? "**still active**" : k.active === false ? "deleted or disabled" : `unknown (${cell(k.reason ?? "")})`);
    if (detailed) lines.push(...keys.map((k) => `- Service-account key for ${cell(k.clientEmail)}: ${status(k)}`));
    else lines.push(`- Committed service-account keys: ${keys.length}, of which ${keys.filter((k) => k.active).length} still active`);
  }
  if (!detailed && (creds.length > 0 || (gl.status === "ran" && gl.findings.length > 0) || keys.length > 0)) {
    lines.push("", "Locations are withheld because this repo is public; they're in the local run directory (`facts.json`).");
  }
  return lines;
}

export interface IssueInput {
  facts: AssessmentFacts;
  readiness: Readiness;
  proposal: Proposal;
  /** The assessor's factory.yaml, if it wrote one, and whether it was accepted. */
  agentYaml?: { ok: true; text: string } | { ok: false; errors: string[] };
  /** The assessor's assessment.md, if any. */
  agentMarkdown?: string;
  ownerNotes?: string;
  run: { runId: string; sessionId: string; status: string; costUsd: number };
}

export const issueTitle = (repo: string) => `globalhost onboarding assessment: ${repo}`;

export function issueBody(i: IssueInput): string {
  const f = i.facts;
  const agent = splitSections(i.agentMarkdown ?? "");
  const out: string[] = [
    `# Onboarding assessment: ${cell(f.github.repo)}`,
    "",
    `> \`globalhost assess\` (autonomy L0, read-only) on ${cell(f.branches.defaultBranch)} at ${f.branches.defaultSha.slice(0, 12)}, ${f.gatheredAt.slice(0, 10)}.`,
    "> Each section starts with facts from the harness's own checks (trusted code), then the assessor agent's notes (unverified).",
    "",
  ];
  if (agent.intro) out.push(agentMarkdown(agent.intro, 2000), "");
  for (const s of SECTIONS) {
    out.push(`## ${s}`, "");
    const block = harnessBlock(s, i);
    if (block.length) out.push(...block, "");
    out.push("**Assessor (unverified):**", "");
    const body = agent.byTitle.get(s);
    out.push(body ? agentMarkdown(body) : "_The assessor didn't write this section._", "");
  }
  for (const x of agent.extra.slice(0, 5)) out.push(`### ${cell(x.title, 100)} (assessor)`, "", agentMarkdown(x.body, 4000), "");
  out.push(`<sub>Run ${cell(i.run.runId)} · session ${cell(i.run.sessionId)} · ${cell(i.run.status)} · $${i.run.costUsd.toFixed(2)}</sub>`);
  return asPostable(out.join("\n"), MAX_BODY);
}
