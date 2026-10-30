// Profile-specific run settings (P1-03 → P1-07): for each factory.yaml part, the part's profile detects
// against a read-only snapshot of the default branch, then contributes its guidance and network environment.
// Profiles are passed in by the caller (the CLI), so this package names none of them.
import type { EnvironmentSpec, FactoryConfig, Profile, RepoSnapshot } from "@globalhost/core";
import { z } from "zod";
import type { GitHubClient } from "./github.js";

export interface RunSettings {
  guidance?: string;
  environment?: EnvironmentSpec;
}

/** Larger files read as absent: detection only needs manifests and config files. */
export const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().int().optional() })),
});
const FileSchema = z.object({ content: z.string(), encoding: z.literal("base64") });

/**
 * A RepoSnapshot of `ref` over the REST API, so detection never touches a checkout. File contents are data:
 * profiles parse them with their own schemas and don't copy them into guidance (PROFILES.md §1).
 */
export async function githubSnapshot(gh: GitHubClient, repo: string, ref: string): Promise<RepoSnapshot> {
  const tree = await gh.request("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, undefined, TreeSchema);
  if (tree.truncated) throw new Error(`${repo}: the file tree is too large to snapshot`);
  const blobs = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.size ?? 0]));
  const cache = new Map<string, Promise<string | undefined>>();
  const read = async (path: string): Promise<string | undefined> => {
    const size = blobs.get(path);
    if (size === undefined || size > MAX_SNAPSHOT_FILE_BYTES) return undefined;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const file = await gh.request("GET", `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, undefined, FileSchema);
    return Buffer.from(file.content, "base64").toString("utf8");
  };
  return {
    files: [...blobs.keys()],
    readFile: (path) => {
      let hit = cache.get(path);
      if (!hit) cache.set(path, (hit = read(path)));
      return hit;
    },
  };
}

/**
 * Guidance is every part's, in factory.yaml order. A run sees the whole repo, so its environment allows the
 * hosts of every profile in use; with one profile that is exactly the profile's environment.
 */
export async function profileRunSettings(profiles: readonly Profile[], config: FactoryConfig, snapshot: RepoSnapshot): Promise<RunSettings> {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const guidance: string[] = [];
  const used = new Map<string, Profile>();
  for (const [name, part] of Object.entries(config.parts)) {
    const profile = byId.get(part.profile);
    if (!profile) throw new Error(`parts.${name}: profile ${part.profile} is not registered`);
    const detection = await profile.detect(snapshot, part.path);
    guidance.push(profile.guidance({ name, path: part.path, config: part.config, detection }));
    used.set(profile.id, profile);
  }
  if (used.size === 0) return {};
  const envs = [...used.values()].map((p) => p.environment);
  const environment =
    envs.length === 1
      ? envs[0]!
      : {
          name: `globalhost-${[...used.keys()].sort().join("-")}`,
          allowedHosts: [...new Set(envs.flatMap((e) => e.allowedHosts))].sort(),
        };
  return { guidance: guidance.join("\n"), environment };
}
