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
import { resolveExecConfigProviderModel, resolveExecProviderModel, type ExecProviderModelDefaults } from './runtimeConfig.js';
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
  defaults: ExecProviderModelDefaults,
  errorPath: string,
): T {
  const provider = overrides?.provider ?? config.provider;
  const model = provider === undefined
    ? overrides?.model ?? config.model
    : resolveModelAfterProviderOverride(config.provider, provider, config.model, overrides?.model);
  const nextResolvedProviderModel = provider === undefined && defaults.provider === undefined
    ? undefined
    : resolveExecProviderModel(provider, model, defaults, `${errorPath}.provider`);
  const next = {
    ...config,
    ...(provider !== undefined ? { provider } : {}),
    model,
    effort: nextResolvedProviderModel === undefined
      ? config.effort
      : resolveEffortAfterProviderModelOverride(
        config.provider,
        config.model,
        nextResolvedProviderModel.provider,
        nextResolvedProviderModel.model,
        config.effort,
      ),
  } as T;
  if (nextResolvedProviderModel !== undefined) {
    assertExecProviderModel(nextResolvedProviderModel.provider, nextResolvedProviderModel.model, `${errorPath}.model`);
    assertExecProviderEffort(nextResolvedProviderModel.provider, nextResolvedProviderModel.model, next.effort, `${errorPath}.effort`);
  }
  return next;
}

function normalizeProviderModelEffort<T extends { provider?: ProviderType; model?: string; effort?: ExecEffort }>(
  config: T,
  defaults: ExecProviderModelDefaults,
  errorPath: string,
): T {
  const resolvedProviderModel = resolveExecProviderModel(config.provider, config.model, defaults, `${errorPath}.provider`);
  const effort = resolveEffortAfterProviderModelOverride(
    config.provider,
    config.model,
    resolvedProviderModel.provider,
    resolvedProviderModel.model,
    config.effort,
  );
  if (effort === config.effort) {
    return config;
  }
  return { ...config, effort };
}

export function normalizeExecConfigEfforts(config: ExecConfig, defaults: ExecProviderModelDefaults): ExecConfig {
  const session = normalizeProviderModelEffort(config.session, defaults, 'exec.session');
  const workers = config.workers.map((worker, index) => normalizeProviderModelEffort(worker, defaults, `exec.workers[${index}]`));
  const reviews = config.reviews.map((review, index) => normalizeProviderModelEffort(review, defaults, `exec.reviews[${index}]`));
  if (
    session === config.session
    && workers.every((worker, index) => worker === config.workers[index])
    && reviews.every((review, index) => review === config.reviews[index])
  ) {
    return config;
  }
  return {
    ...config,
    session,
    workers,
    reviews,
  };
}

export function applyExecOverrides(
  config: ExecConfig,
  overrides: TaskExecutionOptions | undefined,
  defaults: ExecProviderModelDefaults,
): ExecConfig {
  if (overrides === undefined || (overrides.provider === undefined && overrides.model === undefined)) {
    const normalized = normalizeExecConfigEfforts(config, defaults);
    assertExecConfig(normalized);
    resolveExecConfigProviderModel(normalized, defaults);
    return normalized;
  }
  const next = {
    ...config,
    session: applyProviderOverride(config.session, overrides, defaults, 'exec.session'),
    workers: config.workers.map((worker, index) => applyProviderOverride(worker, overrides, defaults, `exec.workers[${index}]`)),
    reviews: config.reviews.map((review, index) => applyProviderOverride(review, overrides, defaults, `exec.reviews[${index}]`)),
  };
  const normalized = normalizeExecConfigEfforts(next, defaults);
  assertExecConfig(normalized);
  resolveExecConfigProviderModel(normalized, defaults);
  return normalized;
}

export function formatExecConfigSummary(config: ExecConfig): string {
  assertResolvedExecConfig(config);
  return [
    `Assistant agent: ${formatProviderModel(config.session.provider, config.session.model)}`,
    `Worker agent x${config.workers.length}: ${config.workers.map((worker) => formatProviderModel(worker.provider, worker.model)).join(', ')}`,
    `Review agent x${config.reviews.length}: ${config.reviews.map((review) => formatProviderModel(review.provider, review.model)).join(', ')}`,
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
