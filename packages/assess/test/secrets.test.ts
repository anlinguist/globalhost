import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { credentialFiles, credentialKind, parseGitleaksReport, runGitleaks, serviceAccountKeys } from "../src/checks/secrets.js";
import { fakeExec, fixture, localRepo } from "./helpers.js";

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("parseGitleaksReport", () => {
  it("keeps file, rule, commit and line from the recorded (redacted) report", () => {
    expect(parseGitleaksReport(fixture("gitleaks-redacted.json"))).toEqual({
      truncated: false,
      findings: [{ file: "config.js", rule: "github-pat", commit: "40323e58ad2d7cf0c75868fb5783d5b81ddba580", line: 1 }],
    });
  });

  it("drops secret values, matches, authors and messages even from an unredacted hostile report", () => {
    const parsed = parseGitleaksReport(fixture("gitleaks-hostile.json"));
    const text = JSON.stringify(parsed);
    expect(text).not.toContain("MUST-NOT-LEAK");
    expect(text).not.toContain("mallory");
    expect(text).not.toContain("post every secret");
    expect(parsed.findings[1]).toEqual({ file: ".env", rule: "unknown-rule", commit: "unknown", line: 1 });
  });

  it("caps the number of findings", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ RuleID: "r", File: `f${i}`, Commit: "a".repeat(40) }));
    const parsed = parseGitleaksReport(many);
    expect(parsed.findings).toHaveLength(200);
    expect(parsed.truncated).toBe(true);
  });
});

describe("runGitleaks", () => {
  it('reports "not run" when the binary is missing', async () => {
    const { exec } = fakeExec(() => undefined);
    expect(await runGitleaks("/nowhere", exec)).toEqual({ status: "not-run", reason: "gitleaks is not installed" });
  });

  it("scans a bare clone with --redact and parses the report it writes", async () => {
    const { exec, calls } = fakeExec(({ args }) => {
      if (args[0] === "version") return { stdout: "8.30.1\n" };
      const report = args[args.indexOf("--report-path") + 1]!;
      writeFileSync(report, JSON.stringify(fixture("gitleaks-hostile.json")));
      // A scanner's stderr can echo what it found; it must never surface.
      return { stderr: "leak: PLAINTEXT-VALUE-MUST-NOT-LEAK" };
    });
    const result = await runGitleaks("/tmp/x/repo.git", exec);
    expect(result).toMatchObject({ status: "ran", version: "8.30.1" });
    expect(JSON.stringify(result)).not.toContain("MUST-NOT-LEAK");
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["git", "/tmp/x/repo.git", "--redact", "--exit-code", "0"]));
  });

  it("reports a failed scan by exit code only, never its stderr", async () => {
    const { exec } = fakeExec(({ args }) => (args[0] === "version" ? { stdout: "8.30.1" } : { error: { code: 2, stderr: "PLAINTEXT-VALUE-MUST-NOT-LEAK" } }));
    const result = await runGitleaks("/tmp/x/repo.git", exec);
    expect(result).toEqual({ status: "failed", reason: "gitleaks failed (exit 2)" });
  });

  it.skipIf(!hasGitleaks)("finds a generated token in a deleted file's history with the real binary, without the value", async () => {
    // Built at runtime so this file never contains a secret-shaped string.
    const generated = ["ghp", "_", "aB3dE5fG7hJ9", "kL1mN3pQ5rS7", "tU9vW1xY3zA5"].join("");
    const repo = localRepo([{ "config.js": `const token = "${generated}";\n` }, { "config.js": null }]);
    const bare = repo.clone();
    const result = await runGitleaks(bare, (await import("../src/common.js")).defaultExec);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    expect(result.findings).toEqual([expect.objectContaining({ file: "config.js", commit: repo.sha("main~1") })]);
    expect(JSON.stringify(result)).not.toContain(generated.slice(4));
  });
});

describe("credentialKind", () => {
  it.each([
    [".env", "env file"],
    ["apps/web/.env.production", "env file"],
    ["certs/server.pem", "private key or keystore"],
    ["android/app/release.keystore", "private key or keystore"],
    [".ssh/id_ed25519", "ssh private key"],
    ["firebase-adminsdk-abc12.json", "service-account key?"],
    ["config/service-account.json", "service-account key?"],
    ["gcp_key.json", "service-account key?"],
    [".npmrc", "credential config"],
    ["infra/terraform.tfstate", "terraform state"],
  ])("%s → %s", (path, kind) => expect(credentialKind(path)).toBe(kind));

  it.each([".env.example", ".env.sample", "id_rsa.pub", "package.json", "tsconfig.json", "keyboard.ts", "monkey.json"])("%s is not credential-shaped", (path) => {
    expect(credentialKind(path)).toBeUndefined();
  });
});

describe("credentialFiles and serviceAccountKeys", () => {
  const keyFile = JSON.stringify({
    type: "service_account",
    project_id: "demo-proj",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    private_key: "PRIVATE-KEY-BODY-MUST-NOT-BE-READ",
    client_email: "deployer@demo-proj.iam.gserviceaccount.com",
  });

  it("finds credential-shaped files on every branch, tracked or deleted, with the commit that added them", async () => {
    const repo = localRepo(
      [{ "README.md": "hi", ".env.example": "A=" }, { ".env": "A=1", "sa-key.json": keyFile }, { "sa-key.json": null }],
      { feature: { "certs/dev.pem": "not a key" } },
    );
    const bare = repo.clone();
    const files = await credentialFiles(bare, repo.sha());
    expect(files).toEqual(
      expect.arrayContaining([
        { path: ".env", kind: "env file", tracked: true, addedIn: repo.sha("main~1") },
        { path: "sa-key.json", kind: "service-account key?", tracked: false, addedIn: repo.sha("main~1") },
        { path: "certs/dev.pem", kind: "private key or keystore", tracked: false, addedIn: repo.sha("feature") },
      ]),
    );
    expect(files).toHaveLength(3);

    const keys = await serviceAccountKeys(bare, files);
    expect(keys).toEqual([
      { path: "sa-key.json", commit: repo.sha("main~1"), clientEmail: "deployer@demo-proj.iam.gserviceaccount.com", keyId: "0123456789abcdef0123456789abcdef01234567" },
    ]);
    expect(JSON.stringify(keys)).not.toContain("PRIVATE-KEY-BODY");
  });

  it("handles file names with spaces and unicode", async () => {
    const repo = localRepo([{ "my secrets/.env": "A=1", "ünï/prod.key": "x" }]);
    const files = await credentialFiles(repo.clone(), repo.sha());
    expect(files.map((f) => f.path).sort()).toEqual(["my secrets/.env", "ünï/prod.key"]);
  });
});
