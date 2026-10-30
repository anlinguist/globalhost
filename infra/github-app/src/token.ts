// Mints a `globalhost-ai` installation token scoped to one repo and a permission subset (P1-05 AC).
// The App key is read from Secret Manager into memory only.
//
//   node infra/github-app/src/token.ts --app-id <id> --repo anlinguist/numu-know --access read -- gh api repos/anlinguist/numu-know
//   node infra/github-app/src/token.ts --app-id <id> --repo anlinguist/numu-know --access write --print | pbcopy
//
// With a command after `--`, runs it with GH_TOKEN/GITHUB_TOKEN set and prints nothing else.
// Without one, prints the token only if --print is given (tokens expire within 1 h).
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  AccessTokenSchema,
  GITHUB_API,
  InstallationSchema,
  PROJECT,
  SECRET,
  TOKEN_PERMISSIONS,
  appJwt,
  githubHeaders,
  parseRepo,
  type Access,
} from "./lib.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "app-id": { type: "string", default: process.env.GLOBALHOST_APP_ID },
    repo: { type: "string" },
    access: { type: "string", default: "read" },
    project: { type: "string", default: PROJECT },
    print: { type: "boolean", default: false },
  },
});
const appId = values["app-id"];
if (!appId || !/^[0-9]+$/.test(appId)) throw new Error("--app-id <numeric id> (or GLOBALHOST_APP_ID) is required");
if (!values.repo) throw new Error("--repo owner/name is required");
if (values.access !== "read" && values.access !== "write") throw new Error("--access must be read or write");
const access: Access = values.access;
const { owner, repo } = parseRepo(values.repo);
if (positionals.length === 0 && !values.print) {
  throw new Error("give a command after `--` to run with the token, or --print to write it to stdout");
}

function readSecret(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "gcloud",
      ["secrets", "versions", "access", "latest", `--secret=${SECRET}`, `--project=${values.project}`],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`gcloud exited ${code}`)),
    );
  });
}

async function github(path: string, auth: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers: { ...githubHeaders(auth), ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${res.status}`);
  return res.json();
}

const jwt = appJwt(appId, await readSecret());
const installation = InstallationSchema.parse(await github(`/repos/${owner}/${repo}/installation`, jwt));
const minted = AccessTokenSchema.parse(
  await github(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo], permissions: TOKEN_PERMISSIONS[access] }),
  }),
);
console.error(`${access} token for ${owner}/${repo}: ${JSON.stringify(minted.permissions)}, expires ${minted.expires_at}`);

if (positionals.length > 0) {
  const [cmd, ...args] = positionals as [string, ...string[]];
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: minted.token, GITHUB_TOKEN: minted.token },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  process.stdout.write(`${minted.token}\n`);
}
