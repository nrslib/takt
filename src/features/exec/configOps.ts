import type { ProviderType } from '../../infra/providers/index.js';
import type { TaskExecutionOptions } from '../tasks/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  assertExecConfig,
  assertExecProviderModel,
  assertExecProviderEffort,
  getDefaultExecModel,
  getDefaultExecEffort,
  providerSupportsExecEffort,
} from './configValidation.js';
import type { ExecActorConfig, ExecConfig, ExecEffort } from './types.js';

export function formatProviderModel(provider: ProviderType, model: string | undefined): string {
  const formattedProvider = sanitizeTerminalText(provider);
  if (model === undefined) {
    return `${formattedProvider}/(provider default)`;
  }
  const formattedModel = sanitizeTerminalText(model);
  if (model.startsWith(`${provider}/`)) {
    return formattedModel;
  }
  return `${formattedProvider}/${formattedModel}`;
}

export function resolveEffortAfterProviderOverride(
  currentProvider: ProviderType,
  nextProvider: ProviderType,
  effort: ExecEffort | undefined,
): ExecEffort | undefined {
  if (currentProvider === nextProvider) {
    return effort;
  }
  if (effort !== undefined && providerSupportsExecEffort(nextProvider, effort)) {
    return effort;
  }
  return getDefaultExecEffort(nextProvider);
}

export function resolveModelAfterProviderOverride(
  currentProvider: ProviderType,
  nextProvider: ProviderType,
  currentModel: string | undefined,
  overrideModel: string | undefined,
): string | undefined {
  if (overrideModel !== undefined) {
    return overrideModel;
  }
  if (currentProvider === nextProvider) {
    return currentModel;
  }
  return getDefaultExecModel(nextProvider);
}

function applyProviderOverride<T extends { provider: ProviderType; model?: string; effort?: ExecEffort }>(
  config: T,
  overrides: TaskExecutionOptions | undefined,
  errorPath: string,
): T {
  const provider = overrides?.provider ?? config.provider;
  const model = resolveModelAfterProviderOverride(config.provider, provider, config.model, overrides?.model);
  const next = {
    ...config,
    provider,
    model,
    effort: resolveEffortAfterProviderOverride(config.provider, provider, config.effort),
  } as T;
  assertExecProviderModel(next.provider, next.model, `${errorPath}.model`);
  assertExecProviderEffort(next.provider, next.model, next.effort, `${errorPath}.effort`);
  return next;
}

export function applyExecOverrides(config: ExecConfig, overrides: TaskExecutionOptions | undefined): ExecConfig {
  if (overrides === undefined || (overrides.provider === undefined && overrides.model === undefined)) {
    return config;
  }
  const next = {
    ...config,
    session: applyProviderOverride(config.session, overrides, 'exec.session'),
    workers: config.workers.map((worker, index) => applyProviderOverride(worker, overrides, `exec.workers[${index}]`)),
    judges: config.judges.map((judge, index) => applyProviderOverride(judge, overrides, `exec.judges[${index}]`)),
  };
  assertExecConfig(next);
  return next;
}

export function formatExecConfigSummary(config: ExecConfig): string {
  return [
    `Session: ${formatProviderModel(config.session.provider, config.session.model)}`,
    `Worker x${config.workers.length}: ${config.workers.map((worker) => formatProviderModel(worker.provider, worker.model)).join(', ')}`,
    `Judge x${config.judges.length}: ${config.judges.map((judge) => formatProviderModel(judge.provider, judge.model)).join(', ')}`,
  ].join('  |  ');
}

export function formatActorDetails(actor: ExecActorConfig): string {
  const effort = actor.effort ? `/${sanitizeTerminalText(actor.effort)}` : '';
  return `${formatProviderModel(actor.provider, actor.model)}${effort} · instruction: ${sanitizeTerminalText(actor.instruction)}`;
}
