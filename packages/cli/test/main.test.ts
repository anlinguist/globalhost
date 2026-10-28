import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

describe("globalhost CLI", () => {
  it("prints the package version", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("prints usage with no arguments", () => {
    expect(run([]).stdout).toContain("Usage: globalhost");
  });

  it("rejects unknown commands and options with exit code 2", () => {
    expect(run(["deploy-prod"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Unknown command: deploy-prod") });
    expect(run(["--force"]).code).toBe(2);
  });

  it("escapes control characters before echoing input", () => {
    const { stderr } = run(["\u001b]0;pwned\u0007x"]);
    expect(stderr).toContain("Unknown command: \\u001b]0;pwned\\u0007x");
    expect(stderr.includes("\u001b") || stderr.includes("\u0007")).toBe(false);
  });
});
