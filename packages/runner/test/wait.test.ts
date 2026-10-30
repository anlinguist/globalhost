import { describe, expect, it } from "vitest";
import { roleDefinition } from "@globalhost/roles";
import { ensureAgent, ensureEnvironment, reconcile, waitForTurn } from "../src/managed-agents.js";
import { FakeApi } from "./fake-api.js";

const instant = async () => undefined;

async function sessionWith(api: FakeApi): Promise<string> {
  return api.createSession({
    agent: { id: "agent_x", version: 1 },
    environmentId: "env_x",
    budgetCents: 100,
    title: "t",
    metadata: {},
    files: [],
  });
}

describe("waitForTurn", () => {
  it("returns the stop reason when the stream delivers the idle event", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "go");
    api.segments = [[{ type: "agent.tool_use", toolName: "bash" }, { type: "session.status_idle", stopReason: "end_turn" }]];
    // The idle event reaches the log when the stream delivers it.
    const seen: string[] = [];
    const result = await waitForTurn(api, id, {
      priorMessages: 0,
      deadline: Date.now() + 60_000,
      sleep: instant,
      onEvent: (e) => {
        seen.push(e.type);
        if (e.type === "session.status_idle") api.finishTurn(id, "end_turn");
      },
    });
    expect(result).toEqual({ stopReason: "end_turn", reconnects: 0 });
    expect(seen).toEqual(["agent.tool_use", "session.status_idle"]);
  });

  it("survives a dropped stream: reconnects and reconciles from the event log", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "go");
    // Segment 1 drops mid-run. While disconnected, the session hits its budget.
    api.segments = [[{ type: "agent.tool_use", toolName: "bash" }], []];
    let calls = 0;
    const origStream = api.streamEvents.bind(api);
    api.streamEvents = async () => {
      if (++calls === 2) api.finishTurn(id, "budget_reached", 100);
      return origStream();
    };
    const result = await waitForTurn(api, id, { priorMessages: 0, deadline: Date.now() + 60_000, sleep: instant });
    expect(result.stopReason).toBe("budget_reached");
    expect(result.reconnects).toBe(1);
  });

  it("reconciles when the stream goes quiet without ending", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "go");
    api.streamEvents = async () => {
      setTimeout(() => api.finishTurn(id, "end_turn"), 5);
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) };
    };
    const result = await waitForTurn(api, id, { priorMessages: 0, deadline: Date.now() + 60_000, quietMs: 20, sleep: instant });
    expect(result.stopReason).toBe("end_turn");
  });

  it("ignores idle events from earlier turns", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "turn 1");
    api.finishTurn(id, "end_turn");
    await api.sendMessage(id, "turn 2"); // running again; turn 1's idle is in the log
    expect(await reconcile(api, id, 1)).toBeUndefined();
    api.finishTurn(id, "budget_reached");
    expect(await reconcile(api, id, 1)).toBe("budget_reached");
  });

  it("treats a failing API as a drop and stops at the deadline", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "go");
    api.streamEvents = async () => {
      throw new Error("503");
    };
    let t = 0;
    const result = await waitForTurn(api, id, {
      priorMessages: 0,
      deadline: 10_000,
      now: () => (t += 1_000),
      sleep: instant,
    });
    expect(result.stopReason).toBe("timeout");
    expect(result.reconnects).toBeGreaterThan(0);
  });

  it("reports a terminated session", async () => {
    const api = new FakeApi();
    const id = await sessionWith(api);
    await api.sendMessage(id, "go");
    api.sessions.get(id)!.status = "terminated";
    const result = await waitForTurn(api, id, { priorMessages: 0, deadline: Date.now() + 1_000, sleep: instant });
    expect(result.stopReason).toBe("terminated");
  });
});

describe("ensureAgent / ensureEnvironment", () => {
  it("creates once, reuses on the same hash, and versions on a new hash", async () => {
    const api = new FakeApi();
    const def = roleDefinition("builder");
    const a = await ensureAgent(api, def, "h1");
    expect(await ensureAgent(api, def, "h1")).toEqual(a);
    const b = await ensureAgent(api, def, "h2");
    expect(b).toEqual({ id: a.id, version: a.version + 1 });
    expect(api.agents).toHaveLength(1);
  });

  it("reuses an environment by name", async () => {
    const api = new FakeApi();
    const spec = { name: "globalhost-web-app", allowedHosts: [] };
    expect(await ensureEnvironment(api, spec)).toBe(await ensureEnvironment(api, spec));
    expect(api.environments).toHaveLength(1);
  });
});
