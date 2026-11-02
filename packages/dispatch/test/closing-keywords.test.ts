import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasClosingKeyword, neutralizeClosingKeywords, rewriteClosingKeywords } from "../src/closing-keywords.js";
import { git } from "./fakes.js";

describe("neutralizeClosingKeywords", () => {
  it.each([
    ["Closes #12", "refs #12"],
    ["closes #12", "refs #12"],
    ["CLOSED #12", "refs #12"],
    ["close #1", "refs #1"],
    ["Fix #1", "refs #1"],
    ["fixes #1", "refs #1"],
    ["FiXeD #1", "refs #1"],
    ["resolve #1", "refs #1"],
    ["Resolves #1", "refs #1"],
    ["resolved #1", "refs #1"],
    ["Fixes: #1", "refs: #1"],
    ["fixes:#1", "refs:#1"],
    ["fixes#1", "refs#1"],
    ["fixes\t\n #1", "refs\t\n #1"],
    ["Closes anlinguist/demo#7", "refs anlinguist/demo#7"],
    ["Closes other-org/other.repo#7", "refs other-org/other.repo#7"],
    ["Fixes https://github.com/anlinguist/demo/issues/7", "refs https://github.com/anlinguist/demo/issues/7"],
    ["fixes http://www.github.com/a/b/issues/7", "refs http://www.github.com/a/b/issues/7"],
    ["fixes GH-7", "refs GH-7"],
    ["(fixes #1)", "(refs #1)"],
    ["_fixes #1_", "_refs #1_"],
    ["**Closes** #1", "**Closes** #1"],
    ["Fixes #1 and closes #2", "refs #1 and refs #2"],
    ["line one\nResolves #9\n", "line one\nrefs #9\n"],
  ])("%j → %j", (input, out) => {
    expect(neutralizeClosingKeywords(input)).toBe(out);
  });

  it.each(["Refs #12", "prefixes #1", "fixture #1", "Fixes the bug", "Closes issue 12", "closes #", "fixes https://evil.example/issues/1"])(
    "leaves %j alone",
    (text) => {
      expect(neutralizeClosingKeywords(text)).toBe(text);
      expect(hasClosingKeyword(text)).toBe(false);
    },
  );
});

describe("rewriteClosingKeywords", () => {
  function repo(messages: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    writeFileSync(join(work, "a"), "0\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    messages.forEach((m, i) => {
      writeFileSync(join(work, "a"), `${i + 1}\n`);
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", m);
    });
    git(work, "update-ref", "refs/globalhost/result", "HEAD");
    return { work, base };
  }

  it("rewrites only what it must and keeps history otherwise", async () => {
    const { work, base } = repo(["Add tests", "Fix #3 properly", "Tidy"]);
    const before = git(work, "rev-list", "--reverse", `${base}..refs/globalhost/result`).split("\n");
    expect(await rewriteClosingKeywords(work, base, "refs/globalhost/result")).toBe(1);
    const after = git(work, "rev-list", "--reverse", `${base}..refs/globalhost/result`).split("\n");
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(git(work, "log", "-1", "--format=%B", after[1]!)).toBe("refs #3 properly");
    expect(git(work, "log", "-1", "--format=%B", after[2]!)).toBe("Tidy");
    expect(git(work, "rev-parse", `${after[2]}^{tree}`)).toBe(git(work, "rev-parse", `${before[2]}^{tree}`));
  });

  it("is deterministic, so a resumed builder's branch fast-forwards", async () => {
    const a = repo(["Closes #1"]);
    await rewriteClosingKeywords(a.work, a.base, "refs/globalhost/result");
    const first = git(a.work, "rev-parse", "refs/globalhost/result");
    const original = git(a.work, "rev-parse", "HEAD");
    git(a.work, "update-ref", "refs/globalhost/result", original);
    await rewriteClosingKeywords(a.work, a.base, "refs/globalhost/result");
    expect(git(a.work, "rev-parse", "refs/globalhost/result")).toBe(first);
  });

  it("does nothing when no message needs it", async () => {
    const { work, base } = repo(["Refs #1"]);
    const head = git(work, "rev-parse", "refs/globalhost/result");
    expect(await rewriteClosingKeywords(work, base, "refs/globalhost/result")).toBe(0);
    expect(git(work, "rev-parse", "refs/globalhost/result")).toBe(head);
  });
});
