import type { Detection, RepoSnapshot } from "@globalhost/core";
import { webAppConfigSchema, type WebAppConfig } from "./config.js";

export const FRAMEWORKS = [
  "next",
  "remix",
  "react-router",
  "astro",
  "nuxt",
  "sveltekit",
  "angular",
  "vite",
  "create-react-app",
  "static",
  "none",
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Well-known package.json scripts the verify steps use when present. */
export const KNOWN_SCRIPTS = ["typecheck", "lint", "build", "test"] as const;
export type KnownScript = (typeof KNOWN_SCRIPTS)[number];

export interface WebAppDetection extends Detection<WebAppConfig> {
  framework: Framework;
  packageManager: PackageManager;
  /** Which of KNOWN_SCRIPTS package.json defines. */
  scripts: Record<KnownScript, boolean>;
  typescript: boolean;
  playwright: boolean;
}

// Framework signals, strongest first: [framework, base confidence, dependency names].
const FRAMEWORK_DEPS: ReadonlyArray<readonly [Framework, number, readonly string[]]> = [
  ["next", 0.85, ["next"]],
  ["remix", 0.85, ["@remix-run/react", "@remix-run/dev"]],
  ["react-router", 0.85, ["@react-router/dev"]],
  ["astro", 0.85, ["astro"]],
  ["nuxt", 0.85, ["nuxt"]],
  ["sveltekit", 0.85, ["@sveltejs/kit"]],
  ["angular", 0.8, ["@angular/core"]],
  ["vite", 0.8, ["vite"]],
  ["create-react-app", 0.75, ["react-scripts"]],
];

// Production-server default ports, used when no Dockerfile EXPOSE says otherwise.
const DEFAULT_PORT: Record<Framework, number> = {
  next: 3000,
  remix: 3000,
  "react-router": 3000,
  astro: 4321,
  nuxt: 3000,
  sveltekit: 3000,
  angular: 4000,
  vite: 4173,
  "create-react-app": 3000,
  static: 8080,
  none: 3000,
};

// Lockfile → package manager, in the order used when a repo has several.
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const MAX_CONFIDENCE = 0.97;
const MAX_ROUTES = 10;

function join(dir: string, file: string): string {
  return dir === "." || dir === "" ? file : `${dir.replace(/\/+$/, "")}/${file}`;
}

function parent(dir: string): string | undefined {
  if (dir === "." || dir === "") return undefined;
  const i = dir.lastIndexOf("/");
  return i === -1 ? "." : dir.slice(0, i);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringKeys(v: unknown): string[] {
  return isRecord(v) ? Object.keys(v) : [];
}

function packageManagerField(pkg: Record<string, unknown>): PackageManager | undefined {
  const field = pkg.packageManager;
  if (typeof field !== "string") return undefined;
  const name = field.split("@")[0];
  return PACKAGE_MANAGERS.find((pm) => pm === name);
}

/**
 * The part's package manager: package.json's `packageManager` field, else the lockfile nearest the part
 * (part directory, then each parent up to the repo root, for workspaces), else npm.
 */
function detectPackageManager(files: ReadonlySet<string>, path: string, pkg: Record<string, unknown> | undefined, evidence: string[]): PackageManager {
  const field = pkg && packageManagerField(pkg);
  if (field) {
    evidence.push(`package.json packageManager field names ${field}`);
    return field;
  }
  for (let dir: string | undefined = path; dir !== undefined; dir = parent(dir)) {
    const found = LOCKFILES.filter(([lock]) => files.has(join(dir!, lock)));
    const first = found[0];
    if (!first) continue;
    const names = found.map(([lock]) => join(dir!, lock));
    evidence.push(
      found.length === 1
        ? `lockfile ${names[0]} → ${first[1]}`
        : `several lockfiles (${names.join(", ")}); chose ${first[1]} by precedence pnpm > yarn > npm > bun`,
    );
    return first[1];
  }
  evidence.push("no lockfile found; assuming npm");
  return "npm";
}

function hasFileUnder(files: readonly string[], dir: string): boolean {
  const prefix = `${dir}/`;
  return files.some((f) => f.startsWith(prefix));
}

// Next.js app-router segment that adds nothing to the URL: (group), or an optional catch-all [[...x]].
const TRANSPARENT_SEGMENT = /^(?:\([^/]*\)|\[\[\.\.\.[^/]*\]\])$/;
const STATIC_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** Static app-router (or pages-router) routes up to two segments deep, for the suggested screenshot list. */
function nextRoutes(files: readonly string[], path: string): string[] {
  const routes = new Set<string>();
  for (const root of ["app", "src/app"]) {
    const prefix = `${join(path, root)}/`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const segments = f.slice(prefix.length).split("/");
      const leaf = segments.pop();
      if (!leaf || !/^page\.(?:tsx|jsx|ts|js|mdx)$/.test(leaf)) continue;
      const visible = segments.filter((s) => !TRANSPARENT_SEGMENT.test(s));
      if (visible.length > 2 || !visible.every((s) => STATIC_SEGMENT.test(s))) continue;
      routes.add(`/${visible.join("/")}`);
    }
  }
  for (const root of ["pages", "src/pages"]) {
    const prefix = `${join(path, root)}/`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const rel = f.slice(prefix.length);
      const m = /^(.*?)(?:\/index)?\.(?:tsx|jsx|ts|js|mdx)$/.exec(rel);
      if (!m || rel.startsWith("api/") || /(?:^|\/)_/.test(rel)) continue;
      const route = m[1] === "index" ? "" : (m[1] ?? "");
      const segments = route === "" ? [] : route.split("/");
      if (segments.length > 2 || !segments.every((s) => STATIC_SEGMENT.test(s))) continue;
      routes.add(`/${segments.join("/")}`);
    }
  }
  return [...routes].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, MAX_ROUTES);
}

function exposedPort(dockerfile: string | undefined): number | undefined {
  if (dockerfile === undefined) return undefined;
  const m = /^\s*EXPOSE\s+(\d{1,5})\b/im.exec(dockerfile);
  const port = m?.[1] === undefined ? NaN : Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Is `path` a web app? Reads package.json, lockfiles, config files and (for the port) the Dockerfile through
 * the snapshot. Everything returned except `evidence` is drawn from fixed sets, so callers can put it in a
 * prompt without quoting repo content.
 */
export async function detectWebApp(repo: RepoSnapshot, path: string): Promise<WebAppDetection> {
  const files = new Set(repo.files);
  const at = (f: string) => join(path, f);
  const evidence: string[] = [];
  let confidence = 0;
  let framework: Framework = "none";

  let pkg: Record<string, unknown> | undefined;
  const pkgText = await repo.readFile(at("package.json"));
  if (pkgText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(pkgText);
      if (isRecord(parsed)) pkg = parsed;
      else evidence.push(`${at("package.json")} is not a JSON object`);
    } catch {
      evidence.push(`${at("package.json")} is not valid JSON`);
    }
  }

  const deps = new Set([...stringKeys(pkg?.dependencies), ...stringKeys(pkg?.devDependencies)]);
  const scriptNames = new Set(stringKeys(pkg?.scripts));
  const scripts = Object.fromEntries(KNOWN_SCRIPTS.map((s) => [s, scriptNames.has(s)])) as Record<KnownScript, boolean>;

  for (const [fw, base, names] of FRAMEWORK_DEPS) {
    const hit = names.find((n) => deps.has(n));
    if (hit) {
      framework = fw;
      confidence = base;
      evidence.push(`${at("package.json")} depends on ${hit}`);
      break;
    }
  }

  if (framework === "none" && files.has(at("index.html"))) {
    framework = "static";
    confidence = 0.5;
    evidence.push(`${at("index.html")} with no framework dependency`);
  }

  if (framework !== "none") {
    const corroborate = (cond: boolean, what: string) => {
      if (!cond) return;
      confidence += 0.05;
      evidence.push(what);
    };
    const configFile = [...files].find((f) => new RegExp(`^${escapeRe(at(""))}(?:next|vite|astro|nuxt|svelte|remix|react-router)\\.config\\.[cm]?[jt]s$`).test(f));
    corroborate(configFile !== undefined, `framework config ${configFile ?? ""}`);
    const srcDir = ["app", "pages", "src", "public"].find((d) => hasFileUnder(repo.files, at(d)));
    corroborate(srcDir !== undefined, `source directory ${at(srcDir ?? "")}/`);
    corroborate(scripts.build, `${at("package.json")} has a build script`);
  }

  // A browser-extension manifest means this is the chrome-extension profile's part, not a web app.
  for (const manifest of ["manifest.json", "public/manifest.json", "src/manifest.json"]) {
    const text = files.has(at(manifest)) ? await repo.readFile(at(manifest)) : undefined;
    if (text !== undefined && /"manifest_version"\s*:/.test(text)) {
      confidence -= 0.5;
      evidence.push(`${at(manifest)} declares manifest_version (browser extension)`);
    }
  }

  confidence = round(Math.min(MAX_CONFIDENCE, Math.max(0, confidence)));
  if (framework === "none") evidence.push("no web framework dependency or index.html found");

  const packageManager = detectPackageManager(files, path, pkg, evidence);
  const typescript = deps.has("typescript") || files.has(at("tsconfig.json"));
  const playwright = deps.has("@playwright/test") || [...files].some((f) => new RegExp(`^${escapeRe(at(""))}playwright\\.config\\.[cm]?[jt]s$`).test(f));

  const port = exposedPort(files.has(at("Dockerfile")) ? await repo.readFile(at("Dockerfile")) : undefined);
  const routes = framework === "next" ? nextRoutes(repo.files, path) : [];
  const suggestedConfig = webAppConfigSchema.parse({
    port: port ?? DEFAULT_PORT[framework],
    routes: routes.length > 0 ? routes : ["/"],
  });

  return { confidence, evidence, suggestedConfig, framework, packageManager, scripts, typescript, playwright };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
