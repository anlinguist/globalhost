// Gathers every deterministic fact for an assessment (trusted code; the agent never runs these). The result is
// plain JSON with no secret values, written next to the run as facts.json and summarized for the assessor.
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Profile } from "@globalhost/core";
import { githubSnapshot, type GitHubClient } from "@globalhost/dispatch";
import { bareCloneAll } from "@globalhost/runner";
import { defaultExec, type Exec } from "./common.js";
import { branchFacts, type BranchFacts } from "./checks/branches.js";
import { gcpFacts, keyStatuses, type GcpFacts, type KeyStatus } from "./checks/gcp.js";
import { githubRepoFacts, type RepoFacts } from "./checks/github-repo.js";
import { credentialFiles, runGitleaks, serviceAccountKeys, type CredentialFile, type GitleaksResult } from "./checks/secrets.js";
import { agentDocs, detectStack, testFiles, type StackFacts } from "./checks/stack.js";

export interface AssessmentFacts {
  version: 1;
  gatheredAt: string;
  github: RepoFacts;
  branches: BranchFacts;
  stack: StackFacts;
  tests: { count: number; sample: string[] };
  docs: { agentDocs: string[]; readme: boolean };
  secrets: {
    gitleaks: GitleaksResult;
    credentialFiles: CredentialFile[];
    /** Committed GCP service-account keys and whether each is still active (checked only with GCP access). */
    serviceAccountKeys: KeyStatus[];
  };
  /** Absent unless the owner passed --gcp-project. */
  gcp?: GcpFacts;
}

export interface GatherSpec {
  repo: string;
  profiles: readonly Profile[];
  gcpProject?: string;
}

export interface GatherDeps {
  gh: GitHubClient;
  /** Read-only token for cloning private repos. */
  githubToken?: string;
  exec?: Exec;
  log: (line: string) => void;
  now?: () => number;
  /** Test seam: a local bare clone instead of GitHub. */
  cloneAll?: (cloneUrl: string, token?: string) => Promise<string>;
}

export async function gatherFacts(spec: GatherSpec, deps: GatherDeps): Promise<AssessmentFacts> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  deps.log(`reading ${spec.repo} from the GitHub API`);
  const github = await githubRepoFacts(deps.gh, spec.repo);

  deps.log("cloning every branch (bare, read-only)");
  const bareDir = await (deps.cloneAll ?? bareCloneAll)(github.cloneUrl, deps.githubToken);
  try {
    const branches = await branchFacts(bareDir, github.defaultBranch);
    deps.log(`detecting parts at ${github.defaultBranch}@${branches.defaultSha.slice(0, 12)}`);
    // Pinned to the cloned commit, so detection and the agent's bundle see the same tree.
    const snapshot = await githubSnapshot(deps.gh, spec.repo, branches.defaultSha);
    const stack = await detectStack(spec.profiles, snapshot);
    const tests = testFiles(snapshot.files);

    deps.log("scanning for secrets");
    const gitleaks = await runGitleaks(bareDir, exec);
    if (gitleaks.status !== "ran") deps.log(`gitleaks: ${gitleaks.reason}`);
    const creds = await credentialFiles(bareDir, branches.defaultSha);
    const keys = await serviceAccountKeys(bareDir, creds);

    let gcp: GcpFacts | undefined;
    let keyStatus: KeyStatus[] = keys.map((k) => ({ path: k.path, commit: k.commit, clientEmail: k.clientEmail, reason: "not checked: pass --gcp-project" }));
    if (spec.gcpProject) {
      deps.log(`listing GCP resources in ${spec.gcpProject} (read-only)`);
      gcp = await gcpFacts(spec.gcpProject, exec);
      keyStatus = await keyStatuses(keys, exec);
    }

    return {
      version: 1,
      gatheredAt: new Date(now()).toISOString(),
      github,
      branches,
      stack,
      tests: { count: tests.length, sample: tests.slice(0, 10) },
      docs: { agentDocs: agentDocs(snapshot.files), readme: snapshot.files.some((f) => /^readme(?:\.[a-z]+)?$/i.test(f)) },
      secrets: { gitleaks, credentialFiles: creds, serviceAccountKeys: keyStatus },
      ...(gcp ? { gcp } : {}),
    };
  } finally {
    await rm(dirname(bareDir), { recursive: true, force: true });
  }
}
