import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CleanupError } from "@globalhost/dispatch";

const step = vi.hoisted(() => vi.fn());
vi.mock("@globalhost/dispatch", async (original) => ({ ...(await original<typeof import("@globalhost/dispatch")>()), cleanupStep: step }));

const { cleanupCommand } = await import("../src/cleanup-command.js");

async function run(argv = ["cleanup"], env: NodeJS.ProcessEnv = {}) {
  let err = "";
  let out = "";
  const code = await cleanupCommand(argv, env, (t) => (out += t), (t) => (err += t));
  return { code, err, out };
}
const result = (over: object = {}) => ({ report: { overCap: false, planned: 0, failures: [], ...over }, markdown: "## Cleanup\n" });

describe("globalhost cleanup", () => {
  it("exits 0 with nothing wrong, and prints the summary", async () => {
    step.mockResolvedValueOnce(result());
    expect(await run()).toEqual({ code: 0, err: "", out: "## Cleanup\n" });
  });

  it("appends the summary to the job's step summary", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "summary-")), "s.md");
    step.mockResolvedValueOnce(result());
    await run(["cleanup"], { GITHUB_STEP_SUMMARY: path });
    expect(readFileSync(path, "utf8")).toBe("## Cleanup\n");
  });

  it("exits 1 over the cap, so GitHub emails the owner", async () => {
    step.mockResolvedValueOnce(result({ overCap: true, planned: 21 }));
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toContain("over the cap: 21 changes planned; nothing was changed");
  });

  it("exits 1 on a failure, with its fixed text", async () => {
    step.mockResolvedValueOnce(result({ failures: ["removing preview tags failed (HTTP 403)"] }));
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toBe("cleanup: removing preview tags failed (HTTP 403)\n");
  });

  it("shows a CleanupError's text", async () => {
    step.mockRejectedValueOnce(new CleanupError("cleanup: GITHUB_TOKEN is not set"));
    expect(await run()).toMatchObject({ code: 1, err: "cleanup: GITHUB_TOKEN is not set\n" });
  });

  it("doesn't log an unexpected error's message, which could name a private repo", async () => {
    step.mockRejectedValueOnce(new Error("GCS read gs://globalhost-control/reviews/anlinguist/secret/pr-1.json: HTTP 500"));
    expect(await run()).toMatchObject({ code: 1, err: "cleanup: unexpected Error\n" });
  });

  it("takes no arguments", async () => {
    expect((await run(["cleanup", "--apply"])).code).toBe(2);
  });
});
