import { resolveWorkflowConfigValues } from '../../infra/config/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { assertResolvedExecConfig } from './configValidation.js';
import type {
  ExecActorConfig,
  ExecConfig,
  ExecSessionConfig,
  ResolvedExecActorConfig,
  ResolvedExecConfig,
  ResolvedExecSessionConfig,
} from './types.js';

export interface ExecProviderModelDefaults {
  provider?: ProviderType;
  model?: string;
}

export function resolveConfiguredExecProviderModel(cwd: string): ExecProviderModelDefaults {
  const config = resolveWorkflowConfigValues(cwd, ['provider', 'model']);
  const provider = config.provider;
  if (provider === undefined) {
    return {};
  }
  return {
    provider,
    ...(config.model !== undefined ? { model: config.model } : {}),
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
  return {
    ...session,
    ...resolveExecProviderModel(session.provider, session.model, defaults, 'exec.session.provider'),
  };
}

function resolveActorConfig(
  actor: ExecActorConfig,
  defaults: ExecProviderModelDefaults,
  path: string,
): ResolvedExecActorConfig {
  return {
    ...actor,
    ...resolveExecProviderModel(actor.provider, actor.model, defaults, path),
  };
}

export function resolveExecConfigProviderModel(
  config: ExecConfig,
  defaults: ExecProviderModelDefaults,
): ResolvedExecConfig {
  const resolved = {
    ...config,
    session: resolveSessionConfig(config.session, defaults),
    workers: config.workers.map((worker, index) => resolveActorConfig(worker, defaults, `exec.workers[${index}].provider`)),
    reviews: config.reviews.map((review, index) => resolveActorConfig(review, defaults, `exec.reviews[${index}].provider`)),
  };
  assertResolvedExecConfig(resolved);
  return resolved;
}
