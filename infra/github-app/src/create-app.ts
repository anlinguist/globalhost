// Creates the GitHub App `globalhost-ai` through the manifest flow (PLAN P1-05). Owner-run, once.
//
//   node infra/github-app/src/create-app.ts [--port 8765]
//
// 1. Serves http://127.0.0.1:<port>/ with a form that posts the manifest to github.com.
// 2. GitHub redirects back to /callback?code=…&state=…; the state must match.
// 3. Exchanges the code (POST /app-manifests/{code}/conversions) and pipes the private key straight
//    into `gcloud secrets versions add github-app-key --data-file=-`. The key is never written to disk
//    or printed. Prints only the app id, slug and install URL.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import {
  ConversionSchema,
  GITHUB_API,
  PROJECT,
  SECRET,
  buildManifest,
  githubHeaders,
  isValidManifestCode,
  renderStartPage,
  type Conversion,
} from "./lib.ts";

const { values } = parseArgs({
  options: { port: { type: "string", default: "8765" }, project: { type: "string", default: PROJECT } },
});
const port = Number(values.port);
const project = values.project;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024-65535");

function run(cmd: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

// Fail before creating anything if the secret is missing or not writable by this gcloud account:
// the conversion code is single-use, so a failure after it would leave an App without a stored key.
await run("gcloud", ["secrets", "describe", SECRET, `--project=${project}`]);

const state = randomBytes(24).toString("hex");
const redirectUrl = `http://127.0.0.1:${port}/callback`;
const manifest = buildManifest(redirectUrl);

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function stateMatches(candidate: string | null): boolean {
  if (!candidate || candidate.length !== state.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(state));
}

async function convert(code: string): Promise<Conversion> {
  const res = await fetch(`${GITHUB_API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: githubHeaders(),
  });
  if (!res.ok) throw new Error(`manifest conversion failed: HTTP ${res.status}`);
  // Parse only the fields we use; client_secret and webhook_secret are dropped unread.
  return ConversionSchema.parse(await res.json());
}

let done = false;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method !== "GET") return send(res, 405, "method not allowed", "text/plain");
  if (url.pathname === "/") return send(res, 200, renderStartPage(manifest, state));
  if (url.pathname !== "/callback") return send(res, 404, "not found", "text/plain");
  if (done) return send(res, 410, "already handled", "text/plain");
  const code = url.searchParams.get("code");
  if (!stateMatches(url.searchParams.get("state")) || !isValidManifestCode(code)) {
    return send(res, 400, "state mismatch or bad code", "text/plain");
  }
  done = true;
  send(res, 200, "<!doctype html><p>Received. Return to the terminal.</p>");

  (async () => {
    const app = await convert(code);
    await run("gcloud", ["secrets", "versions", "add", SECRET, `--project=${project}`, "--data-file=-"], app.pem);
    console.log(
      [
        "",
        `App created and its private key stored in Secret Manager (${project}/${SECRET}).`,
        `  app id:      ${app.id}`,
        `  slug:        ${app.slug}`,
        `  settings:    ${app.html_url}`,
        `  install URL: https://github.com/apps/${app.slug}/installations/new`,
        "Install it on anlinguist/numu-know only (\"Only select repositories\").",
      ].join("\n"),
    );
  })()
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("If the App was created but the key wasn't stored, see infra/github-app/README.md (recovery).");
      process.exitCode = 1;
    })
    .finally(() => server.close());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://127.0.0.1:${port}/ in the browser where you're signed in to GitHub as the owner.`);
});
