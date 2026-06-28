import {
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_EFFORT_VALUES,
  COPILOT_EFFORT_VALUES,
  type ClaudeEffort,
} from '../../core/models/workflow-types.js';
import { validateClaudeEffortCompatibility } from '../../core/workflow/claude-effort-compatibility.js';
import { validateProviderModelCompatibility } from '../../core/workflow/provider-model-compatibility.js';
import type { ProviderType } from '../../infra/providers/index.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ResolvedExecConfig } from './types.js';

export const EXEC_PROVIDERS: readonly ProviderType[] = [
  'claude',
  'claude-sdk',
  'claude-terminal',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'kiro',
  'mock',
];

export const EXEC_EFFORTS: readonly ExecEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EXEC_MODEL_CANDIDATES: Partial<Record<ProviderType, readonly string[]>> = {
  claude: ['opus', 'sonnet', 'haiku'],
  'claude-sdk': ['opus', 'sonnet', 'haiku'],
  'claude-terminal': ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5'],
  opencode: ['opencode/big-pickle'],
  mock: ['mock-model'],
};
const EXEC_OPTIONAL_MODEL_PROVIDERS: ReadonlySet<ProviderType> = new Set(['cursor', 'copilot', 'kiro']);

export const CLAUDE_TOOL_PROVIDERS: ReadonlySet<ProviderType> = new Set(['claude', 'claude-sdk', 'claude-terminal']);

const EXEC_ACTOR_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const RESERVED_EXEC_SESSION_KEY_BASES = new Set([
  'execute',
  'review',
  'replan',
  'exec-assistant',
  'exec-replan',
  'exec-loop-monitor-small',
  'exec-loop-monitor-large',
  '_loop_judge_execute_review',
  '_loop_judge_replan_execute_review',
]);

export function providerSupportsExecEffort(provider: ProviderType, effort: ExecEffort): boolean {
  if (CLAUDE_TOOL_PROVIDERS.has(provider)) {
    return CLAUDE_EFFORT_VALUES.includes(effort as typeof CLAUDE_EFFORT_VALUES[number]);
  }
  if (provider === 'codex') {
    return CODEX_REASONING_EFFORT_VALUES.includes(effort as typeof CODEX_REASONING_EFFORT_VALUES[number]);
  }
  if (provider === 'copilot') {
    return COPILOT_EFFORT_VALUES.includes(effort as typeof COPILOT_EFFORT_VALUES[number]);
  }
  return false;
}

export function getSupportedExecEfforts(provider: ProviderType): ExecEffort[] {
  return EXEC_EFFORTS.filter((effort) => providerSupportsExecEffort(provider, effort));
}

export function getExecModelCandidates(provider: ProviderType): readonly string[] {
  return EXEC_MODEL_CANDIDATES[provider] ?? [];
}

export function providerAllowsOmittedExecModel(provider: ProviderType): boolean {
  return EXEC_OPTIONAL_MODEL_PROVIDERS.has(provider);
}

export function assertExecProviderModel(provider: ProviderType, model: string | undefined, path: string): void {
  if (model !== undefined && model.trim().length === 0) {
    throw new Error(`Invalid exec config at ${path}: expected non-empty string`);
  }
  try {
    validateProviderModelCompatibility(provider, model, {
      modelFieldName: `Invalid exec config at ${path}`,
    });
  } catch (error) {
    throw new Error(`Invalid exec config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertExecProviderEffort(
  provider: ProviderType,
  model: string | undefined,
  effort: ExecEffort | undefined,
  path: string,
): void {
  if (effort === undefined) {
    return;
  }
  if (!providerSupportsExecEffort(provider, effort)) {
    throw new Error(`Invalid exec config at ${path}: provider "${provider}" does not support effort "${effort}"`);
  }
  if (CLAUDE_TOOL_PROVIDERS.has(provider) && model !== undefined) {
    validateClaudeEffortCompatibility(model, effort as ClaudeEffort);
  }
}

function assertUniqueActorSessionKeys(actors: ExecActorConfig[]): void {
  const seen = new Set<string>();
  for (const actor of actors) {
    assertExecActorName(actor.name, `exec actor "${actor.name}"`);
    if (seen.has(actor.name)) {
      throw new Error(`Invalid exec config: duplicate actor name/session_key "${actor.name}"`);
    }
    seen.add(actor.name);
  }
}

export function assertExecActorName(name: string, path: string): void {
  if (!EXEC_ACTOR_NAME_REGEX.test(name)) {
    throw new Error(`Invalid exec config at ${path}: actor name must match ${EXEC_ACTOR_NAME_REGEX}`);
  }
  if (RESERVED_EXEC_SESSION_KEY_BASES.has(name)) {
    throw new Error(`Invalid exec config at ${path}: actor name "${name}" is reserved for exec workflow session routing`);
  }
}

function assertExecProviderConfigured(
  provider: ProviderType | undefined,
  path: string,
): asserts provider is ProviderType {
  if (provider === undefined) {
    throw new Error(`Invalid exec config at ${path}: provider is not resolved`);
  }
}

export function assertExecConfig(config: ExecConfig): void {
  if (config.session.model !== undefined && config.session.model.trim().length === 0) {
    throw new Error('Invalid exec config at exec.session.model: expected non-empty string');
  }
  if (config.session.provider !== undefined) {
    assertExecProviderModel(config.session.provider, config.session.model, 'exec.session.model');
    assertExecProviderEffort(config.session.provider, config.session.model, config.session.effort, 'exec.session.effort');
  }
  assertUniqueActorSessionKeys([...config.workers, ...config.reviews]);
  config.workers.forEach((worker, index) => {
    if (worker.model !== undefined && worker.model.trim().length === 0) {
      throw new Error(`Invalid exec config at exec.workers[${index}].model: expected non-empty string`);
    }
    if (worker.provider !== undefined) {
      assertExecProviderModel(worker.provider, worker.model, `exec.workers[${index}].model`);
      assertExecProviderEffort(worker.provider, worker.model, worker.effort, `exec.workers[${index}].effort`);
    }
  });
  config.reviews.forEach((review, index) => {
    if (review.model !== undefined && review.model.trim().length === 0) {
      throw new Error(`Invalid exec config at exec.reviews[${index}].model: expected non-empty string`);
    }
    if (review.provider !== undefined) {
      assertExecProviderModel(review.provider, review.model, `exec.reviews[${index}].model`);
      assertExecProviderEffort(review.provider, review.model, review.effort, `exec.reviews[${index}].effort`);
    }
  });
}

export function assertResolvedExecConfig(config: ExecConfig): asserts config is ResolvedExecConfig {
  assertExecProviderConfigured(config.session.provider, 'exec.session.provider');
  assertExecProviderModel(config.session.provider, config.session.model, 'exec.session.model');
  assertExecProviderEffort(config.session.provider, config.session.model, config.session.effort, 'exec.session.effort');
  assertUniqueActorSessionKeys([...config.workers, ...config.reviews]);
  config.workers.forEach((worker, index) => {
    assertExecProviderConfigured(worker.provider, `exec.workers[${index}].provider`);
    assertExecProviderModel(worker.provider, worker.model, `exec.workers[${index}].model`);
    assertExecProviderEffort(worker.provider, worker.model, worker.effort, `exec.workers[${index}].effort`);
  });
  config.reviews.forEach((review, index) => {
    assertExecProviderConfigured(review.provider, `exec.reviews[${index}].provider`);
    assertExecProviderModel(review.provider, review.model, `exec.reviews[${index}].model`);
    assertExecProviderEffort(review.provider, review.model, review.effort, `exec.reviews[${index}].effort`);
  });
}
