// Profile-agnostic kernel: schema, state machine, policies, interfaces (docs/ARCHITECTURE.md).
// Core never imports a profile or adapter (CLAUDE.md #1): callers pass descriptors in through a Registry.

// The zod instance core validates with. Profiles and adapters build their configSchema from it, so the
// validator and every descriptor agree on one zod version.
export { z } from "zod";

export {
  FACTORY_YAML_ERROR_CODES,
  formatPath,
  type FactoryYamlError,
  type FactoryYamlErrorCode,
  type PathSegment,
} from "./factory-yaml/errors.js";
export {
  MAX_FACTORY_YAML_BYTES,
  MAX_FACTORY_YAML_DEPTH,
  parseFactoryYaml,
  type ParseFactoryYamlResult,
} from "./factory-yaml/parse.js";
export {
  createRegistry,
  type AdapterDescriptor,
  type PreviewKind,
  type ProfileDescriptor,
  type Registry,
} from "./factory-yaml/registry.js";
export {
  AGENT_BRANCH_PREFIX,
  AUTO_MERGE_CATEGORIES,
  AUTONOMY_LEVELS,
  FACTORY_SCHEMA_ID,
  factoryJsonSchema,
  IMMUTABLE_BASELINE,
  NOTIFICATION_MODES,
  PREVIEW_KINDS,
} from "./factory-yaml/schema.js";
export {
  validateFactoryConfig,
  type FactoryConfig,
  type PartConfig,
  type PreviewBinding,
  type ValidateFactoryConfigResult,
} from "./factory-yaml/validate.js";
