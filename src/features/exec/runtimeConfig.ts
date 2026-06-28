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
  if (config.provider === undefined) {
    return {};
  }
  return {
    provider: config.provider,
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

function resolveSessionConfig(
  session: ExecSessionConfig,
  defaults: ExecProviderModelDefaults,
): ResolvedExecSessionConfig {
  const provider = resolveExecProvider(session.provider, defaults, 'exec.session.provider');
  const model = resolveExecModel(session.provider, session.model, defaults);
  return {
    ...session,
    provider,
    ...(model !== undefined ? { model } : {}),
  };
}

function resolveActorConfig(
  actor: ExecActorConfig,
  defaults: ExecProviderModelDefaults,
  path: string,
): ResolvedExecActorConfig {
  const provider = resolveExecProvider(actor.provider, defaults, path);
  const model = resolveExecModel(actor.provider, actor.model, defaults);
  return {
    ...actor,
    provider,
    ...(model !== undefined ? { model } : {}),
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
    judges: config.judges.map((judge, index) => resolveActorConfig(judge, defaults, `exec.judges[${index}].provider`)),
  };
  assertResolvedExecConfig(resolved);
  return resolved;
}

export function resolveExecRuntimeConfig(cwd: string, config: ExecConfig): ResolvedExecConfig {
  return resolveExecConfigProviderModel(config, resolveConfiguredExecProviderModel(cwd));
}
