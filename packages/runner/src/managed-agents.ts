// Managed Agents host (ADR-0011). The SDK sits behind ManagedAgentsApi so the session logic,
// especially waiting through dropped event streams, is testable against a fake.
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { RoleDefinition } from "@globalhost/roles";
import { MANAGED_AGENTS_BETA } from "./auth.js";

export interface AgentRef {
  id: string;
  version: number;
}
export interface AgentInfo extends AgentRef {
  name: string;
  metadata: Record<string, string>;
}
export interface EnvironmentInfo {
  id: string;
  name: string;
}
export interface SessionInfo {
  id: string;
  status: "rescheduling" | "running" | "idle" | "terminated";
  costCents: number;
  activeSeconds: number | null;
  agent: AgentRef;
  environmentId: string;
  metadata: Record<string, string>;
}
export interface SessionEvent {
  type: string;
  /** Present on session.status_idle. */
  stopReason?: string;
  /** Present on agent.tool_use. */
  toolName?: string;
  /** Present on agent.message. */
  text?: string;
}
export interface OutputFile {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
}
export interface EnvironmentSpec {
  name: string;
  /** Hosts reachable besides package registries. Phase 1 profiles use none. */
  allowedHosts: string[];
}
export interface SessionSpec {
  agent: AgentRef;
  environmentId: string;
  budgetCents: number;
  title: string;
  metadata: Record<string, string>;
  files: { fileId: string; mountPath: string }[];
}

export interface ManagedAgentsApi {
  findAgent(name: string): Promise<AgentInfo | undefined>;
  createAgent(def: RoleDefinition, metadata: Record<string, string>): Promise<AgentInfo>;
  updateAgent(id: string, def: RoleDefinition, metadata: Record<string, string>): Promise<AgentInfo>;
  findEnvironment(name: string): Promise<EnvironmentInfo | undefined>;
  createEnvironment(spec: EnvironmentSpec): Promise<EnvironmentInfo>;
  uploadFile(path: string): Promise<string>;
  createSession(spec: SessionSpec): Promise<string>;
  retrieveSession(id: string): Promise<SessionInfo>;
  setBudget(id: string, cents: number): Promise<void>;
  /** Live events from now on. The stream may end or fail at any time without the session stopping. */
  streamEvents(id: string): Promise<AsyncIterable<SessionEvent>>;
  /** The session's full event history, oldest first. */
  listEvents(id: string): AsyncIterable<SessionEvent>;
  sendMessage(id: string, text: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  listOutputFiles(sessionId: string): Promise<OutputFile[]>;
  downloadFile(id: string): Promise<Buffer>;
}

const usd = (cents: number) => ({ amount: String(Math.max(1, Math.round(cents))), currency: "USD" as const });

function toolset(def: RoleDefinition) {
  return [
    {
      type: "agent_toolset_20260401" as const,
      // The sandbox is the boundary (ADR-0011), so tools run without confirmation prompts.
      default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
      configs: def.toolConfigs.map((c) => ({ name: c.name as "bash", enabled: c.enabled })),
    },
  ];
}

function toEvent(raw: { type: string } & Record<string, unknown>): SessionEvent {
  const event: SessionEvent = { type: raw.type };
  if (raw.type === "session.status_idle") {
    const reason = raw.stop_reason as { type?: string } | undefined;
    event.stopReason = reason?.type ?? "unknown";
  } else if (raw.type === "agent.tool_use" || raw.type === "agent.mcp_tool_use") {
    event.toolName = String(raw.name ?? "");
  } else if (raw.type === "agent.message" && Array.isArray(raw.content)) {
    event.text = (raw.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return event;
}

/** The real API, over the official SDK. */
export function sdkApi(client: Anthropic): ManagedAgentsApi {
  const beta = client.beta;
  const agentInfo = (a: { id: string; version: number; name: string; metadata: Record<string, string> }): AgentInfo => ({
    id: a.id,
    version: a.version,
    name: a.name,
    metadata: a.metadata,
  });
  return {
    async findAgent(name) {
      for await (const a of beta.agents.list()) if (a.name === name) return agentInfo(a);
      return undefined;
    },
    async createAgent(def, metadata) {
      return agentInfo(
        await beta.agents.create({ name: def.agentName, model: def.model, system: def.system, tools: toolset(def), metadata }),
      );
    },
    async updateAgent(id, def, metadata) {
      return agentInfo(await beta.agents.update(id, { model: def.model, system: def.system, tools: toolset(def), metadata }));
    },
    async findEnvironment(name) {
      for await (const e of beta.environments.list()) if (e.name === name) return { id: e.id, name: e.name };
      return undefined;
    },
    async createEnvironment(spec) {
      const e = await beta.environments.create({
        name: spec.name,
        config: {
          type: "cloud",
          // Always explicit: omitting networking means unrestricted egress (ADR-0011).
          networking: { type: "limited", allow_package_managers: true, allowed_hosts: spec.allowedHosts },
        },
      });
      return { id: e.id, name: e.name };
    },
    async uploadFile(path) {
      const file = await beta.files.upload({ file: createReadStream(path) });
      return file.id;
    },
    async createSession(spec) {
      const session = await beta.sessions.create({
        agent: { type: "agent", id: spec.agent.id, version: spec.agent.version },
        environment_id: spec.environmentId,
        title: spec.title,
        metadata: spec.metadata,
        budget: { type: "limit", max_list_cost: usd(spec.budgetCents) },
        resources: spec.files.map((f) => ({ type: "file" as const, file_id: f.fileId, mount_path: f.mountPath })),
      });
      return session.id;
    },
    async retrieveSession(id) {
      const s = await beta.sessions.retrieve(id);
      return {
        id: s.id,
        status: s.status,
        costCents: Number(s.usage.list_cost?.amount ?? 0),
        activeSeconds: s.usage.active_seconds ?? null,
        agent: { id: s.agent.id, version: s.agent.version },
        environmentId: s.environment_id,
        metadata: s.metadata,
      };
    },
    async setBudget(id, cents) {
      await beta.sessions.update(id, { budget: { type: "limit", max_list_cost: usd(cents) } });
    },
    async streamEvents(id) {
      const stream = await beta.sessions.events.stream(id);
      return (async function* () {
        for await (const e of stream) yield toEvent(e as unknown as { type: string } & Record<string, unknown>);
      })();
    },
    async *listEvents(id) {
      for await (const e of beta.sessions.events.list(id, { order: "asc" })) {
        yield toEvent(e as unknown as { type: string } & Record<string, unknown>);
      }
    },
    async sendMessage(id, text) {
      await beta.sessions.events.send(id, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    },
    async interrupt(id) {
      await beta.sessions.events.send(id, { events: [{ type: "user.interrupt" }] });
    },
    async listOutputFiles(sessionId) {
      const files: OutputFile[] = [];
      for await (const f of beta.files.list({ scope_id: sessionId, betas: [MANAGED_AGENTS_BETA] })) {
        files.push({ id: f.id, filename: basename(f.filename), sizeBytes: f.size_bytes, createdAt: f.created_at });
      }
      return files;
    },
    async downloadFile(id) {
      const resp = await beta.files.download(id);
      return Buffer.from(await resp.arrayBuffer());
    },
  };
}

const HASH_KEY = "globalhost_definition";

/** Creates the role's agent, or a new version of it when the definition changed. Returns the version to pin. */
export async function ensureAgent(api: ManagedAgentsApi, def: RoleDefinition, hash: string): Promise<AgentRef> {
  const metadata = { globalhost_role: def.id, [HASH_KEY]: hash };
  const existing = await api.findAgent(def.agentName);
  const agent =
    !existing ? await api.createAgent(def, metadata)
    : existing.metadata[HASH_KEY] === hash ? existing
    : await api.updateAgent(existing.id, def, metadata);
  return { id: agent.id, version: agent.version };
}

export async function ensureEnvironment(api: ManagedAgentsApi, spec: EnvironmentSpec): Promise<string> {
  const existing = await api.findEnvironment(spec.name);
  return (existing ?? (await api.createEnvironment(spec))).id;
}

export interface WaitOptions {
  /** user.message events in the session before ours; ours is the next one. */
  priorMessages: number;
  deadline: number;
  onEvent?: (e: SessionEvent) => void;
  /** How long a silent stream is trusted before the harness reconciles against the event log. */
  quietMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitResult {
  /** The idle stop reason (end_turn, budget_reached, …), "terminated", or "timeout". */
  stopReason: string;
  reconnects: number;
}

/**
 * Decides from the event log (not the stream) whether the turn started by our message is over: the
 * session is idle and a non-requires_action idle event follows our message. Returns the stop reason.
 */
export async function reconcile(api: ManagedAgentsApi, sessionId: string, priorMessages: number): Promise<string | undefined> {
  const session = await api.retrieveSession(sessionId);
  if (session.status === "terminated") return "terminated";
  if (session.status !== "idle") return undefined;
  let messages = 0;
  let stop: string | undefined;
  for await (const e of api.listEvents(sessionId)) {
    if (e.type === "user.message") messages++;
    else if (e.type === "session.status_idle" && messages > priorMessages) stop = e.stopReason;
  }
  // requires_action can't be answered: every tool is always_allow, so treat it as a final stop.
  return stop;
}

export async function countMessages(api: ManagedAgentsApi, sessionId: string): Promise<number> {
  let n = 0;
  for await (const e of api.listEvents(sessionId)) if (e.type === "user.message") n++;
  return n;
}

/**
 * Waits for the turn to end. The SSE stream can drop or go quiet while the session keeps running
 * (ADR-0011 spike finding), so the stream is only a wake-up signal: every stop decision comes
 * from reconcile(), which runs on idle events, stream ends, quiet periods and reconnects.
 */
export async function waitForTurn(api: ManagedAgentsApi, sessionId: string, opts: WaitOptions): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const quietMs = opts.quietMs ?? 60_000;
  let reconnects = 0;
  let backoff = 1_000;

  for (;;) {
    if (now() > opts.deadline) return { stopReason: "timeout", reconnects };
    let iterator: AsyncIterator<SessionEvent> | undefined;
    try {
      // Open first, then reconcile: whatever happened before the stream opened is in the log.
      iterator = (await api.streamEvents(sessionId))[Symbol.asyncIterator]();
      const done = await reconcile(api, sessionId, opts.priorMessages);
      if (done) return { stopReason: done, reconnects };
      backoff = 1_000;

      let pending = iterator.next();
      for (;;) {
        if (now() > opts.deadline) return { stopReason: "timeout", reconnects };
        let timer: NodeJS.Timeout | undefined;
        const quiet = new Promise<"quiet">((r) => (timer = setTimeout(() => r("quiet"), quietMs)));
        const next = await Promise.race([pending, quiet]).finally(() => clearTimeout(timer));
        if (next === "quiet") {
          const stop = await reconcile(api, sessionId, opts.priorMessages);
          if (stop) return { stopReason: stop, reconnects };
          continue; // keep waiting on the same pending read
        }
        if (next.done) break; // stream ended: reconnect
        pending = iterator.next();
        opts.onEvent?.(next.value);
        if (next.value.type === "session.status_idle" || next.value.type === "session.status_terminated") {
          const stop = await reconcile(api, sessionId, opts.priorMessages);
          if (stop) return { stopReason: stop, reconnects };
        }
      }
    } catch {
      // A failed stream or API call is treated like a drop: back off, reconnect, reconcile.
    } finally {
      void iterator?.return?.().catch(() => undefined);
    }
    reconnects++;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
