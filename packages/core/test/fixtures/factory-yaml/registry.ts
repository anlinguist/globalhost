// Fake profiles and adapters for the factory.yaml fixtures. Core tests never use real ones (CLAUDE.md #1).
import { z } from "zod";
import { createRegistry, type AdapterDescriptor, type ProfileDescriptor } from "../../../src/index.js";

/** A hosted web part: has a URL preview, accepts API_URL / AUTH_URL bindings. Closed config with defaults. */
export const fakeWeb: ProfileDescriptor = {
  id: "fake-web",
  configSchema: z.strictObject({
    port: z.number().int().min(1).max(65535).default(3000),
    routes: z.array(z.string()).default(() => ["/"]),
  }),
  preview: { kinds: ["url", "screenshots"], outputs: ["url"], inputs: ["API_URL", "AUTH_URL"] },
  release: { allowedAdapters: ["fake-deploy"] },
};

/** A hosted API part: requires `entry`, exposes `url` and `docsUrl`, accepts no bindings. */
export const fakeApi: ProfileDescriptor = {
  id: "fake-api",
  configSchema: z.strictObject({ entry: z.string() }),
  preview: { kinds: ["url", "api-docs"], outputs: ["url", "docsUrl"], inputs: [] },
  release: { allowedAdapters: ["fake-deploy", "fake-run"] },
};

/** A non-hosted artifact part (no URL preview, so no dev environment needed). Open config. */
export const fakeExt: ProfileDescriptor = {
  id: "fake-ext",
  configSchema: z.looseObject({}),
  preview: { kinds: ["artifact", "screenshots"], outputs: ["zip"], inputs: ["API_URL"] },
  release: { allowedAdapters: ["fake-store"] },
};

export const fakeDeploy: AdapterDescriptor = {
  id: "fake-deploy",
  configSchema: z.strictObject({ project: z.string(), trigger: z.string() }),
};

export const fakeRun: AdapterDescriptor = {
  id: "fake-run",
  configSchema: z.strictObject({ service: z.string(), region: z.string().default("us-central1") }),
};

export const fakeStore: AdapterDescriptor = {
  id: "fake-store",
  configSchema: z.strictObject({ itemId: z.string().optional() }),
};

export const fakeRegistry = createRegistry([fakeWeb, fakeApi, fakeExt], [fakeDeploy, fakeRun, fakeStore]);
