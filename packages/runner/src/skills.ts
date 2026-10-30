// Profile skills (skills/<name>/SKILL.md + files) uploaded as Managed Agents custom skills. A skill is named
// by its content hash, so unchanged text reuses the upload and any edit becomes a new, separately pinned skill.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { SkillPin } from "@globalhost/roles";
import type { ManagedAgentsApi } from "./managed-agents.js";

export interface SkillFile {
  /** "<skill dir name>/<path inside it>", POSIX separators: the API wants one top-level directory. */
  path: string;
  data: Buffer;
}

const MAX_SKILL_BYTES = 1024 * 1024;

/** Every regular file under `dir`, sorted, refusing symlinks and anything past the size cap. */
export function readSkillDir(dir: string): SkillFile[] {
  const name = basename(dir);
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        total += statSync(full).size;
        if (total > MAX_SKILL_BYTES) throw new Error(`skill ${name} is larger than ${MAX_SKILL_BYTES} bytes`);
        files.push({ path: `${name}/${relative(dir, full).split(sep).join("/")}`, data: readFileSync(full) });
      } else throw new Error(`skill ${name}: ${relative(dir, full)} is not a regular file`);
    }
  };
  walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((f) => f.path === `${name}/SKILL.md`)) throw new Error(`skill ${name} has no SKILL.md`);
  return files;
}

export function skillDisplayName(files: readonly SkillFile[]): string {
  const hash = createHash("sha256");
  for (const f of files) hash.update(f.path).update("\0").update(f.data).update("\0");
  return `globalhost-${files[0]!.path.split("/")[0]} ${hash.digest("hex").slice(0, 12)}`;
}

/** Uploads the skill unless this exact content already exists in the workspace, and pins its version. */
export async function ensureSkill(api: ManagedAgentsApi, dir: string): Promise<SkillPin> {
  const files = readSkillDir(dir);
  const displayName = skillDisplayName(files);
  const skill = (await api.findSkill(displayName)) ?? (await api.createSkill(displayName, files));
  return { skillId: skill.id, version: skill.latestVersion };
}
