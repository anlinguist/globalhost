import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentReportSchema } from "../src/records.js";

describe("AgentReportSchema", () => {
  it("accepts a real builder report whose check name ran past the limit, clipping it", () => {
    // From the first numu-know builder run (#13): one check name of 100+ characters failed the whole run.
    const raw = JSON.parse(readFileSync(new URL("./fixtures/report-long-check-name.json", import.meta.url), "utf8"));
    const parsed = AgentReportSchema.parse(raw);
    expect(parsed.outcome).toBe("done");
    for (const c of parsed.checks) expect(c.name.length).toBeLessThanOrEqual(100);
    expect(parsed.checks.some((c) => c.name.endsWith("…"))).toBe(true);
  });

  it("still rejects the wrong shape", () => {
    expect(AgentReportSchema.safeParse({ outcome: "shipped", summary: "x" }).success).toBe(false);
    expect(AgentReportSchema.safeParse({ outcome: "done", summary: 42 }).success).toBe(false);
  });
});
