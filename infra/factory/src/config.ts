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

const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);

/** A product whose PRs get hosted previews in its own dev project (PLAN P1-11, ARCHITECTURE §2.6). */
export const PreviewProductSchema = z
  .object({
    /** factory.yaml `product`; also the prefix of preview hosts and resource names. */
    product: z.string().regex(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/),
    /** Never the prod project: previews only ever touch dev data (ADR-0007). */
    devProject: projectId.refine((p) => p.endsWith("-dev"), "a preview project id must end in -dev"),
    repo: DispatchRepoSchema,
    /** Hosted parts (factory.yaml part names, no hyphens); one `<product>-<part>-preview` service each. */
    parts: z.array(z.string().regex(/^[a-z][a-z0-9]{0,19}$/)).min(1),
  })
  .strict();
export type PreviewProduct = z.infer<typeof PreviewProductSchema>;

/**
 * A product whose merges the factory watches deploy (PLAN P1-12): read-only access to Cloud Build builds in its
 * prod project, for the default branch's `globalhost-release.yml` only (ADR-0017).
 */
export const ReleaseObserverSchema = z
  .object({
    product: z.string().regex(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/),
    prodProject: projectId.refine((p) => !p.endsWith("-dev"), "the release observer watches the prod project"),
    repo: DispatchRepoSchema,
  })
  .strict();
export type ReleaseObserver = z.infer<typeof ReleaseObserverSchema>;

/** Not committed: identifiers are kept out of the public repo (`pulumi config set --secret cloudflare`). */
export const CloudflareConfigSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    zoneId: z.string().regex(/^[a-f0-9]{32}$/),
    zone: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/),
    /** Access team domain; the `iss` access-guard checks is `https://<teamDomain>`. */
    teamDomain: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/),
    /** Who may open previews. */
    ownerEmails: z.array(z.email()).min(1),
  })
  .strict();
export type CloudflareConfig = z.infer<typeof CloudflareConfigSchema>;

export const FactoryConfigSchema = z
  .object({
    project: projectId,
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
    /** The factory repo's numeric ID: only its main-branch image workflow may publish images. */
    factoryRepoId: numericId,
    previews: z.array(PreviewProductSchema).default([]),
    releaseObservers: z.array(ReleaseObserverSchema).default([]),
    /**
     * Product repos whose `globalhost-review.yml` may act as the review identity (PLAN P2-01, ADR-0018). Each must
     * also be in `dispatchRepos`, with the same name and default branch. `name` must be GitHub's canonical casing
     * (as GITHUB_REPOSITORY reports it): the spend-record IAM condition matches it case-sensitively.
     */
    reviewRepos: z.array(DispatchRepoSchema).default([]),
    /** GitHub environment the review job must run in to get the review identity. Never the dispatch environment. */
    reviewEnvironment: z.string().regex(/^[A-Za-z0-9_-]+$/).default("globalhost-review"),
    /**
     * GitHub user IDs whose PR events may deploy previews: the owner and the factory App's bot user.
     * Enforced in the WIF provider condition, so a PR from anyone else gets no GCP credentials at all.
     */
    previewActorIds: z.array(numericId).default([]),
    /** `<region>-docker.pkg.dev/...@sha256:<digest>`; preview services are created once it is set. */
    accessGuardImage: z
      .string()
      .regex(/^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type FactoryConfigInput = z.input<typeof FactoryConfigSchema>;

export function parseFactoryConfig(input: unknown): FactoryConfig {
  const config = FactoryConfigSchema.parse(input);
  const ids = config.dispatchRepos.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("dispatchRepos: duplicate repository id");
  const observed = config.releaseObservers.map((r) => r.product);
  if (new Set(observed).size !== observed.length) throw new Error("releaseObservers: duplicate product");
  // One provider and one role per repo and prod project: a shared repo id would let each product's token reach both
  // identities, and the role id is fixed per project.
  const observedRepos = config.releaseObservers.map((r) => r.repo.id);
  if (new Set(observedRepos).size !== observedRepos.length) throw new Error("releaseObservers: duplicate repo id");
  const prodProjects = config.releaseObservers.map((r) => r.prodProject);
  if (new Set(prodProjects).size !== prodProjects.length) throw new Error("releaseObservers: duplicate prodProject");
  const reviewIds = config.reviewRepos.map((r) => r.id);
  if (new Set(reviewIds).size !== reviewIds.length) throw new Error("reviewRepos: duplicate repo id");
  for (const r of config.reviewRepos) {
    const d = config.dispatchRepos.find((x) => x.id === r.id);
    if (!d || d.name !== r.name || d.defaultBranch !== r.defaultBranch) {
      throw new Error(`reviewRepos: ${r.name} must match a dispatchRepos entry (name, id and default branch)`);
    }
  }
  // A separate environment is the point (ADR-0018): sharing one would let either job's token reach both identities.
  if (config.reviewEnvironment === config.dispatchEnvironment) throw new Error("reviewEnvironment must differ from dispatchEnvironment");
  const products = config.previews.map((p) => p.product);
  if (new Set(products).size !== products.length) throw new Error("previews: duplicate product");
  for (const p of config.previews) {
    for (const part of p.parts) {
      // Cloud Run's limit and the DNS label `pr-<n>---<service>-<project number>` must fit in 63 characters.
      if (`${p.product}-${part}-preview`.length > 37) throw new Error(`previews: ${p.product}-${part}-preview is longer than 37 characters`);
    }
  }
  if (config.previews.length > 0 && config.previewActorIds.length === 0) {
    throw new Error("previews need previewActorIds (the owner and the factory bot)");
  }
  return config;
}
