import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { DiffCtx, GuardrailResult } from "@globalhost/core";
import { dependencyChange, DEPENDENCY_CHANGE_GLOBS, MAX_LOCKFILE_CHARS, refusedBeforeParsing } from "../src/index.js";

// Recorded with real tools (npm 11.19.1, pnpm 12.16.1, bun 1.3.6) for { is-odd 3.0.1 (→ is-number), ms 2.1.3 (dev) }.
const sample = (name: string) => fs.readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");
const MANIFEST = sample("package.json");
const NPM = sample("package-lock.json");
const PNPM = sample("pnpm-lock.yaml");
const BUN = sample("bun.lock");

type Tree = Record<string, string>;
const diff = (base: Tree, head: Tree, files?: string[]): DiffCtx => ({
  files: files ?? [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((f) => base[f] !== head[f]),
  readBase: (p) => Promise.resolve(Object.hasOwn(base, p) ? base[p] : undefined),
  readHead: (p) => Promise.resolve(Object.hasOwn(head, p) ? head[p] : undefined),
});
const evaluate = (base: Tree, head: Tree, files?: string[]) => dependencyChange.evaluate(diff(base, head, files));
const swap = (text: string, from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};
const reasonOf = (r: GuardrailResult) => (r.kind === "pass" ? "" : r.reason);
const subjectsOf = (r: GuardrailResult) => (r.kind === "pass" ? [] : (r.subjects ?? []));

const OLD_HASH = "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==";
const NEW_HASH = "sha512-AAAAHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==";

type Manifest = Record<string, unknown>;

describe("the guardrail", () => {
  it("is the one the docs name", () => {
    expect(dependencyChange.id).toBe("dependency-change");
    expect(dependencyChange.approvalLabel).toBe("approved:deps");
    expect(dependencyChange.paths).toEqual(DEPENDENCY_CHANGE_GLOBS);
  });
});

describe.each([
  ["package-lock.json", NPM],
  ["pnpm-lock.yaml", PNPM],
  ["bun.lock", BUN],
])("%s (recorded sample)", (file, lock) => {
  it("is parsed: an identical copy passes", async () => {
    expect(await evaluate({ [file]: lock }, { [file]: lock }, [file])).toEqual({ kind: "pass" });
  });

  it("trailing whitespace alone passes: same content", async () => {
    expect(await evaluate({ [file]: lock }, { [file]: `${lock}\n` })).toEqual({ kind: "pass" });
  });

  it("an integrity-only change trips", async () => {
    const r = await evaluate({ [file]: lock }, { [file]: swap(lock, OLD_HASH, NEW_HASH) });
    expect(r.kind).toBe("needsApproval");
    expect(reasonOf(r)).toContain("1 changed");
    expect(subjectsOf(r).join()).toContain("is-number");
  });

  it("a head lockfile deleted trips", async () => {
    const r = await evaluate({ [file]: lock }, {});
    expect(reasonOf(r)).toContain("deleted");
  });

  it("a missing base lockfile trips", async () => {
    const r = await evaluate({}, { [file]: lock });
    expect(reasonOf(r)).toContain("added");
  });

  it("garbage in head trips", async () => {
    expect(reasonOf(await evaluate({ [file]: lock }, { [file]: "{{{{ not a lockfile" }))).toContain("could not be parsed");
  });

  it("garbage in base trips", async () => {
    expect(reasonOf(await evaluate({ [file]: "{{{{" }, { [file]: lock }))).toContain("could not be parsed");
  });

  it("an empty head trips", async () => {
    expect(reasonOf(await evaluate({ [file]: lock }, { [file]: "" }))).toContain("could not be parsed");
  });

  it("a scalar in place of a document trips", async () => {
    expect(reasonOf(await evaluate({ [file]: lock }, { [file]: "42" }))).toContain("could not be parsed");
  });

  it("a huge lockfile trips without being parsed", async () => {
    const huge = `${lock}${" ".repeat(MAX_LOCKFILE_CHARS)}`;
    const started = Date.now();
    expect(reasonOf(await evaluate({ [file]: lock }, { [file]: huge }))).toContain("too large");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("deep nesting trips rather than crashing", async () => {
    const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
    expect(reasonOf(await evaluate({ [file]: lock }, { [file]: deep }))).toContain("could not be parsed");
  });

  it("nested in a subdirectory it's still compared", async () => {
    expect((await evaluate({ [`apps/web/${file}`]: lock }, { [`apps/web/${file}`]: swap(lock, OLD_HASH, NEW_HASH) })).kind).toBe("needsApproval");
  });

  it("another spelling of the name trips on any change", async () => {
    const odd = file.toUpperCase();
    expect(reasonOf(await evaluate({ [odd]: lock }, { [odd]: `${lock}\n` }))).toContain("controls dependencies");
  });

  it("no prototype pollution from hostile keys", async () => {
    const hostile =
      file === "pnpm-lock.yaml"
        ? `${lock}\n__proto__:\n  polluted: yes\n`
        : swap(lock, '"packages": {', '"__proto__": { "polluted": "yes" },\n  "packages": { "__proto__": { "polluted": "yes" },');
    const r = await evaluate({ [file]: lock }, { [file]: hostile });
    expect(reasonOf(r)).toContain("could not be parsed");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("package-lock.json", () => {
  const f = "package-lock.json";

  it("a registry URL on another host at the same version trips", async () => {
    const head = swap(NPM, "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz", "https://registry.evil.example/is-number/-/is-number-6.0.0.tgz");
    const r = await evaluate({ [f]: NPM }, { [f]: head });
    expect(reasonOf(r)).toContain("1 changed");
    expect(subjectsOf(r)).toEqual(["is-number"]);
  });

  it("a transitive-only re-resolve trips", async () => {
    const head = swap(swap(NPM, '"version": "6.0.0"', '"version": "6.0.1"'), "is-number-6.0.0.tgz", "is-number-6.0.1.tgz");
    expect(subjectsOf(await evaluate({ [f]: NPM }, { [f]: head }))).toEqual(["is-number"]);
  });

  it("a new transitive entry trips and reports what was added", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, unknown> };
    doc.packages["node_modules/@scope/left-pad"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/x.tgz", integrity: NEW_HASH };
    const r = await evaluate({ [f]: NPM }, { [f]: JSON.stringify(doc, null, 2) });
    expect(reasonOf(r)).toContain("1 added");
    expect(subjectsOf(r)).toEqual(["@scope/left-pad"]);
  });

  it("a removed entry trips", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, unknown> };
    delete doc.packages["node_modules/ms"];
    const r = await evaluate({ [f]: NPM }, { [f]: JSON.stringify(doc, null, 2) });
    expect(reasonOf(r)).toContain("1 removed");
    expect(subjectsOf(r)).toEqual(["ms"]);
  });

  it("a flag on an entry trips: install scripts are part of what's resolved", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, Record<string, unknown>> };
    doc.packages["node_modules/ms"]!.hasInstallScript = true;
    expect((await evaluate({ [f]: NPM }, { [f]: JSON.stringify(doc, null, 2) })).kind).toBe("needsApproval");
  });

  it("reordered keys pass: same content", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, unknown> };
    doc.packages = Object.fromEntries(Object.entries(doc.packages).reverse());
    const head = JSON.stringify(Object.fromEntries(Object.entries(doc).reverse()), null, 2);
    expect(head).not.toBe(NPM);
    expect(await evaluate({ [f]: NPM }, { [f]: head })).toEqual({ kind: "pass" });
  });

  it("tabs for indentation pass: same content", async () => {
    expect(await evaluate({ [f]: NPM }, { [f]: JSON.stringify(JSON.parse(NPM), null, "\t") })).toEqual({ kind: "pass" });
  });

  it("a duplicated key trips, even with the good value last", async () => {
    const dup = swap(NPM, '"node_modules/ms": {', '"node_modules/ms": { "version": "6.6.6" },\n    "node_modules/ms": {');
    expect(reasonOf(await evaluate({ [f]: NPM }, { [f]: dup }))).toContain("could not be parsed");
  });

  it("the package's own name and version bumping in the lockfile pass", async () => {
    const head = NPM.replaceAll('"version": "1.0.0"', '"version": "1.0.1"');
    expect(await evaluate({ [f]: NPM, "package.json": MANIFEST }, { [f]: head, "package.json": swap(MANIFEST, '"version":"1.0.0"', '"version":"1.0.1"') })).toEqual({ kind: "pass" });
  });

  it("the root's hasInstallScript appearing in the lockfile trips", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, Record<string, unknown>> };
    doc.packages[""]!.hasInstallScript = true;
    expect(subjectsOf(await evaluate({ [f]: NPM }, { [f]: JSON.stringify(doc, null, 2) }))).toEqual(["(root)"]);
  });

  it("a root dependency changing in the lockfile trips", async () => {
    expect((await evaluate({ [f]: NPM }, { [f]: swap(NPM, '"is-odd": "3.0.1"', '"is-odd": "3.0.0"') })).kind).toBe("needsApproval");
  });

  it("v1 lockfiles compare too", async () => {
    const v1 = JSON.stringify({ name: "x", lockfileVersion: 1, dependencies: { a: { version: "1.0.0", integrity: OLD_HASH } } });
    expect(subjectsOf(await evaluate({ [f]: v1 }, { [f]: v1.replace(OLD_HASH, NEW_HASH) }))).toEqual(["a"]);
  });

  it("npm-shrinkwrap.json is treated the same", async () => {
    expect((await evaluate({ "npm-shrinkwrap.json": NPM }, { "npm-shrinkwrap.json": swap(NPM, OLD_HASH, NEW_HASH) })).kind).toBe("needsApproval");
  });
});

describe("pnpm-lock.yaml", () => {
  const f = "pnpm-lock.yaml";

  it("a tarball URL added at the same version trips", async () => {
    const head = swap(PNPM, `resolution: {integrity: ${OLD_HASH}}`, `resolution: {integrity: ${OLD_HASH}, tarball: https://evil.example/is-number.tgz}`);
    expect(subjectsOf(await evaluate({ [f]: PNPM }, { [f]: head }))).toEqual(["is-number@6.0.0"]);
  });

  it("a transitive-only re-resolve trips", async () => {
    const r = await evaluate({ [f]: PNPM }, { [f]: PNPM.replaceAll("is-number@6.0.0", "is-number@6.0.1").replace("is-number: 6.0.0", "is-number: 6.0.1") });
    expect(r.kind).toBe("needsApproval");
    expect(subjectsOf(r)).toEqual(expect.arrayContaining(["is-number@6.0.0", "is-number@6.0.1", "is-odd@3.0.1"]));
  });

  it("a specifier in an importer trips", async () => {
    const r = await evaluate({ [f]: PNPM }, { [f]: swap(PNPM, "specifier: 2.1.3", "specifier: ^2.1.3") });
    expect(subjectsOf(r)).toEqual(["importers/."]);
  });

  it("a scalar with the same number but different text trips", async () => {
    expect((await evaluate({ [f]: "lockfileVersion: 9.0\n" }, { [f]: "lockfileVersion: 9.00\n" })).kind).toBe("needsApproval");
  });

  it.each([
    ["an alias", "x: &a {b: 1}\ny: *a\n"],
    ["an alias to a scalar", "x: &a one\ny: *a\n"],
    ["an alias bomb", 'a: &a ["x","x"]\nb: &b [*a,*a]\nc: &c [*b,*b]\nd: &d [*c,*c]\n'],
    ["a merge key", "x: {b: 1}\ny:\n  <<: {c: 2}\n"],
    ["a nested merge key", "packages:\n  a@1.0.0:\n    resolution:\n      <<: {tarball: x}\n"],
    ["a duplicated key", "packages:\n  a@1.0.0: {}\n  a@1.0.0: {resolution: {tarball: x}}\n"],
    ["a duplicated section", "packages: {}\npackages: {}\n"],
    ["several documents", "a: 1\n---\nb: 2\n"],
    ["a custom tag", "a: !!js/function 'x'\n"],
    ["a nested __proto__", "packages:\n  a@1.0.0:\n    __proto__: {polluted: yes}\n"],
    ["over-deep nesting", `a: ${"[".repeat(100)}${"]".repeat(100)}\n`],
  ])("%s can't be compared, so it trips", async (_name, head) => {
    expect(reasonOf(await evaluate({ [f]: PNPM }, { [f]: head }))).toContain("could not be parsed");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // Parsing is synchronous, so nothing can interrupt a stall. The library's own duplicate check took 96s on a lockfile
  // this shape at 8 MB; our check over the whole document takes about 3s. The bound is generous, to catch a return to
  // quadratic behaviour without being flaky on a slow runner.
  it("an ordinary lockfile near the size cap doesn't stall", { timeout: 60_000 }, async () => {
    const lock = (bump: string) => `lockfileVersion: '9.0'\npackages:\n${Array.from({ length: 40_000 }, (_, i) => `  p${i}@1.0.0: {resolution: {integrity: sha512-${"x".repeat(100)}}}\n`).join("")}${bump}`;
    const started = performance.now();
    const r = await evaluate({ [f]: lock("") }, { [f]: lock("  new@1.0.0: {}\n") });
    expect(subjectsOf(r)).toEqual(["new@1.0.0"]);
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  it("an alias trips even when it expands to identical content", async () => {
    const r = await evaluate({ [f]: "x: {b: 1}\ny: {b: 1}\n" }, { [f]: "x: &a {b: 1}\ny: *a\n" });
    expect(reasonOf(r)).toContain("could not be parsed");
  });

  it("an alias in base trips too", async () => {
    expect(reasonOf(await evaluate({ [f]: "x: &a {b: 1}\ny: *a\n" }, { [f]: PNPM }))).toContain("could not be parsed");
  });

  it("reordered sections pass: same content", async () => {
    const [head, snapshots] = PNPM.split("snapshots:");
    const reordered = `snapshots:${snapshots!.trimEnd()}\n\n${head!}`;
    expect(await evaluate({ [f]: PNPM }, { [f]: reordered })).toEqual({ kind: "pass" });
  });
});

describe("bun.lock", () => {
  const f = "bun.lock";

  it("a version change in a package entry trips", async () => {
    expect(subjectsOf(await evaluate({ [f]: BUN }, { [f]: swap(BUN, '"is-number@6.0.0"', '"is-number@6.0.1"') }))).toEqual(["is-number"]);
  });

  it("a workspace dependency change trips", async () => {
    expect(subjectsOf(await evaluate({ [f]: BUN }, { [f]: swap(BUN, '"ms": "2.1.3"', '"ms": "^2.1.3"') }))).toEqual(["workspaces/(root)"]);
  });

  it("the project's own name changing passes", async () => {
    expect(await evaluate({ [f]: BUN }, { [f]: swap(BUN, '"name": "sample"', '"name": "renamed"') })).toEqual({ kind: "pass" });
  });

  it("a comment can't be compared, so it trips", async () => {
    expect(reasonOf(await evaluate({ [f]: BUN }, { [f]: `// hello\n${BUN}` }))).toContain("could not be parsed");
  });
});

describe("files it can't compare", () => {
  it.each([
    ["bun.lockb"],
    ["yarn.lock"],
    ["apps/web/.npmrc"],
    [".yarnrc"],
    [".yarnrc.yml"],
    [".yarn/plugins/x.cjs"],
    [".yarn/releases/yarn-4.cjs"],
    [".yarn/cache/x.zip"],
    [".pnp.cjs"],
    [".pnp.loader.mjs"],
    ["bunfig.toml"],
    [".pnpmfile.cjs"],
    [".pnpmfile.mjs"],
    ["pnpm-workspace.yaml"],
    ["package.yaml"],
    ["apps/web/package.json5"],
    ["binding.gyp"],
    ["requirements/base.txt"],
    ["requirements/ci/test.txt"],
    ["node_modules/evil/package.json"],
    ["apps/web/node_modules/evil/package-lock.json"],
    ["patches/package.json"],
    ["p\u0430ckage.json"],
    ["package.json."],
    ["package.json "],
    [".npmrc."],
    ["pnpm-lock.yaml."],
    ["b\u03C5n.lock"],
    ["\uFF50ackage-lock.json"],
    ["package\u200D.json"],
    ["patches/lodash.patch"],
    ["node_modules/x/index.js"],
    ["uv.lock"],
    ["poetry.lock"],
    ["Pipfile"],
    ["Pipfile.lock"],
    ["services/api/pyproject.toml"],
    ["requirements.txt"],
    ["requirements-dev.txt"],
  ])("any change to %s trips", async (file) => {
    const r = await evaluate({ [file]: "a" }, { [file]: "b" });
    expect(reasonOf(r)).toContain("controls dependencies");
  });

  it("a binary lockfile that can't be read as text still trips", async () => {
    expect(reasonOf(await evaluate({}, {}, ["bun.lockb"]))).toContain("could not be read");
  });

  it("a binary lockfile deleted trips", async () => {
    expect((await evaluate({ "bun.lockb": "x" }, {})).kind).toBe("needsApproval");
  });

  it("unchanged content passes, say a mode-only change", async () => {
    expect(await evaluate({ "yarn.lock": "a" }, { "yarn.lock": "a" }, ["yarn.lock"])).toEqual({ kind: "pass" });
  });

  it("everything the guardrail's own globs route here gets a kind: nothing passes by falling through", async () => {
    const samples = DEPENDENCY_CHANGE_GLOBS.map((g) => g.replace(/\*\*\//g, "x/").replace(/\/\*\*/g, "/y").replace(/\*/g, "z"));
    for (const path of samples) expect(reasonOf(await evaluate({ [path]: "{}" }, { [path]: '{"dependencies":{"a":"1"}}' }))).not.toBe("");
  });

  it("a file that has nothing to do with dependencies is ignored", async () => {
    expect(await evaluate({ "src/a.ts": "a" }, { "src/a.ts": "b" })).toEqual({ kind: "pass" });
  });
});

describe("package.json", () => {
  const f = "package.json";
  const edit = (change: Manifest) => JSON.stringify({ ...(JSON.parse(MANIFEST) as Manifest), ...change }, null, 2);

  // Decision (see the comment on NON_DEPENDENCY_FIELDS): scripts run in CI, but so does every source file in the PR.
  it.each<[string, Manifest]>([
    ["a script", { scripts: { test: "vitest" } }],
    ["an ordinary script alongside unchanged hooks", { scripts: { test: "vitest", build: "tsc" } }],
    ["the description", { description: "hello" }],
    ["the version", { version: "2.0.0" }],
    ["engines", { engines: { node: ">=24" } }],
  ])("changing %s with an identical lockfile passes", async (_name, change) => {
    expect(await evaluate({ [f]: MANIFEST, "package-lock.json": NPM }, { [f]: edit(change), "package-lock.json": NPM }, [f])).toEqual({ kind: "pass" });
  });

  it.each<[string, Manifest]>([
    ["dependencies", { dependencies: { "is-odd": "3.0.0" } }],
    ["devDependencies", { devDependencies: {} }],
    ["a new optionalDependencies", { optionalDependencies: { x: "1" } }],
    ["peerDependencies", { peerDependencies: { x: "1" } }],
    ["overrides", { overrides: { "is-number": "1.0.0" } }],
    ["resolutions", { resolutions: { "is-number": "1.0.0" } }],
    ["pnpm settings", { pnpm: { overrides: {} } }],
    ["workspaces", { workspaces: ["x"] }],
    ["packageManager", { packageManager: "npm@1.0.0" }],
    ["a field it doesn't know", { somethingNew: true }],
  ])("changing %s with no lockfile change trips", async (_name, change) => {
    const r = await evaluate({ [f]: MANIFEST, "package-lock.json": NPM }, { [f]: edit(change), "package-lock.json": NPM }, [f]);
    expect(reasonOf(r)).toContain("with no lockfile change");
  });

  it.each(["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish", "dependencies", "pnpm:devPreinstall"])(
    "adding, changing or removing the %s hook trips, with an identical lockfile",
    async (hook) => {
      const withHook = edit({ scripts: { [hook]: "node a.js" } });
      const trips = async (base: string, head: string) => reasonOf(await evaluate({ [f]: base, "package-lock.json": NPM }, { [f]: head, "package-lock.json": NPM }, [f]));
      expect(await trips(MANIFEST, withHook)).toContain("install hooks changed");
      expect(await trips(withHook, edit({ scripts: { [hook]: "node b.js" } }))).toContain("install hooks changed");
      expect(await trips(withHook, MANIFEST)).toContain("install hooks changed");
    },
  );

  it("a hook in a nested or new manifest trips", async () => {
    const m = "apps/web/package.json";
    expect(reasonOf(await evaluate({ [m]: MANIFEST }, { [m]: edit({ scripts: { postinstall: "x" } }) }))).toContain("install hooks changed");
    expect(reasonOf(await evaluate({}, { [m]: '{"scripts":{"preinstall":"x"}}' }))).toContain("install hooks changed");
  });

  it("an unchanged hook doesn't trip when another script changes", async () => {
    const withHook = edit({ scripts: { prepare: "husky", test: "a" } });
    expect(await evaluate({ [f]: withHook }, { [f]: edit({ scripts: { prepare: "husky", test: "b" } }) })).toEqual({ kind: "pass" });
  });

  it("a scripts field that isn't a map compares whole", async () => {
    expect(reasonOf(await evaluate({ [f]: MANIFEST }, { [f]: edit({ scripts: "postinstall" }) }))).toContain("install hooks changed");
  });

  it("a dependency change with a lockfile change trips and says what changed", async () => {
    const head = { [f]: edit({ dependencies: { "is-odd": "3.0.0" } }), "package-lock.json": swap(NPM, OLD_HASH, NEW_HASH) };
    const r = await evaluate({ [f]: MANIFEST, "package-lock.json": NPM }, head);
    expect(reasonOf(r)).toContain("a manifest's dependency fields changed");
    expect(reasonOf(r)).not.toContain("with no lockfile change");
    expect(subjectsOf(r)).toEqual(["is-number"]);
  });

  it.each([
    ["invalid JSON", "{ nope"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["a duplicated key", '{"dependencies":{"x":"1"},"dependencies":{}}'],
    ["__proto__", '{"__proto__":{"dependencies":{"x":"1"}}}'],
  ])("%s trips", async (_name, head) => {
    const r = await evaluate({ [f]: MANIFEST }, { [f]: head });
    expect(reasonOf(r)).toContain("could not be parsed");
  });

  it("a huge manifest trips", async () => {
    expect(reasonOf(await evaluate({ [f]: MANIFEST }, { [f]: " ".repeat(MAX_LOCKFILE_CHARS + 1) }))).toContain("too large");
  });

  it("a new manifest with no dependencies passes, one with some trips", async () => {
    expect(await evaluate({}, { "e2e/package.json": '{"type":"module"}' })).toEqual({ kind: "pass" });
    expect((await evaluate({}, { "e2e/package.json": '{"dependencies":{"x":"1"}}' })).kind).toBe("needsApproval");
  });

  it("deleting a manifest with dependencies trips", async () => {
    expect((await evaluate({ [f]: MANIFEST }, {})).kind).toBe("needsApproval");
  });

  it("listed as changed but unreadable on both sides trips", async () => {
    expect(reasonOf(await evaluate({}, {}, [f]))).toContain("could not be read");
  });

  it("another spelling of the name trips on any change", async () => {
    expect(reasonOf(await evaluate({ "Package.json": MANIFEST }, { "Package.json": `${MANIFEST}\n` }))).toContain("controls dependencies");
  });
});

describe("output", () => {
  it("is the same for the same diff, whatever the file order", async () => {
    const base = { "a/package-lock.json": NPM, "b/package-lock.json": NPM };
    const head = { "a/package-lock.json": swap(NPM, OLD_HASH, NEW_HASH), "b/package-lock.json": swap(NPM, "sha512-6Fl", "sha512-7Fl") };
    expect(await evaluate(base, head, ["a/package-lock.json", "b/package-lock.json"])).toEqual(await evaluate(base, head, ["b/package-lock.json", "a/package-lock.json"]));
  });

  it("the reason is fixed text and counts; names only in subjects", async () => {
    const doc = JSON.parse(NPM) as { packages: Record<string, unknown> };
    doc.packages["node_modules/<!-- evil @team -->"] = { version: "1.0.0" };
    const r = await evaluate({ "package-lock.json": NPM }, { "package-lock.json": JSON.stringify(doc) });
    expect(reasonOf(r)).toBe("Dependency change. lockfile entries: 1 added.");
    expect(subjectsOf(r)).toEqual(["<!-- evil @team -->"]);
  });
});

describe("refusedBeforeParsing", () => {
  it.each([
    ["an anchor", "x: &a 1\n"],
    ["an alias", "x: 1\ny: *a\n"],
    ["a tag", "x: !!str 1\n"],
    ["an anchor as a key", "&a x: 1\n"],
    ["an anchor at the very start", "&x &x &x"],
    ["in a sequence", "- &a 1\n"],
    ["in a nested sequence", "- - - *a\n"],
    ["on a complex key", "? &a x\n: 1\n"],
    ["on a document marker", "x: 1\n--- &a\ny: 2\n"],
    ["in a flow map", "x: {a: &b 1}\n"],
    ["after a flow comma", "x: [1, *a]\n"],
    ["right after a quoted key", '{"a":&x 1}'],
    ["after a quoted value", '{"a":"b","c":*x}'],
    ["on the line after a key", "x:\n  &a y\n"],
    ["flow nesting past the limit", "[".repeat(100)],
    ["a closing bracket with nothing open", "]"],
    ["a quote after a closing quote", '""""'],
    ["a closing brace with nothing open", "a: }\n"],
    ["a tag after a closed quote in flow", "['a', !x b]"],
  ])("finds %s", (_name, text) => {
    expect(refusedBeforeParsing(text)).toBe(true);
  });

  it.each([
    ["text in double quotes", '"a": "&x *y !z"\n'],
    ["an escaped quote then text", '"a": "\\" &x"\n'],
    ["text in single quotes", "a: '&x *y'\n"],
    ["an escaped single quote", "a: 'it''s &x'\n"],
    ["a quoted star, as pnpm writes it", "specifier: '*'\n"],
    ["characters inside a plain value", "deprecated: use a, *not* b & !c\n"],
    ["a URL", "tarball: https://x.example/a&b=*\n"],
    ["a comment", "# &x\na: 1 # *y\n"],
    ["a plain value with an ampersand first after text", "a: b&c\n"],
    ["a version range", "a: ^1.0.0 || >=2\n"],
    ["a bracket inside a plain value", "a: b]c}\n"],
    ["a peer suffix", "foo@1.0.0(bar@2.0.0): {}\n"],
    ["JSON with trailing commas", '{"a": ["x", "", {}, "y",],}'],
    ["empty text", ""],
  ])("allows %s", (_name, text) => {
    expect(refusedBeforeParsing(text)).toBe(false);
  });

  it.each([
    ["package-lock.json", NPM],
    ["pnpm-lock.yaml", PNPM],
    ["bun.lock", BUN],
    ["package.json", MANIFEST],
    ["this repo's own pnpm-lock.yaml", fs.readFileSync(new URL("../../../../pnpm-lock.yaml", import.meta.url), "utf8")],
  ])("allows the real file: %s", (_name, text) => {
    expect(refusedBeforeParsing(text)).toBe(false);
  });

  // These took from 12s to over 50s at 480 KB when they reached the parser. Refused before it, they don't depend on size,
  // so the bound is far from anything a slow runner would hit.
  it.each([
    ["anchors", "&x "],
    ["tags", "!x "],
    ["anchors in a map", "a: &x\n"],
    ["aliases in a sequence", "- *x\n"],
    ["closing brackets", "]"],
    ["closing braces", "}"],
    ["double quotes", '"'],
  ])("a file full of %s is refused without reaching the parser", { timeout: 20_000 }, async (_name, unit) => {
    const text = unit.repeat(Math.floor((MAX_LOCKFILE_CHARS - 1) / unit.length));
    const started = performance.now();
    expect(reasonOf(await evaluate({ "pnpm-lock.yaml": PNPM }, { "pnpm-lock.yaml": text }))).toContain("could not be parsed");
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
