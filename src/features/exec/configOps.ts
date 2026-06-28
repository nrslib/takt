import type { ProviderType } from '../../infra/providers/index.js';
import type { TaskExecutionOptions } from '../tasks/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import { execLabel, type ExecLanguage } from './labels.js';
import {
  assertExecConfig,
  assertExecProviderModel,
  assertExecProviderEffort,
  assertResolvedExecConfig,
} from './configValidation.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ResolvedExecActorConfig } from './types.js';

export function formatProviderModel(provider: ProviderType, model: string | undefined, lang?: ExecLanguage): string {
  const formattedProvider = sanitizeTerminalText(provider);
  if (model === undefined) {
    const providerDefault = lang === undefined ? 'provider default' : execLabel(lang, 'common.providerDefault');
    return `${formattedProvider}/(${providerDefault})`;
  }
  const formattedModel = sanitizeTerminalText(model);
  if (model.startsWith(`${provider}/`)) {
    return formattedModel;
  }
  return `${formattedProvider}/${formattedModel}`;
}

export function resolveEffortAfterProviderOverride(
  currentProvider: ProviderType | undefined,
  nextProvider: ProviderType,
  effort: ExecEffort | undefined,
): ExecEffort | undefined {
  return resolveEffortAfterProviderModelOverride(currentProvider, undefined, nextProvider, undefined, effort);
}

function canKeepEffortForProviderModel(
  provider: ProviderType,
  model: string | undefined,
  effort: ExecEffort,
): boolean {
  try {
    assertExecProviderEffort(provider, model, effort, 'exec.effort');
    return true;
  } catch {
    return false;
  }
}

export function resolveEffortAfterProviderModelOverride(
  currentProvider: ProviderType | undefined,
  currentModel: string | undefined,
  nextProvider: ProviderType,
  nextModel: string | undefined,
  effort: ExecEffort | undefined,
): ExecEffort | undefined {
  if (effort === undefined) {
    return undefined;
  }
  if (currentProvider === nextProvider && currentModel === nextModel) {
    return effort;
  }
  return canKeepEffortForProviderModel(nextProvider, nextModel, effort) ? effort : undefined;
}

export function resolveModelAfterProviderOverride(
  currentProvider: ProviderType | undefined,
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
  return undefined;
}

function applyProviderOverride<T extends { provider?: ProviderType; model?: string; effort?: ExecEffort }>(
  config: T,
  overrides: TaskExecutionOptions | undefined,
  errorPath: string,
): T {
  const provider = overrides?.provider ?? config.provider;
  const model = provider === undefined
    ? overrides?.model ?? config.model
    : resolveModelAfterProviderOverride(config.provider, provider, config.model, overrides?.model);
  const next = {
    ...config,
    ...(provider !== undefined ? { provider } : {}),
    model,
    effort: provider === undefined
      ? config.effort
      : resolveEffortAfterProviderModelOverride(config.provider, config.model, provider, model, config.effort),
  } as T;
  if (next.provider !== undefined) {
    assertExecProviderModel(next.provider, next.model, `${errorPath}.model`);
    assertExecProviderEffort(next.provider, next.model, next.effort, `${errorPath}.effort`);
  }
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
  assertResolvedExecConfig(config);
  return [
    `Assistant agent: ${formatProviderModel(config.session.provider, config.session.model)}`,
    `Worker agent x${config.workers.length}: ${config.workers.map((worker) => formatProviderModel(worker.provider, worker.model)).join(', ')}`,
    `Judge agent x${config.judges.length}: ${config.judges.map((judge) => formatProviderModel(judge.provider, judge.model)).join(', ')}`,
  ].join('  |  ');
}

function assertResolvedExecActorConfig(actor: ExecActorConfig): asserts actor is ResolvedExecActorConfig {
  if (actor.provider === undefined) {
    throw new Error(`Invalid exec config at exec.${actor.name}.provider: provider is not resolved`);
  }
}

export function formatActorDetails(actor: ExecActorConfig, lang?: ExecLanguage): string {
  assertResolvedExecActorConfig(actor);
  const effort = actor.effort ? `/${sanitizeTerminalText(actor.effort)}` : '';
  const instruction = lang === undefined
    ? `instruction: ${sanitizeTerminalText(actor.instruction)}`
    : execLabel(lang, 'fields.actorInstruction', { value: sanitizeTerminalText(actor.instruction) });
  return `${formatProviderModel(actor.provider, actor.model, lang)}${effort} · ${instruction}`;
}
