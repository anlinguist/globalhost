import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateGuardrails,
  evaluatePathPolicy,
  guardrailInputsFor,
  IMMUTABLE_BASELINE,
  INSTRUCTION_SURFACE_GLOBS,
  LOAD_BEARING_LABEL,
  MAX_RESULT_PATHS,
  pathForms,
  PROD_CREDENTIAL_GLOBS,
  safePath,
  safeText,
  type ApprovalEvidence,
  type ChangedFile,
  type FactoryConfig,
  type Guardrail,
  type GuardrailEngineInput,
  type GuardrailResult,
  type LabelEvent,
} from "../src/index.js";

const HEAD = "a".repeat(40);
const approvalNone: ApprovalEvidence = { headSha: HEAD, lastPushAt: "2026-11-04T10:00:00Z", ownerIds: [1001], appActorIds: [9001], currentLabels: [], events: [], eventsComplete: true };
const ownerLabel = (label: string): LabelEvent => ({ action: "labeled", label, actor: { id: 1001, type: "User" }, at: "2026-11-04T11:00:00Z", headSha: HEAD });
const approved = (...labels: string[]): ApprovalEvidence => ({ ...approvalNone, currentLabels: labels, events: labels.map(ownerLabel) });

const DECLARED = [{ part: "web", adapter: "deployer", set: { globs: ["deploy/release.conf"] } }];
const PLAIN = ["100644", "100644"];
const files = (...paths: string[]): ChangedFile[] => paths.map((path) => ({ path, modes: PLAIN }));

function input(over: Partial<GuardrailEngineInput> = {}): GuardrailEngineInput {
  return {
    files: files("src/app.ts"),
    filesComplete: true,
    config: { loadBearing: [], immutable: [] },
    guardrails: [],
    releaseSets: DECLARED,
    unknownProfiles: [],
    diff: { readBase: () => Promise.resolve(undefined), readHead: () => Promise.resolve(undefined) },
    approval: approvalNone,
    ...over,
  };
}
const run = (over: Partial<GuardrailEngineInput> = {}) => evaluateGuardrails(input(over));
const tripped = async (over: Partial<GuardrailEngineInput>) => (await run(over)).entries.filter((e) => e.verdict !== "pass").map((e) => e.id);
const onlyPath = (path: string) => tripped({ files: files(path) });

const check = (over: Partial<Guardrail> = {}, result: GuardrailResult | (() => unknown) = { kind: "needsApproval", reason: "looked at it" }): Guardrail => ({
  id: "sample-check",
  paths: ["**/sample.lock"],
  approvalLabel: "approved:sample",
  evaluate: (() => Promise.resolve(typeof result === "function" ? result() : result)) as Guardrail["evaluate"],
  ...over,
});

describe("trigger constants", () => {
  it("match ADR-0015 §8 exactly: a change here is a change to the ADR", () => {
    expect(INSTRUCTION_SURFACE_GLOBS).toEqual(["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/**", ".mcp.json", "docs/product/**", "skills/**"]);
    expect(PROD_CREDENTIAL_GLOBS).toEqual(["factory.yaml", ".github/**"]);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(INSTRUCTION_SURFACE_GLOBS)).toBe(true);
    expect(Object.isFrozen(PROD_CREDENTIAL_GLOBS)).toBe(true);
  });
});

describe("path triggers", () => {
  it("a plain source change trips nothing", async () => {
    const report = await run();
    expect(report.verdict).toBe("pass");
    expect(report.entries.every((e) => e.verdict === "pass")).toBe(true);
  });

  it.each([
    "CLAUDE.md",
    "apps/web/CLAUDE.md",
    "a/b/c/CLAUDE.md",
    "claude.md",
    "Apps/Web/Claude.MD",
    "CLAUDE.local.md",
    "x/claude.LOCAL.md",
    "AGENTS.md",
    "x/agents.md",
    ".claude/settings.json",
    ".CLAUDE/x",
    "apps/web/.claude/skills/y/SKILL.md",
    ".mcp.json",
    ".MCP.JSON",
    "docs/product/SPEC.md",
    "Docs/Product/x",
    "skills/web-app/SKILL.md",
    "SKILLS/x",
  ])("instruction surface: %s", async (path) => {
    expect(await onlyPath(path)).toContain("instruction-surface");
  });

  it.each(["factory.yaml", "FACTORY.YAML", ".github/workflows/ci.yml", ".GitHub/x", ".github/CODEOWNERS"])("prod credential: %s", async (path) => {
    const hits = await onlyPath(path);
    expect(hits).toContain("prod-credential");
    expect(hits).toContain("immutable");
  });

  it.each(["CODEOWNERS", "docs/CODEOWNERS", "run.json", "x/REVIEW.JSON", "x/inputs.json. "])("immutable baseline and harness records: %j", async (path) => {
    expect(await onlyPath(path)).toContain("immutable");
  });

  it.each(["docs/CLAUDE.txt", "notes/skills/x.md", "docs/products/x", "myCLAUDE.md", "x/.claudefile", "skills.md", ".github2/x", "src/github/x.ts"])(
    "doesn't trip on a near miss: %s",
    async (path) => {
      expect(await onlyPath(path)).toEqual([]);
    },
  );

  it("decision: factory.yaml or .github in a subdirectory is an ordinary file, since only the root's is read", async () => {
    expect(await onlyPath("apps/web/factory.yaml")).toEqual([]);
    expect(await onlyPath("apps/web/.github/workflows/ci.yml")).toEqual([]);
  });

  it("agrees with the publisher: whatever the path policy refuses, the engine trips", async () => {
    const paths = [".github/x", "factory.yaml", "Factory.YAML", "CODEOWNERS", "run.json", "a/INPUTS.JSON", "secret.env", "./x", "a/../b"];
    const immutable = [...IMMUTABLE_BASELINE, "*.env"];
    for (const path of paths) {
      const policy = evaluatePathPolicy([path], { immutable, loadBearing: [] });
      expect(policy.rejected.length + policy.malformed.length).toBe(1);
      const hits = await tripped({ files: files(path), config: { loadBearing: [], immutable } });
      expect(hits.some((id) => id === "immutable" || id === "malformed-path")).toBe(true);
    }
  });

  it("adds the immutable baseline even if the caller leaves it out", async () => {
    expect(await tripped({ files: files("CODEOWNERS"), config: { loadBearing: [], immutable: [] } })).toEqual(["immutable"]);
  });
});

describe("path spellings", () => {
  it.each([
    [".github/../.github/x", ["malformed-path", "prod-credential", "immutable"]],
    ["./CLAUDE.md", ["malformed-path", "instruction-surface"]],
    ["src/../CLAUDE.md", ["malformed-path", "instruction-surface"]],
    [".github\\workflows\\x.yml", ["malformed-path", "prod-credential", "immutable"]],
    [".github//x", ["malformed-path", "prod-credential", "immutable"]],
    ["/factory.yaml", ["malformed-path", "prod-credential", "immutable"]],
    ["../outside", ["malformed-path"]],
    ["a\nb", ["malformed-path"]],
    ["", ["malformed-path"]],
  ])("malformed %j fails and still counts against what it resolves to", async (path, want) => {
    const report = await run({ files: files(path) });
    expect(report.entries.filter((e) => e.verdict !== "pass").map((e) => e.id)).toEqual(want);
    expect(report.verdict).toBe("fail");
  });

  it.each([
    ["Cyrillic С", "СLAUDE.md", "instruction-surface"],
    ["Cyrillic а", "CLАUDE.md", "instruction-surface"],
    ["Cyrillic і in .github", ".gіthub/x", "prod-credential"],
    ["fullwidth letters", "ＣＬＡＵＤＥ.md", "instruction-surface"],
    ["fullwidth slash", ".github／x", "prod-credential"],
    ["long s, which case-folds to s", "ſkills/x", "instruction-surface"],
    ["Kelvin sign, which lowercases to k", "sKills/x", "instruction-surface"],
    ["zero-width joiner", "CLAUDE‍.md", "instruction-surface"],
    ["bidi control", ".git‮hub/x", "prod-credential"],
    ["combining mark", "CLAUDÉ.md", "instruction-surface"],
    ["trailing dot", "CLAUDE.md.", "instruction-surface"],
    ["trailing space", "factory.yaml ", "prod-credential"],
    ["trailing dot on a directory", ".github./x", "prod-credential"],
  ])("a lookalike trips the real name's trigger: %s", async (_name, path, want) => {
    expect(await onlyPath(path)).toContain(want);
  });

  it("forms keep the original and add resolved and folded spellings", () => {
    expect(pathForms("./Docs/../СLAUDE.md")).toEqual(expect.arrayContaining(["./Docs/../СLAUDE.md", "СLAUDE.md", "claude.md"]));
    expect(pathForms("plain.ts")).toEqual(["plain.ts"]);
  });
});

describe("renames and modes", () => {
  it("a rename out of a protected path trips", async () => {
    expect(await tripped({ files: [{ path: "src/x.md", previousPath: "CLAUDE.md", modes: PLAIN }] })).toEqual(["instruction-surface"]);
    expect(await tripped({ files: [{ path: "src/ci.yml", previousPath: ".github/workflows/ci.yml", modes: PLAIN }] })).toEqual(["prod-credential", "immutable"]);
  });

  it("a rename into a protected path trips", async () => {
    expect(await tripped({ files: [{ path: "skills/x/SKILL.md", previousPath: "src/x.md", modes: PLAIN }] })).toEqual(["instruction-surface"]);
  });

  it("both names are reported", async () => {
    const { entries } = await run({ files: [{ path: "src/x.md", previousPath: "CLAUDE.md", modes: PLAIN }], config: { loadBearing: ["src/**"], immutable: [] } });
    expect(entries.find((e) => e.id === "instruction-surface")?.paths).toEqual(["CLAUDE.md"]);
    expect(entries.find((e) => e.id === "load-bearing")?.paths).toEqual(["src/x.md"]);
  });

  it("a malformed old name fails", async () => {
    expect(await tripped({ files: [{ path: "src/x.md", previousPath: "../CLAUDE.md", modes: PLAIN }] })).toContain("malformed-path");
  });

  it.each([
    ["a new symlink", ["000000", "120000"]],
    ["a symlink replaced by a file", ["120000", "100644"]],
    ["a submodule", ["160000", "160000"]],
    ["an unknown type", ["140000", "100644"]],
    ["no recorded mode", []],
  ])("%s trips, and no label clears it", async (_name, modes) => {
    const report = await run({ files: [{ path: "docs/notes", modes }], approval: approved("approved:load-bearing") });
    const e = report.entries.find((x) => x.id === "redirecting-file");
    expect(e?.verdict).toBe("needsApproval");
    expect(e?.approvalLabel).toBeNull();
    expect(report.verdict).toBe("needsApproval");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "100644"],
  ])("modes that are %s at runtime trip rather than throw", async (_name, modes) => {
    const report = await run({ files: [{ path: "docs/notes", modes } as unknown as ChangedFile] });
    expect(report.entries.find((e) => e.id === "redirecting-file")?.verdict).toBe("needsApproval");
    expect(report.verdict).toBe("needsApproval");
  });

  it("ordinary modes, an executable bit included, don't trip", async () => {
    expect(await tripped({ files: [{ path: "bin/run", modes: ["100644", "100755"] }, { path: "gone", modes: ["100644", "000000"] }] })).toEqual([]);
  });
});

describe("file list", () => {
  it.each([
    ["empty", { files: [] }],
    ["incomplete", { filesComplete: false }],
  ])("an %s list fails", async (_name, over) => {
    const report = await run(over);
    expect(report.entries.find((e) => e.id === "file-list")?.verdict).toBe("fail");
    expect(report.verdict).toBe("fail");
  });
});

describe("loadBearing", () => {
  it("adds a trigger, cleared only by its own label", async () => {
    const over = { files: files("proxy.ts"), config: { loadBearing: ["proxy.ts"], immutable: [] } };
    expect((await run(over)).verdict).toBe("needsApproval");
    const report = await run({ ...over, approval: approved(LOAD_BEARING_LABEL) });
    expect(report.verdict).toBe("pass");
    expect(report.entries.find((e) => e.id === "load-bearing")).toMatchObject({ verdict: "needsApproval", approval: { cleared: true, code: "cleared" } });
    expect((await run({ ...over, approval: approved("approved:deps") })).verdict).toBe("needsApproval");
  });

  it("can't remove a trigger: nothing in the config reaches the constants", async () => {
    // There's no negation syntax, and an empty config changes nothing.
    expect(await tripped({ files: files("CLAUDE.md"), config: { loadBearing: [], immutable: [] } })).toEqual(["instruction-surface"]);
    expect(await tripped({ files: files("CLAUDE.md"), config: { loadBearing: ["!CLAUDE.md", "!**/CLAUDE.md"], immutable: [] } })).toEqual(["instruction-surface"]);
  });

  it("a path that's load-bearing and an instruction surface stays blocked after the label", async () => {
    const report = await run({ files: files("CLAUDE.md"), config: { loadBearing: ["CLAUDE.md"], immutable: [] }, approval: approved(LOAD_BEARING_LABEL) });
    expect(report.entries.find((e) => e.id === "load-bearing")?.approval?.cleared).toBe(true);
    expect(report.entries.find((e) => e.id === "instruction-surface")?.approval).toBeNull();
    expect(report.verdict).toBe("needsApproval");
  });
});

describe("approval labels and non-clearable triggers", () => {
  it.each([
    ["CLAUDE.md", "instruction-surface"],
    [".github/x", "prod-credential"],
    ["deploy/release.conf", "release-set"],
    ["CODEOWNERS", "immutable"],
  ])("no label clears %s", async (path, id) => {
    const labels = [`approved:${id}`, LOAD_BEARING_LABEL, "approved:deps"];
    const report = await run({ files: files(path), approval: approved(...labels) });
    const e = report.entries.find((x) => x.id === id);
    expect(e).toMatchObject({ verdict: "needsApproval", approvalLabel: null, approval: null });
    expect(report.verdict).toBe("needsApproval");
  });

  it("a guardrail's label doesn't clear a failed guardrail", async () => {
    const g = check({}, { kind: "fail", reason: "broken" });
    const report = await run({ files: files("sample.lock"), guardrails: [g], approval: approved("approved:sample") });
    expect(report.entries.find((e) => e.id === "sample-check")).toMatchObject({ verdict: "fail", approvalLabel: null, approval: null });
    expect(report.verdict).toBe("fail");
  });

  it("clears a guardrail with its own label and not with another's", async () => {
    const g = check();
    const over = { files: files("sample.lock"), guardrails: [g] };
    expect((await run({ ...over, approval: approved("approved:sample") })).verdict).toBe("pass");
    const other = await run({ ...over, approval: approved("approved:other") });
    expect(other.verdict).toBe("needsApproval");
    expect(other.entries.find((e) => e.id === "sample-check")?.approval).toEqual({ cleared: false, code: "label-absent" });
  });
});

describe("release execution set", () => {
  it("a change in the set trips and isn't clearable", async () => {
    const hits = await tripped({ files: files("deploy/release.conf") });
    expect(hits).toEqual(["release-set"]);
  });

  it("matches any spelling", async () => {
    expect(await tripped({ files: files("Deploy/RELEASE.conf") })).toEqual(["release-set"]);
  });

  it("no prod parts, nothing to declare", async () => {
    expect(await tripped({ releaseSets: [] })).toEqual([]);
  });

  it("an adapter that declares none trips on every PR", async () => {
    const report = await run({ releaseSets: [{ part: "web", adapter: "deployer", set: undefined }] });
    expect(report.entries.find((e) => e.id === "release-set-undeclared")).toMatchObject({ verdict: "needsApproval", class: "release-set", subjects: ["web/deployer"], approvalLabel: null });
    expect(report.verdict).toBe("needsApproval");
  });
});

describe("guardrailInputsFor", () => {
  const part = (over: Record<string, unknown> = {}) => ({ path: "apps/web", profile: "p", config: {}, preview: { enabled: false, bindings: {} }, release: [{ adapter: "a", config: { x: 1 } }], dependsOn: [], ...over });
  const config = (parts: Record<string, unknown>): Pick<FactoryConfig, "parts" | "guardrails"> =>
    ({ parts, guardrails: { loadBearing: ["lb/**"], immutable: [".github/**"] } }) as Pick<FactoryConfig, "parts" | "guardrails">;
  const profile = { guardrails: { immutable: [".env"], checks: [check()] } };

  it("collects each part's checks, its immutable globs under the part path, and its adapter's set", () => {
    let seen: unknown;
    const adapter = {
      releaseExecutionSet: (p: unknown, cfg: never) => {
        seen = [p, cfg];
        return { globs: ["deploy/x"] };
      },
    };
    const out = guardrailInputsFor(config({ web: part() }), { profile: () => profile, adapter: () => adapter });
    expect(out.config).toEqual({ loadBearing: ["lb/**"], immutable: [".github/**", "apps/web/.env"] });
    expect(out.guardrails).toEqual(profile.guardrails.checks);
    expect(out.releaseSets).toEqual([{ part: "web", adapter: "a", set: { globs: ["deploy/x"] } }]);
    expect(seen).toEqual([{ name: "web", path: "apps/web" }, { x: 1 }]);
    expect(out.unknownProfiles).toEqual([]);
  });

  it("a root part's immutable globs stay as they are", () => {
    const out = guardrailInputsFor(config({ web: part({ path: "." }) }), { profile: () => profile, adapter: () => ({}) });
    expect(out.config.immutable).toContain(".env");
  });

  it.each([
    ["an unregistered adapter", () => undefined],
    ["an adapter with no declaration", () => ({})],
    [
      "a throwing declaration",
      () => ({
        releaseExecutionSet: () => {
          throw new Error("nope");
        },
      }),
    ],
    ["no globs", () => ({ releaseExecutionSet: () => ({ globs: [] }) })],
    ["a malformed glob", () => ({ releaseExecutionSet: () => ({ globs: ["{a,b}"] }) })],
    ["a non-array", () => ({ releaseExecutionSet: () => ({ globs: "x" }) as unknown as { globs: string[] } })],
  ])("%s means none declared", (_name, adapter) => {
    const out = guardrailInputsFor(config({ web: part() }), { profile: () => profile, adapter });
    expect(out.releaseSets).toEqual([{ part: "web", adapter: "a", set: undefined }]);
  });

  it("a part with no release isn't a prod part", () => {
    expect(guardrailInputsFor(config({ web: part({ release: [] }) }), { profile: () => profile, adapter: () => undefined }).releaseSets).toEqual([]);
  });

  it("an unregistered profile can't skip its checks: it fails", async () => {
    const out = guardrailInputsFor(config({ web: part() }), { profile: () => undefined, adapter: () => ({ releaseExecutionSet: () => ({ globs: ["x"] }) }) });
    expect(out.unknownProfiles).toEqual(["web"]);
    const report = await run(out);
    expect(report.entries.find((e) => e.id === "guardrail-config")?.verdict).toBe("fail");
  });
});

describe("guardrails fail closed", () => {
  const verdictOf = async (g: Guardrail) => {
    const report = await run({ files: files("sample.lock"), guardrails: [g], approval: approved("approved:sample"), timeoutMs: 20 });
    return { report, e: report.entries.find((x) => x.class === "guardrail")! };
  };

  it.each([
    [
      "throws",
      () => {
        throw new Error("SECRET-TEXT @everyone");
      },
    ],
    ["rejects", () => Promise.reject(new Error("SECRET-TEXT"))],
    ["returns undefined", () => undefined],
    ["returns a string", () => "pass"],
    ["returns an unknown kind", () => ({ kind: "ok" })],
    ["says needsApproval with no reason", () => ({ kind: "needsApproval" })],
    ["says fail with an empty reason", () => ({ kind: "fail", reason: "" })],
    ["adds fields to pass", () => ({ kind: "pass", reason: "trust me" })],
    ["has a non-string subject", () => ({ kind: "needsApproval", reason: "x", subjects: [1] })],
    ["hangs", () => new Promise(() => undefined)],
  ])("a guardrail that %s fails, with fixed text, and no label clears it", async (_name, result) => {
    const { report, e } = await verdictOf(check({}, result));
    expect(e.verdict).toBe("fail");
    expect(e.approval).toBeNull();
    expect(e.reason).not.toContain("SECRET-TEXT");
    expect(report.verdict).toBe("fail");
  });

  it("a read that throws fails too", async () => {
    const g = check({ evaluate: async (d) => ((await d.readHead("sample.lock")) ? { kind: "pass" } : { kind: "pass" }) });
    const report = await run({ files: files("sample.lock"), guardrails: [g], diff: { readBase: () => Promise.reject(new Error("x")), readHead: () => Promise.reject(new Error("x")) } });
    expect(report.verdict).toBe("fail");
  });

  it.each([
    ["an invalid ID", { id: "Bad ID <!--" }],
    ["a trigger's ID", { id: "instruction-surface" }],
    ["no ID", { id: undefined as unknown as string }],
    ["a label that isn't approved:*", { approvalLabel: "factory:ship" }],
    ["the load-bearing label", { approvalLabel: LOAD_BEARING_LABEL }],
    ["no paths", { paths: [] }],
    ["a glob the dialect doesn't allow", { paths: ["{a,b}"] }],
    ["no evaluate", { evaluate: undefined as unknown as Guardrail["evaluate"] }],
  ])("a guardrail with %s fails instead of being skipped", async (_name, over) => {
    const report = await run({ guardrails: [check(over)] });
    const e = report.entries.find((x) => x.class === "guardrail")!;
    expect(e.verdict).toBe("fail");
    expect(e.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(report.verdict).toBe("fail");
  });

  it("a getter that throws on the definition fails", async () => {
    const g = check();
    Object.defineProperty(g, "id", {
      get: () => {
        throw new Error("boom");
      },
    });
    expect((await run({ guardrails: [g] })).verdict).toBe("fail");
  });

  it("two guardrails sharing a label both fail: a label clears only its own guardrail", async () => {
    const report = await run({ guardrails: [check({ id: "one" }), check({ id: "two" })] });
    expect(report.entries.filter((e) => e.class === "guardrail").map((e) => e.verdict)).toEqual(["fail", "fail"]);
  });

  it("two different guardrails with one ID fail", async () => {
    const report = await run({ guardrails: [check({ approvalLabel: "approved:one" }), check({ approvalLabel: "approved:two" })] });
    expect(report.verdict).toBe("fail");
  });

  it("the same object twice (one profile on two parts) is one guardrail", async () => {
    const g = check();
    const report = await run({ files: files("sample.lock"), guardrails: [g, g] });
    expect(report.entries.filter((e) => e.id === "sample-check")).toHaveLength(1);
    expect(report.verdict).toBe("needsApproval");
  });

  it("isn't run when none of its paths changed", async () => {
    let called = false;
    const g = check({
      evaluate: () => {
        called = true;
        return Promise.resolve({ kind: "pass" });
      },
    });
    const report = await run({ guardrails: [g] });
    expect(called).toBe(false);
    expect(report.entries.find((e) => e.id === "sample-check")?.verdict).toBe("pass");
  });

  it("a guardrail's paths match every spelling too", async () => {
    expect(await tripped({ files: files("x/SAMPLE.LOCK"), guardrails: [check()] })).toEqual(["sample-check"]);
    expect(await tripped({ files: [{ path: "x", previousPath: "sample.lock", modes: PLAIN }], guardrails: [check()] })).toEqual(["sample-check"]);
  });

  it("guardrails get a private copy of the file list, without malformed paths", async () => {
    const seen: string[][] = [];
    const a = check({
      id: "a-check",
      approvalLabel: "approved:a",
      evaluate: (d) => {
        seen.push([...d.files]);
        d.files.length = 0;
        return Promise.resolve({ kind: "pass" });
      },
    });
    const b = check({
      id: "b-check",
      approvalLabel: "approved:b",
      evaluate: (d) => {
        seen.push([...d.files]);
        return Promise.resolve({ kind: "pass" });
      },
    });
    await run({ files: files("sample.lock", "a/../b"), guardrails: [a, b] });
    expect(seen).toEqual([["sample.lock"], ["sample.lock"]]);
  });
});

// Assembled here so secret scanners do not flag a test value.
const FAKE_TOKEN = ["ghp", "0123456789abcdef0123456789abcdef0123"].join("_");

describe("results are safe to post", () => {
  const nasty = [
    "x/@everyone.md",
    "x/<!-- hide -->.md",
    "x/`code`.md",
    "x/[link](https:evil.example).md",
    "x/a\nb.md",
    "x/‮reversed.md",
    "x/​hidden.md",
    "x/\uD800lone.md",
    "x/#123.md",
    "x/%41.md",
    `x/${FAKE_TOKEN}.md`,
    `x/${"y".repeat(5000)}`,
  ];

  it.each(nasty)("safePath leaves nothing to render: %j", (path) => {
    const out = safePath(path);
    expect(out).toMatch(/^[A-Za-z0-9._/+%-]*$/);
    expect(out.length).toBeLessThanOrEqual(303);
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("safePath leaves ordinary paths readable and shows a lookalike as bytes", () => {
    expect(safePath("src/app/page-1.tsx")).toBe("src/app/page-1.tsx");
    expect(safePath("СLAUDE.md")).toBe("%D0%A1LAUDE.md");
  });

  it("safePath stops a bare www name from linking", () => {
    expect(safePath("www.evil.example/x")).toBe("www%2Eevil.example/x");
    expect(safePath("WWW.evil.example")).toBe("WWW%2Eevil.example");
    expect(safePath("src/awww.ts")).toBe("src/awww.ts");
  });

  it("safePath doesn't cut an escape in half", () => {
    const out = safePath("é".repeat(200));
    expect(out).toMatch(/(%[0-9A-F]{2})+\.\.\.$/);
  });

  it("safeText keeps prose and drops markup, pings, links and secrets", () => {
    expect(safeText("Dependency change. 2 added, 1 removed.")).toBe("Dependency change. 2 added, 1 removed.");
    const out = safeText(`x @team <!-- y --> \`z\` [a](https://evil.example) \n ${FAKE_TOKEN}`);
    expect(out).toMatch(/^[A-Za-z0-9 .,:;()/_=+'?-]*$/);
    expect(out).not.toContain("://");
    expect(out).not.toContain("ghp_0123");
    expect(safeText("see www.evil.example and WWW.evil.example now")).toBe("see www?evil.example and WWW?evil.example now");
    expect(safeText("<>").length).toBeGreaterThan(0);
    expect(safeText("")).toBe("no reason given");
    expect(safeText("y".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("no entry of a report carries raw attacker text", async () => {
    const g = check({}, { kind: "needsApproval", reason: "bad @team <!-- x -->", subjects: ["@scope/pkg", "<img src=x>"] });
    const report = await run({
      files: [...files(...nasty, "sample.lock"), { path: "skills/@everyone", previousPath: "CLAUDE<b>.md", modes: PLAIN }],
      guardrails: [g],
      config: { loadBearing: ["x/**"], immutable: [] },
    });
    const text = JSON.stringify(report);
    for (const bad of ["@", "<", "`", "\\n", "\\u202e", "ghp_0123"]) expect(text).not.toContain(bad);
    expect(report.entries.find((e) => e.id === "sample-check")?.subjects).toEqual(["%3Cimg%20src%3Dx%3E", "%40scope/pkg"]);
  });

  it("caps paths and subjects, and says how many it left out", async () => {
    const many = Array.from({ length: MAX_RESULT_PATHS + 7 }, (_, i) => `skills/${String(i).padStart(3, "0")}`);
    const g = check({}, { kind: "needsApproval", reason: "x", subjects: Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, "0")}`) });
    const report = await run({ files: [...files(...many), ...files("sample.lock")], guardrails: [g] });
    const e = report.entries.find((x) => x.id === "instruction-surface")!;
    expect(e.paths).toHaveLength(MAX_RESULT_PATHS);
    expect(e.pathsOmitted).toBe(7);
    const s = report.entries.find((x) => x.id === "sample-check")!;
    expect(s.subjects).toHaveLength(20);
    expect(s.subjectsOmitted).toBe(5);
  });
});

describe("determinism", () => {
  it("the same input in any order gives the same report", async () => {
    const paths = ["skills/b", "skills/a", "CLAUDE.md", ".github/x", "src/x.ts", "sample.lock"];
    const a = check({ id: "a-check", approvalLabel: "approved:a" });
    const z = check({ id: "z-check", approvalLabel: "approved:z" });
    const one = await run({ files: files(...paths), guardrails: [a, z] });
    const two = await run({ files: files(...[...paths].reverse()), guardrails: [z, a] });
    expect(two).toEqual(one);
    expect(one.entries.map((e) => e.id)).toEqual([
      "file-list",
      "malformed-path",
      "redirecting-file",
      "guardrail-config",
      "instruction-surface",
      "prod-credential",
      "release-set",
      "release-set-undeclared",
      "immutable",
      "load-bearing",
      "a-check",
      "z-check",
    ]);
  });
});

describe("CLAUDE.md #1", () => {
  it("the engine names no framework, manifest or lockfile format", () => {
    for (const file of ["guardrails.ts", "guardrail-approval.ts"]) {
      const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/package(-lock)?\.json|pnpm|\bbun\b|\bnpm\b|yarn|dockerfile|cloudbuild|next\.js|node_modules|pyproject|lockfile/i);
    }
  });
});
