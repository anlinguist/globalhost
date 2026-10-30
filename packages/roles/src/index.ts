// Role definitions for Managed Agents (ADR-0011): one versioned agent per role, synced by name.
// Prompts live in ../prompts/*.md so they read as prose and diff cleanly.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type RoleId = "planner" | "builder";
export const ROLE_IDS: readonly RoleId[] = ["planner", "builder"];

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ToolConfig {
  name: string;
  enabled: boolean;
}

/** An uploaded custom skill, pinned to one version so a run's instructions are reproducible. */
export interface SkillPin {
  skillId: string;
  version: string;
}

export interface RoleDefinition {
  id: RoleId;
  /** Agent name in the Console workspace; also the sync key. */
  agentName: string;
  model: string;
  system: string;
  /** Overrides on top of the toolset default (all tools on, always_allow: the sandbox is the boundary). */
  toolConfigs: ToolConfig[];
  /** Files the role must leave in /mnt/session/outputs/. */
  requiredOutputs: string[];
  /** Profile skills (skills/<name>) the agent can load on demand. */
  skills: SkillPin[];
}

function prompt(name: string): string {
  // ../prompts resolves the same from src/ (tests) and dist/ (built package).
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim();
}

// No role gets web tools in Phase 1: egress is package registries only (ARCHITECTURE §4 rule 4).
const NO_WEB: ToolConfig[] = [
  { name: "web_fetch", enabled: false },
  { name: "web_search", enabled: false },
];

export function roleDefinition(id: RoleId, model: string = DEFAULT_MODEL, skills: readonly SkillPin[] = []): RoleDefinition {
  const system = `${prompt("common")}\n\n${prompt(id)}`;
  switch (id) {
    case "planner":
      return {
        id,
        agentName: "globalhost-planner",
        model,
        system,
        // The planner writes only its outputs; it has no reason to edit files in place.
        toolConfigs: [...NO_WEB, { name: "edit", enabled: false }],
        requiredOutputs: ["plan.md", "report.json"],
        skills: [...skills],
      };
    case "builder":
      return {
        id,
        agentName: "globalhost-builder",
        model,
        system,
        toolConfigs: NO_WEB,
        requiredOutputs: ["result.bundle", "report.json"],
        skills: [...skills],
      };
  }
}

/** Stable hash of everything that defines the agent; a change means a new agent version. */
export function definitionHash(def: RoleDefinition): string {
  const material = JSON.stringify({ model: def.model, system: def.system, tools: def.toolConfigs, skills: def.skills });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
