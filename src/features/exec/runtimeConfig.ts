import { resolveNonWorkflowProviderOptions } from '../../infra/config/index.js';
import { resolveAuxiliaryProviderEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import type { WorkflowConfig } from '../../core/models/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { assertResolvedExecConfig, resolveExecProviderEffort } from './configValidation.js';
import type {
  ExecActorConfig,
  ExecCodexSkillInheritance,
  ExecConfig,
  ExecSessionConfig,
  ResolvedExecActorConfig,
  ResolvedExecConfig,
  ResolvedExecSessionConfig,
} from './types.js';
import { DEFAULT_EXEC_CODEX_SKILL_INHERITANCE } from './types.js';

export interface ExecProviderModelDefaults {
  provider?: ProviderType;
  model?: string;
}

export function resolveExecCodexSkillInheritance(cwd: string): ExecCodexSkillInheritance {
  const providerOptions = resolveNonWorkflowProviderOptions(
    cwd,
    undefined,
    DEFAULT_EXEC_CODEX_SKILL_INHERITANCE,
  );
  return {
    repo: providerOptions?.codex?.skills?.repo ?? DEFAULT_EXEC_CODEX_SKILL_INHERITANCE.repo,
    user: providerOptions?.codex?.skills?.user ?? DEFAULT_EXEC_CODEX_SKILL_INHERITANCE.user,
  };
}

/** `exec` carries no workflow, so provider/model resolve purely from config / runtime.yaml. */
const EXEC_WORKFLOW_CONTEXT: Pick<WorkflowConfig, 'name' | 'provider' | 'model' | 'autoRouting'> = {
  name: 'exec',
};

export function resolveConfiguredExecProviderModel(cwd: string): ExecProviderModelDefaults {
  // Resolve provider/model through the same compiled bundle as execution/preview so an active
  // runtime.yaml surfaces its `profiles.default` provider (a mixed configuration fails fast here
  // too), instead of the legacy resolver silently returning the schema-default provider.
  const env = resolveAuxiliaryProviderEnvironment(cwd, EXEC_WORKFLOW_CONTEXT);
  const provider = env.provider;
  if (provider === undefined) {
    return {};
  }
  return {
    provider,
    ...(env.model !== undefined ? { model: env.model } : {}),
  };
}

function resolveExecModel(
  explicitProvider: ProviderType | undefined,
  explicitModel: string | undefined,
  defaults: ExecProviderModelDefaults,
): string | undefined {
  if (explicitModel !== undefined) {
    return explicitModel;
  }
  if (explicitProvider === undefined || explicitProvider === defaults.provider) {
    return defaults.model;
  }
  return undefined;
}

function resolveExecProvider(
  explicitProvider: ProviderType | undefined,
  defaults: ExecProviderModelDefaults,
  path: string,
): ProviderType {
  const provider = explicitProvider ?? defaults.provider;
  if (provider === undefined) {
    throw new Error(`Provider is not configured for ${path}.`);
  }
  return provider;
}

export function resolveExecProviderModel(
  explicitProvider: ProviderType | undefined,
  explicitModel: string | undefined,
  defaults: ExecProviderModelDefaults,
  path: string,
): { provider: ProviderType; model?: string } {
  const provider = resolveExecProvider(explicitProvider, defaults, path);
  const model = resolveExecModel(explicitProvider, explicitModel, defaults);
  return {
    provider,
    model,
  };
}

function resolveSessionConfig(
  session: ExecSessionConfig,
  defaults: ExecProviderModelDefaults,
): ResolvedExecSessionConfig {
  const providerModel = resolveExecProviderModel(session.provider, session.model, defaults, 'exec.session.provider');
  return {
    ...session,
    ...providerModel,
    effort: resolveExecProviderEffort(providerModel.provider, session.effort, 'exec.session.effort'),
  };
}

function resolveActorConfig(
  actor: ExecActorConfig,
  defaults: ExecProviderModelDefaults,
  path: string,
): ResolvedExecActorConfig {
  const providerModel = resolveExecProviderModel(actor.provider, actor.model, defaults, `${path}.provider`);
  return {
    ...actor,
    ...providerModel,
    effort: resolveExecProviderEffort(providerModel.provider, actor.effort, `${path}.effort`),
  };
}

export function resolveExecConfigProviderModel(
  config: ExecConfig,
  defaults: ExecProviderModelDefaults,
): ResolvedExecConfig {
  const resolved = {
    ...config,
    session: resolveSessionConfig(config.session, defaults),
    workers: config.workers.map((worker, index) => resolveActorConfig(worker, defaults, `exec.workers[${index}]`)),
    reviews: config.reviews.map((review, index) => resolveActorConfig(review, defaults, `exec.reviews[${index}]`)),
  };
  assertResolvedExecConfig(resolved);
  return resolved;
}
