// An in-memory ManagedAgentsApi. Each stream() call plays the next scripted segment; a segment that
// ends without an idle event models the dropped SSE stream seen in the P1-00 spike.
import type { RoleDefinition } from "@globalhost/roles";
import type {
  AgentInfo,
  EnvironmentInfo,
  EnvironmentSpec,
  ManagedAgentsApi,
  OutputFile,
  SessionEvent,
  SessionInfo,
  SessionSpec,
  SkillInfo,
} from "../src/managed-agents.js";

export class FakeApi implements ManagedAgentsApi {
  agents: AgentInfo[] = [];
  environments: EnvironmentInfo[] = [];
  sessions = new Map<string, SessionInfo & { budgetCents: number; spec?: SessionSpec }>();
  log: SessionEvent[] = [];
  sent: string[] = [];
  /** Scripted stream segments; each entry is played by one streamEvents() call, then the stream ends. */
  segments: SessionEvent[][] = [];
  /** Called after each sendMessage, to script what the session does. */
  onSend: (text: string) => void = () => undefined;
  outputs: (OutputFile & { data: Buffer })[] = [];
  streamCalls = 0;
  interrupted = 0;
  private nextId = 1;

  skills: (SkillInfo & { displayName: string; files: string[] })[] = [];

  async findSkill(displayName: string) {
    return this.skills.find((s) => s.displayName === displayName);
  }
  async createSkill(displayName: string, files: readonly { path: string; data: Buffer }[]) {
    const s = { id: `skill_${this.nextId++}`, latestVersion: `skillver_${this.nextId++}`, displayName, files: files.map((f) => f.path) };
    this.skills.push(s);
    return s;
  }
  async findAgent(name: string) {
    return this.agents.find((a) => a.name === name);
  }
  agentSkills = new Map<string, RoleDefinition["skills"]>();
  async createAgent(def: RoleDefinition, metadata: Record<string, string>) {
    const a = { id: `agent_${this.nextId++}`, version: 1, name: def.agentName, metadata };
    this.agentSkills.set(a.id, def.skills);
    this.agents.push(a);
    return a;
  }
  async updateAgent(id: string, def: RoleDefinition, metadata: Record<string, string>) {
    const a = this.agents.find((x) => x.id === id)!;
    this.agentSkills.set(id, def.skills);
    a.version++;
    a.metadata = metadata;
    return { ...a };
  }
  async findEnvironment(name: string) {
    return this.environments.find((e) => e.name === name);
  }
  async createEnvironment(spec: EnvironmentSpec) {
    const e = { id: `env_${this.nextId++}`, name: spec.name };
    this.environments.push(e);
    return e;
  }
  async uploadFile() {
    return `file_${this.nextId++}`;
  }
  async createSession(spec: SessionSpec) {
    const id = `sesn_${this.nextId++}`;
    this.sessions.set(id, {
      id,
      status: "idle",
      costCents: 0,
      activeSeconds: 0,
      agent: spec.agent,
      environmentId: spec.environmentId,
      metadata: spec.metadata,
      budgetCents: spec.budgetCents,
      spec,
    });
    return id;
  }
  async retrieveSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return { ...s };
  }
  async setBudget(id: string, cents: number) {
    this.sessions.get(id)!.budgetCents = cents;
  }
  async streamEvents(): Promise<AsyncIterable<SessionEvent>> {
    const segment = this.segments[this.streamCalls++] ?? [];
    return (async function* () {
      for (const e of segment) yield e;
    })();
  }
  async *listEvents() {
    for (const e of this.log) yield e;
  }
  async sendMessage(id: string, text: string) {
    this.sent.push(text);
    this.log.push({ type: "user.message" });
    this.sessions.get(id)!.status = "running";
    this.onSend(text);
  }
  async interrupt() {
    this.interrupted++;
  }
  async listOutputFiles() {
    return this.outputs.map((f) => ({ id: f.id, filename: f.filename, sizeBytes: f.sizeBytes, createdAt: f.createdAt }));
  }
  async downloadFile(id: string) {
    return this.outputs.find((f) => f.id === id)!.data;
  }

  /** Ends the current turn: logs an idle event and marks the session idle. */
  finishTurn(id: string, stopReason: string, costCents = 50) {
    this.log.push({ type: "session.status_idle", stopReason });
    const s = this.sessions.get(id)!;
    s.status = "idle";
    s.costCents = costCents;
  }
}
