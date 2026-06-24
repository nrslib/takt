import type { ProviderType } from '../../infra/providers/index.js';
import type { TaskExecutionOptions } from '../tasks/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  assertExecConfig,
  assertExecProviderEffort,
  getDefaultExecEffort,
  providerSupportsExecEffort,
} from './configValidation.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ExecSessionConfig } from './types.js';

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

function applySessionOverride(session: ExecSessionConfig, overrides: TaskExecutionOptions | undefined): ExecSessionConfig {
  const provider = overrides?.provider ?? session.provider;
  const next = {
    ...session,
    provider,
    ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
    effort: resolveEffortAfterProviderOverride(session.provider, provider, session.effort),
  };
  assertExecProviderEffort(next.provider, next.model, next.effort, 'exec.session.effort');
  return next;
}

function applyActorOverride(actor: ExecActorConfig, overrides: TaskExecutionOptions | undefined): ExecActorConfig {
  const provider = overrides?.provider ?? actor.provider;
  const next = {
    ...actor,
    provider,
    ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
    effort: resolveEffortAfterProviderOverride(actor.provider, provider, actor.effort),
  };
  assertExecProviderEffort(next.provider, next.model, next.effort, `exec.${actor.name}.effort`);
  return next;
}

export function applyExecOverrides(config: ExecConfig, overrides: TaskExecutionOptions | undefined): ExecConfig {
  if (!overrides?.provider && !overrides?.model) {
    return config;
  }
  const next = {
    ...config,
    session: applySessionOverride(config.session, overrides),
    workers: config.workers.map((worker) => applyActorOverride(worker, overrides)),
    judges: config.judges.map((judge) => applyActorOverride(judge, overrides)),
  };
  assertExecConfig(next);
  return next;
}

export function formatExecConfigSummary(config: ExecConfig): string {
  return [
    `Session: ${sanitizeTerminalText(config.session.provider)}/${sanitizeTerminalText(config.session.model)}`,
    `Worker x${config.workers.length}: ${config.workers.map((worker) => `${sanitizeTerminalText(worker.provider)}/${sanitizeTerminalText(worker.model)}`).join(', ')}`,
    `Judge x${config.judges.length}: ${config.judges.map((judge) => `${sanitizeTerminalText(judge.provider)}/${sanitizeTerminalText(judge.model)}`).join(', ')}`,
  ].join('  |  ');
}

export function formatActorDetails(actor: ExecActorConfig): string {
  const effort = actor.effort ? `/${sanitizeTerminalText(actor.effort)}` : '';
  return `${sanitizeTerminalText(actor.provider)}/${sanitizeTerminalText(actor.model)}${effort} · instruction: ${sanitizeTerminalText(actor.instruction)}`;
}
