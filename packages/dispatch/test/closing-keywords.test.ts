import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, UnsafeCommitError, hasClosingKeyword, neutralizeClosingKeywords, rewriteClosingKeywords } from "../src/closing-keywords.js";
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

describe("closing keyword regex", () => {
  it("is linear on long whitespace runs", () => {
    const text = `fix${" ".repeat(1_000_000)}x`;
    const start = performance.now();
    expect(neutralizeClosingKeywords(text)).toBe(text);
    expect(neutralizeClosingKeywords(`fix${" \t".repeat(500_000)}: ${" ".repeat(10)}#1`)).toMatch(/^refs/);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

const RESULT = "refs/globalhost/result";

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
    git(work, "update-ref", RESULT, "HEAD");
    return { dir, work, base, head: () => git(work, "rev-parse", RESULT) };
  }
  type Repo = ReturnType<typeof repo>;

  /** Writes a raw commit object as-is (git hash-object --literally) and points the result ref at it. */
  function literal(r: Repo, raw: Buffer | string): string {
    const file = join(r.dir, "raw");
    writeFileSync(file, raw);
    const sha = git(r.work, "hash-object", "-t", "commit", "-w", "--literally", file);
    git(r.work, "update-ref", RESULT, sha);
    return sha;
  }

  const ident = "a <a@b> 1700000000 +0000";
  const commitHeader = (r: Repo, extra = "") =>
    `tree ${git(r.work, "rev-parse", "HEAD^{tree}")}\nparent ${r.base}\nauthor ${ident}\ncommitter ${ident}\n${extra}`;

  it("rewrites only what it must and keeps history otherwise", async () => {
    const r = repo(["Add tests", "Fix #3 properly", "Tidy"]);
    const before = git(r.work, "rev-list", "--reverse", `${r.base}..${RESULT}`).split("\n");
    expect(await rewriteClosingKeywords(r.work, r.base, RESULT, before[2]!)).toBe(1);
    const after = git(r.work, "rev-list", "--reverse", `${r.base}..${RESULT}`).split("\n");
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(git(r.work, "log", "-1", "--format=%B", after[1]!)).toBe("refs #3 properly");
    expect(git(r.work, "log", "-1", "--format=%B", after[2]!)).toBe("Tidy");
    for (let i = 0; i < 3; i++) expect(git(r.work, "rev-parse", `${after[i]}^{tree}`)).toBe(git(r.work, "rev-parse", `${before[i]}^{tree}`));
  });

  it("is deterministic, so a resumed builder's branch fast-forwards", async () => {
    const r = repo(["Closes #1"]);
    const original = r.head();
    await rewriteClosingKeywords(r.work, r.base, RESULT, original);
    const first = r.head();
    git(r.work, "update-ref", RESULT, original);
    await rewriteClosingKeywords(r.work, r.base, RESULT, original);
    expect(r.head()).toBe(first);
  });

  it("does nothing when no message needs it", async () => {
    const r = repo(["Refs #1"]);
    const head = r.head();
    expect(await rewriteClosingKeywords(r.work, r.base, RESULT, head)).toBe(0);
    expect(r.head()).toBe(head);
  });

  it("keeps dates byte-exact, even tiny timestamps", async () => {
    const r = repo([]);
    const tree = git(r.work, "rev-parse", "HEAD^{tree}");
    const sha = literal(r, `tree ${tree}\nparent ${r.base}\nauthor a <a@b> 5 -0130\ncommitter c <c@d> 1234 +0545\n\nFixes #1\n`);
    await rewriteClosingKeywords(r.work, r.base, RESULT, sha);
    const raw = git(r.work, "cat-file", "commit", r.head());
    expect(raw).toContain("author a <a@b> 5 -0130\ncommitter c <c@d> 1234 +0545\n\nrefs #1");
  });

  it("rewrites a merge commit, mapping its parents", async () => {
    const r = repo(["one"]);
    const one = r.head();
    git(r.work, "checkout", "-q", "-b", "side", r.base);
    writeFileSync(join(r.work, "b"), "b\n");
    git(r.work, "add", ".");
    git(r.work, "commit", "-q", "-m", "Fixes #2 on the side");
    git(r.work, "checkout", "-q", "main");
    git(r.work, "merge", "-q", "--no-ff", "-m", "Merge, resolves #3", "side");
    git(r.work, "update-ref", RESULT, "HEAD");
    const head = r.head();
    expect(await rewriteClosingKeywords(r.work, r.base, RESULT, head)).toBe(2);
    const newHead = r.head();
    expect(git(r.work, "log", "-1", "--format=%B", newHead)).toBe("Merge, refs #3");
    expect(git(r.work, "rev-parse", `${newHead}^1`)).toBe(one);
    expect(git(r.work, "log", "-1", "--format=%B", `${newHead}^2`)).toBe("refs #2 on the side");
    expect(git(r.work, "rev-parse", `${newHead}^{tree}`)).toBe(git(r.work, "rev-parse", `${head}^{tree}`));
  });

  it("refuses when the ref isn't the verified head", async () => {
    const r = repo(["Fixes #1", "two"]);
    const verified = git(r.work, "rev-parse", `${RESULT}~1`);
    await expect(rewriteClosingKeywords(r.work, r.base, RESULT, verified)).rejects.toThrow(UnsafeCommitError);
  });

  describe("fails closed on crafted commits, leaving the ref alone", () => {
    const cases: Array<[string, (r: Repo) => Buffer | string]> = [
      [
        "a second tree header (git reads the first, a naive parser the last)",
        (r) => {
          writeFileSync(join(r.work, "evil"), "x\n");
          git(r.work, "add", ".");
          const evil = git(r.work, "write-tree");
          git(r.work, "rm", "-q", "--cached", "evil");
          return `${commitHeader(r)}tree ${evil}\n\nFixes #1\n`;
        },
      ],
      ["a second author header", (r) => `${commitHeader(r, `author ${ident}\n`)}\nFixes #1\n`],
      ["a second committer header", (r) => `${commitHeader(r, `committer ${ident}\n`)}\nFixes #1\n`],
      ["an encoding header", (r) => Buffer.concat([Buffer.from(`${commitHeader(r, "encoding UTF-16LE\n")}\n`), Buffer.from("Fixes #1\n", "utf16le")])],
      ["a NUL in the message", (r) => `${commitHeader(r)}\nFixes #1\0hidden\n`],
      ["a non-UTF-8 message", (r) => Buffer.concat([Buffer.from(`${commitHeader(r)}\nFixes #1 `), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from("\n")])],
      ["an oversize message", (r) => `${commitHeader(r)}\nFixes #1\n${"x".repeat(MAX_MESSAGE_BYTES)}\n`],
      ["a malformed author", (r) => `tree ${git(r.work, "rev-parse", "HEAD^{tree}")}\nparent ${r.base}\nauthor nobody\ncommitter ${ident}\n\nFixes #1\n`],
    ];
    it.each(cases)("%s", async (_name, make) => {
      const r = repo([]);
      const sha = literal(r, make(r));
      await expect(rewriteClosingKeywords(r.work, r.base, RESULT, sha)).rejects.toThrow(UnsafeCommitError);
      expect(r.head()).toBe(sha);
    });

    it("even when the message needs no rewrite", async () => {
      const r = repo([]);
      const sha = literal(r, `${commitHeader(r, `author ${ident}\n`)}\nplain\n`);
      await expect(rewriteClosingKeywords(r.work, r.base, RESULT, sha)).rejects.toThrow(/2 author headers/);
    });
  });
});
