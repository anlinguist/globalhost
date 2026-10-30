import { z } from "zod";

/** Immutable numeric IDs only: names can be renamed and re-registered (ADR-0013). */
const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/, "expected a numeric GitHub ID");

export const DispatchRepoSchema = z
  .object({
    /** `owner/name`, for readability and the README; access is pinned by `id`. */
    name: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    id: numericId,
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  })
  .strict();
export type DispatchRepo = z.infer<typeof DispatchRepoSchema>;

export const FactoryConfigSchema = z
  .object({
    project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    region: z.string().regex(/^[a-z]+-[a-z]+[0-9]$/),
    githubOwnerId: numericId,
    dispatchRepos: z.array(DispatchRepoSchema).min(1),
    /** GitHub environment a product repo's dispatcher job must run in to get sa:gh-dispatch. */
    dispatchEnvironment: z.string().regex(/^[A-Za-z0-9_-]+$/).default("globalhost"),
    /** Existing WIF pool (created by infra/bootstrap/security-audit.sh); imported, not duplicated. */
    wifPoolId: z.string().default("github"),
    wifPoolDisplayName: z.string().default("GitHub Actions"),
    monthlyBudgetUsd: z.number().positive().default(25),
    budgetThresholds: z.array(z.number().positive().max(2)).min(1).default([0.4, 0.8, 1.0]),
  })
  .strict();
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type FactoryConfigInput = z.input<typeof FactoryConfigSchema>;

export function parseFactoryConfig(input: unknown): FactoryConfig {
  const config = FactoryConfigSchema.parse(input);
  const ids = config.dispatchRepos.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("dispatchRepos: duplicate repository id");
  return config;
}
