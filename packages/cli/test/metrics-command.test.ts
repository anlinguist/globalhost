import { describe, expect, it, vi } from "vitest";
import { MetricsError } from "@globalhost/dispatch";

const step = vi.hoisted(() => vi.fn());
vi.mock("@globalhost/dispatch", async (original) => ({ ...(await original<typeof import("@globalhost/dispatch")>()), metricsStep: step }));

const { metricsCommand } = await import("../src/metrics-command.js");

async function run(argv = ["metrics"]) {
  let err = "";
  const code = await metricsCommand(argv, {}, () => undefined, (t) => (err += t));
  return { code, err };
}

describe("globalhost metrics", () => {
  it("exits 0 when the watcher is clear", async () => {
    step.mockResolvedValueOnce({ report: { findings: [] }, markdown: "" });
    expect(await run()).toEqual({ code: 0, err: "" });
  });

  it("exits 1 and lists the reasons when it has findings, so GitHub emails the owner", async () => {
    step.mockResolvedValueOnce({ report: { findings: [{ code: "cycle-spend", message: "Cycle spend $120.00." }] }, markdown: "" });
    expect(await run()).toEqual({ code: 1, err: "watcher: cycle-spend: Cycle spend $120.00.\n" });
  });

  it("exits 1 on a failure, with its fixed text", async () => {
    step.mockRejectedValueOnce(new MetricsError("metrics: reading the runs bucket failed (HTTP 403)"));
    expect(await run()).toEqual({ code: 1, err: "metrics: reading the runs bucket failed (HTTP 403)\n" });
  });

  it("doesn't log an unexpected error's message, which could name a private repo", async () => {
    step.mockRejectedValueOnce(new Error("GCS read gs://globalhost-runs/anlinguist/secret-product/x: HTTP 500"));
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toBe("metrics: unexpected Error\n");
  });

  it("takes no arguments", async () => {
    expect((await run(["metrics", "--force"])).code).toBe(2);
  });
});
