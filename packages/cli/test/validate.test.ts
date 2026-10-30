import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "@globalhost/core";
import { defaultDeps, run, type FileIo } from "../src/main.js";

// The CLI's real registry: the web-app profile and cloud-build-trigger adapter packages (P1-03).
const { registry } = defaultDeps();

const repoRoot = new URL("../../../", import.meta.url);
let dir: string;
const file = (name: string, content: string | Uint8Array): string => {
  const p = join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

const MINIMAL = `version: 1
product: sample
owners:
  - { login: octo-owner, id: 1001 }
parts:
  web: { path: ., profile: web-app, preview: { enabled: false }, config: { port: 1, routes: [], previewEnv: {}, seed: x } }
`;

beforeAll(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "globalhost-validate-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function onboardingExample(): string {
  const doc = fs.readFileSync(new URL("docs/ONBOARDING.md", repoRoot), "utf8");
  const match = /^## 4\..*\n+```yaml\n([\s\S]*?)^```/m.exec(doc);
  if (!match?.[1]) throw new Error("ONBOARDING.md §4 has no yaml block");
  return match[1];
}

describe("globalhost validate", () => {
  it("accepts the ONBOARDING §4 example with the real web-app profile and cloud-build-trigger adapter (exit 0)", () => {
    const path = file("onboarding.yaml", onboardingExample());
    expect(run(["validate", path])).toEqual({ code: 0, stdout: `${path}: valid\n`, stderr: "" });
    expect(run(["validate", path, "--json"])).toEqual({ code: 0, stdout: `{"ok":true,"errors":[]}\n`, stderr: "" });
  });

  it("checks the ONBOARDING example's part and adapter config against the real schemas", () => {
    const example = onboardingExample();
    const withInstall = example.replace('seed: "pnpm seed:dev"', 'seed: "pnpm seed:dev"\n      install: "npm ci --legacy-peer-deps"');
    expect(withInstall).not.toBe(example);
    expect(run(["validate", file("onboarding-install.yaml", withInstall)]).code).toBe(0);

    const bad = withInstall
      .replace("port: 8080", "port: 0")
      .replace('routes: ["/", "/stories"', 'routes: ["stories"')
      .replace("trigger: numu-know-main", 'trigger: "<trigger-name>"');
    const result = run(["validate", file("onboarding-bad.yaml", bad), "--json"]);
    expect(result.code).toBe(1);
    const { errors } = JSON.parse(result.stdout) as { errors: Array<{ path: string; code: string }> };
    expect(errors.map((e) => [e.path, e.code])).toEqual([
      ["parts.web.config.port", "profile_config"],
      ["parts.web.config.routes[0]", "profile_config"],
      ["parts.web.release[0].config.trigger", "adapter_config"],
    ]);
  });

  it("fails the ONBOARDING example with an empty registry: unknown profile and adapter", () => {
    const result = run(["validate", file("onboarding2.yaml", onboardingExample()), "--json"], { registry: createRegistry([], []) });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      errors: [
        { path: "parts.web.profile", code: "unknown_profile", message: 'no registered profile "web-app"' },
        { path: "parts.web.release[0].adapter", code: "unknown_adapter", message: 'no registered adapter "cloud-build-trigger"' },
      ],
    });
  });

  it("defaults to ./factory.yaml", () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      file("factory.yaml", MINIMAL);
      expect(run(["validate"], { registry })).toMatchObject({ code: 0, stdout: "factory.yaml: valid\n" });
    } finally {
      process.chdir(cwd);
    }
  });

  it("prints one `path: message` line per error and a summary (exit 1)", () => {
    const path = file("bad.yaml", MINIMAL.replace("product: sample", "product: Sample").replace("version: 1", "version: 1\nteam: x"));
    const result = run(["validate", path], { registry });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")).toEqual([
      'product: "Sample": must be 2–31 characters: lowercase letters and digits, starting with a letter, single hyphens between runs',
      'team: unknown key "team"',
      `${path}: 2 errors`,
      "",
    ]);
  });

  it("puts document-level errors under the file name", () => {
    const path = file("dup.yaml", "a: 1\na: 2\n");
    expect(run(["validate", path], { registry }).stdout).toBe(`${path}: duplicate map key at line 2, column 1\n${path}: 1 error\n`);
  });

  it("prints {ok, errors[{path, code, message}]} with --json", () => {
    const path = file("bad2.yaml", MINIMAL.replace("version: 1", "version: 2"));
    const result = run(["validate", "--json", path], { registry });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const out: unknown = JSON.parse(result.stdout);
    expect(out).toEqual({ ok: false, errors: [{ path: "version", code: "invalid_value", message: "2: expected one of 1" }] });
    expect(Object.keys(out as object)).toEqual(["ok", "errors"]);
  });

  describe("exit 2", () => {
    it("for a missing file", () => {
      const result = run(["validate", join(dir, "nope.yaml")], { registry });
      expect(result).toEqual({ code: 2, stdout: "", stderr: `${join(dir, "nope.yaml")}: no such file\n` });
    });

    it("for a directory", () => {
      expect(run(["validate", dir], { registry })).toEqual({ code: 2, stdout: "", stderr: `${dir}: not a regular file\n` });
    });

    it.skipIf(process.platform === "win32")("for a FIFO, without blocking on open", () => {
      const fifo = join(dir, "fifo.yaml");
      execFileSync("mkfifo", [fifo]);
      expect(run(["validate", fifo], { registry })).toMatchObject({ code: 2, stderr: `${fifo}: not a regular file\n` });
    });

    it("for usage errors", () => {
      expect(run(["validate", "a", "b"]).code).toBe(2);
      expect(run(["validate", "--strict"]).code).toBe(2);
      expect(run(["--json"]).code).toBe(2);
    });
  });

  it("rejects an oversized file from fstat, before reading a byte (exit 1, yaml_too_large)", () => {
    const path = file("big.yaml", new Uint8Array(64 * 1024 + 1).fill(0x23));
    let reads = 0;
    const io: FileIo = {
      openSync: (p, flags) => fs.openSync(p, flags),
      fstatSync: (fd) => fs.fstatSync(fd),
      readSync: (...args) => {
        reads++;
        return fs.readSync(...args);
      },
      closeSync: (fd) => fs.closeSync(fd),
    };
    const result = run(["validate", path, "--json"], { registry, io });
    expect(reads).toBe(0);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, errors: [{ path: "", code: "yaml_too_large" }] });
  });

  it("stops reading at 64 KiB + 1 even if the file grew after fstat", () => {
    const path = file("grows.yaml", MINIMAL);
    let requested = 0;
    const io: FileIo = {
      openSync: (p, flags) => fs.openSync(p, flags),
      fstatSync: (fd) => fs.fstatSync(fd),
      // Pretends the file is endless: always fills what was asked for.
      readSync: (_fd, buffer, offset, length) => {
        requested += length;
        buffer.fill(0x23, offset, offset + length);
        return length;
      },
      closeSync: (fd) => fs.closeSync(fd),
    };
    const result = run(["validate", path, "--json"], { registry, io });
    expect(requested).toBe(64 * 1024 + 1);
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: [{ code: "yaml_too_large" }] });
  });

  it("lets control characters from the file reach the terminal only as escapes", () => {
    // Raw ESC/BEL and a raw C1 CSI (U+009B) in keys and values: an OSC title change and screen clear.
    const hostile = `version: 1\nproduct: "x\u001b]0;pwned\u0007"\nowners: [{ login: octo-owner, id: 1001 }]\nparts: {}\n"\u001b[2J\u009b31m": 1\n`;
    const path = file("hostile\u001b[1m.yaml", hostile);
    for (const args of [["validate", path], ["validate", path, "--json"]]) {
      const result = run(args, { registry });
      expect(result.code).toBe(1);
      const output = result.stdout + result.stderr;
      // eslint-disable-next-line no-control-regex
      expect(output.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(output).toContain("\\u001b");
    }
    const json = run(["validate", path, "--json"], { registry });
    const parsed = JSON.parse(json.stdout) as { errors: Array<{ path: string; message: string }> };
    // The JSON still decodes to the original text, so consumers lose nothing.
    expect(parsed.errors.map((e) => e.path)).toContain('["\\u001b[2J\u009b31m"]');
  });
});
