// P1-00 spike: Managed Agents as the factory runner (ADR-0011). Throwaway; delete when the P1-06
// harness lands. Auth is keyless (ADR-0014): the owner impersonates sa:globalhost-spike to mint a
// Google identity token, which a federation rule exchanges for a ~10-minute Anthropic token.
//
// Usage: node spike.mjs <check|setup|run|resume|cold|loop|cleanup>
// Created IDs and downloaded outputs live in .out/ (gitignored); results go into ADR-0011 as numbers.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, ".out");
const STATE = path.join(OUT, "state.json");

const SPIKE_SA = "globalhost-spike@globalhost-factory.iam.gserviceaccount.com";
const AUDIENCE = "https://api.anthropic.com";
const REPO = "https://github.com/anlinguist/numu-know.git";
const ISSUE = 10;
const MODEL = "claude-opus-5-5";
const RUN_BUDGET_CENTS = "500"; // $5 per working session
const LOOP_BUDGET_CENTS = "100"; // $1 for the deliberately looping session
const MAX_WAIT_MS = 45 * 60 * 1000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see README.md)`);
  return value;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  fs.mkdirSync(OUT, { recursive: true });
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// A fresh Google-signed identity token per exchange, minted with the IAM Credentials API directly.
// `gcloud --impersonate-service-account` would first mint an access token for the SA, which needs
// serviceAccountTokenCreator; generateIdToken needs only serviceAccountOpenIdTokenCreator.
async function googleIdentityToken() {
  const ownerToken = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const resp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SPIKE_SA}:generateIdToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: AUDIENCE, includeEmail: true }),
    },
  );
  if (!resp.ok) throw new Error(`generateIdToken failed: HTTP ${resp.status}`);
  return (await resp.json()).token;
}

const client = new Anthropic({
  credentials: oidcFederationProvider({
    identityTokenProvider: googleIdentityToken,
    federationRuleId: required("ANTHROPIC_FEDERATION_RULE_ID"),
    organizationId: required("ANTHROPIC_ORGANIZATION_ID"),
    serviceAccountId: required("ANTHROPIC_SERVICE_ACCOUNT_ID"),
    workspaceId: required("ANTHROPIC_WORKSPACE_ID"),
    baseURL: "https://api.anthropic.com",
    fetch,
  }),
});

const cents = (usage) => Number(usage?.list_cost?.amount ?? 0);
const dollars = (c) => `$${(c / 100).toFixed(2)}`;

function sessionLink(id) {
  return `https://platform.claude.com/workspaces/${process.env.ANTHROPIC_WORKSPACE_ID}/sessions/${id}`;
}

// Stream-first: open the event stream, then send, and return when the session stops working.
async function sendAndWait(sessionId, text) {
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  const started = Date.now();
  let stopReason = "unknown";
  for await (const event of stream) {
    if (Date.now() - started > MAX_WAIT_MS) {
      stopReason = "spike_timeout";
      break;
    }
    if (event.type === "agent.message") {
      for (const block of event.content) {
        if (block.type === "text") process.stdout.write(`\n[agent] ${block.text.slice(0, 400)}\n`);
      }
    } else if (event.type === "agent.tool_use") {
      const input = JSON.stringify(event.input ?? {});
      process.stdout.write(`[tool] ${event.name} ${input.slice(0, 160)}\n`);
    } else if (event.type === "session.error") {
      process.stdout.write(`[error] ${JSON.stringify(event).slice(0, 400)}\n`);
    } else if (event.type === "session.status_idle") {
      stopReason = event.stop_reason?.type ?? "unknown";
      if (stopReason !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      stopReason = "terminated";
      break;
    }
  }
  const session = await client.beta.sessions.retrieve(sessionId);
  return {
    stopReason,
    wallSeconds: Math.round((Date.now() - started) / 1000),
    listCostCents: cents(session.usage),
    activeSeconds: session.usage?.active_seconds ?? null,
  };
}

// The repo goes in as a git bundle through the Files API: no GitHub token and no GitHub egress.
async function uploadRepoBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spike-numu-"));
  execFileSync("git", ["clone", "--quiet", REPO, path.join(dir, "repo")]);
  const sha = execFileSync("git", ["-C", path.join(dir, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const bundle = path.join(dir, "numu-know.bundle");
  execFileSync("git", ["-C", path.join(dir, "repo"), "bundle", "create", bundle, "main"]);
  const file = await client.beta.files.upload({ file: fs.createReadStream(bundle) });
  return { fileId: file.id, sha };
}

async function createSession(budgetCents, title) {
  const state = loadState();
  const repo = await uploadRepoBundle();
  const smoke = await client.beta.files.upload({ file: fs.createReadStream(path.join(here, "smoke.spec.mjs")) });
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: state.agentId, version: state.agentVersion },
    environment_id: state.environmentId,
    title,
    budget: { type: "limit", max_list_cost: { amount: budgetCents, currency: "USD" } },
    resources: [
      { type: "file", file_id: repo.fileId, mount_path: "/numu-know.bundle" },
      { type: "file", file_id: smoke.id, mount_path: "/smoke.spec.mjs" },
    ],
  });
  console.log(`session ${session.id} (base ${repo.sha.slice(0, 7)})\nwatch: ${sessionLink(session.id)}`);
  return { sessionId: session.id, baseSha: repo.sha };
}

const ISSUE_TEXT = `numu-know issue #${ISSUE} "CSP blocks audio", filed by the owner:
Loading media from 'https://firebasestorage.googleapis.com/v0/b/numu-know.appspot.com/o/stories%2F...wav?alt=media'
violates the following Content Security Policy directive: "default-src 'self'". Note that 'media-src' was not
explicitly set, so 'default-src' is used as a fallback. The action has been blocked.`;

const FOLLOW_UP = `Owner follow-up on the issue: allow exactly the Firebase Storage origin
(https://firebasestorage.googleapis.com) for media, nothing broader, and add a one-line comment next to the
directive saying why it is there.`;

function taskPrompt(extra) {
  return `You are the builder for this repository. Work only inside /workspace. Do not push anywhere.

${ISSUE_TEXT}
${extra ? `\n${extra}\n` : ""}
Steps, in order. Record each step's wall-clock seconds and exit code in /mnt/session/outputs/run.json as you go.
1. Network probe (measurement only): run \`curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com\`
   and \`curl -sS -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/\`; record both results.
2. \`git clone /mnt/session/uploads/numu-know.bundle /workspace/numu-know\`, then work in that directory.
3. Run \`npm ci\`, then \`npm run build\`, timing each. If the build needs something the sandbox can't reach,
   record what was blocked and continue as far as you can.
4. Fix the issue with the smallest change, on a new branch factory/issue-${ISSUE}, in one commit.
5. Rebuild, start the app with \`npm start\` in the background, and run the Playwright smoke test at
   /mnt/session/uploads/smoke.spec.mjs against it (install @playwright/test in a separate directory such as
   /workspace/smoke, never inside the repo; use the preinstalled Chromium if there is one). Time it and save
   its screenshot to /mnt/session/outputs/.
6. \`git bundle create /mnt/session/outputs/fix.bundle main..factory/issue-${ISSUE}\`.
7. Finish run.json with: a summary, files changed, the smoke test result, and anything that was blocked.`;
}

async function downloadOutputs(sessionId, label) {
  const dest = path.join(OUT, label);
  fs.mkdirSync(dest, { recursive: true });
  let files = [];
  for (let attempt = 0; attempt < 5 && files.length === 0; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    files = [];
    for await (const f of client.beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) {
      files.push(f);
    }
  }
  for (const f of files) {
    const resp = await client.beta.files.download(f.id);
    fs.writeFileSync(path.join(dest, path.basename(f.filename)), Buffer.from(await resp.arrayBuffer()));
  }
  console.log(`downloaded ${files.length} output file(s) to ${dest}`);
  return dest;
}

// Criterion 4: the bundle round-trips and applies cleanly onto the base commit.
function verifyBundle(dir, baseSha) {
  const bundle = path.join(dir, "fix.bundle");
  if (!fs.existsSync(bundle)) return { applies: false, reason: "no fix.bundle" };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "spike-verify-"));
  execFileSync("git", ["clone", "--quiet", REPO, work]);
  execFileSync("git", ["-C", work, "checkout", "--quiet", baseSha]);
  execFileSync("git", ["-C", work, "bundle", "verify", bundle], { stdio: "ignore" });
  execFileSync("git", ["-C", work, "fetch", "--quiet", bundle, `factory/issue-${ISSUE}:factory/issue-${ISSUE}`]);
  const stat = execFileSync("git", ["-C", work, "diff", "--stat", `${baseSha}..factory/issue-${ISSUE}`], { encoding: "utf8" });
  return { applies: true, diffStat: stat.trim() };
}

const commands = {
  async check() {
    const page = await client.beta.agents.list({ limit: 1 });
    console.log(`token exchange OK; agents visible: ${page.data.length}`);
  },

  async setup() {
    const environment = await client.beta.environments.create({
      name: "globalhost-spike-p1-00",
      config: {
        type: "cloud",
        // Always set explicitly: omitting networking means unrestricted (ADR-0011).
        networking: { type: "limited", allow_package_managers: true, allowed_hosts: [] },
      },
    });
    const agent = await client.beta.agents.create({
      name: "globalhost-spike-builder",
      model: MODEL,
      system:
        "You are a careful software builder working in a sandbox. Make the smallest change that fixes the issue, " +
        "keep the repository's style, never push, and report measurements exactly as asked.",
      tools: [
        {
          type: "agent_toolset_20260401",
          // The sandbox is the boundary (ADR-0011): no prompts, no web tools.
          default_config: { enabled: true, permission_policy: { type: "always_allow" } },
          configs: [
            { name: "web_fetch", enabled: false },
            { name: "web_search", enabled: false },
          ],
        },
      ],
    });
    saveState({ environmentId: environment.id, agentId: agent.id, agentVersion: agent.version });
    console.log(`environment ${environment.id}, agent ${agent.id} v${agent.version}`);
  },

  async run() {
    const { sessionId, baseSha } = await createSession(RUN_BUDGET_CENTS, `P1-00 numu-know#${ISSUE}`);
    const result = await sendAndWait(sessionId, taskPrompt());
    const dir = await downloadOutputs(sessionId, "run");
    const bundle = verifyBundle(dir, baseSha);
    saveState({ run: { sessionId, baseSha, ...result, bundle } });
    console.log(JSON.stringify({ ...result, cost: dollars(result.listCostCents), bundle }, null, 2));
  },

  // Criterion 5: continue the same session after an owner comment and price only the delta.
  async resume() {
    const { run } = loadState();
    const result = await sendAndWait(
      run.sessionId,
      `${FOLLOW_UP}\nUpdate the commit on factory/issue-${ISSUE}, re-run the smoke test, and write a new ` +
        `/mnt/session/outputs/fix.bundle and run.json.`,
    );
    const deltaCents = result.listCostCents - run.listCostCents;
    const dir = await downloadOutputs(run.sessionId, "resume");
    const bundle = verifyBundle(dir, run.baseSha);
    saveState({ resume: { ...result, deltaCents, bundle } });
    console.log(JSON.stringify({ ...result, delta: dollars(deltaCents), bundle }, null, 2));
  },

  // The comparison point for criterion 5: the same end state from a cold session.
  async cold() {
    const { sessionId, baseSha } = await createSession(RUN_BUDGET_CENTS, `P1-00 numu-know#${ISSUE} (cold)`);
    const result = await sendAndWait(sessionId, taskPrompt(FOLLOW_UP));
    const dir = await downloadOutputs(sessionId, "cold");
    const bundle = verifyBundle(dir, baseSha);
    saveState({ cold: { sessionId, ...result, bundle } });
    console.log(JSON.stringify({ ...result, cost: dollars(result.listCostCents), bundle }, null, 2));
  },

  // Criterion 6: a session told to loop forever must stop at its budget.
  async loop() {
    const state = loadState();
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: state.agentId, version: state.agentVersion },
      environment_id: state.environmentId,
      title: "P1-00 budget loop",
      budget: { type: "limit", max_list_cost: { amount: LOOP_BUDGET_CENTS, currency: "USD" } },
    });
    console.log(`session ${session.id}\nwatch: ${sessionLink(session.id)}`);
    const result = await sendAndWait(
      session.id,
      "This is a budget test. Run `date` with bash, then run it again, one tool call at a time, and keep going " +
        "without stopping or summarizing until you are stopped.",
    );
    saveState({ loop: { sessionId: session.id, ...result } });
    console.log(JSON.stringify({ ...result, cost: dollars(result.listCostCents) }, null, 2));
  },

  // Status of a recorded session (run|cold|loop), including the last idle stop reason.
  async inspect() {
    const key = process.argv[3] ?? "loop";
    const sessionId = loadState()[key]?.sessionId;
    const session = await client.beta.sessions.retrieve(sessionId);
    let lastIdle = null;
    let count = 0;
    for await (const event of client.beta.sessions.events.list(sessionId)) {
      count++;
      if (event.type === "session.status_idle") lastIdle = event.stop_reason?.type ?? null;
    }
    console.log(
      JSON.stringify(
        { status: session.status, cost: dollars(cents(session.usage)), budget: session.budget, events: count, lastIdle },
        null,
        2,
      ),
    );
  },

  async cleanup() {
    const state = loadState();
    for (const key of ["run", "cold", "loop"]) {
      if (state[key]?.sessionId) {
        await client.beta.sessions.delete(state[key].sessionId);
        console.log(`deleted session ${state[key].sessionId}`);
      }
    }
    if (state.environmentId) {
      await client.beta.environments.delete(state.environmentId);
      console.log(`deleted environment ${state.environmentId}`);
    }
    if (state.agentId) {
      // Agents can't be deleted; archiving is terminal and this one is spike-only.
      await client.beta.agents.archive(state.agentId);
      console.log(`archived agent ${state.agentId}`);
    }
  },
};

const name = process.argv[2];
if (!commands[name]) {
  console.error(`usage: node spike.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
await commands[name]();
