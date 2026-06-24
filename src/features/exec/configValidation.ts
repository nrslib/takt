import {
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_EFFORT_VALUES,
  COPILOT_EFFORT_VALUES,
  type ClaudeEffort,
} from '../../core/models/workflow-types.js';
import { validateClaudeEffortCompatibility } from '../../core/workflow/claude-effort-compatibility.js';
import type { ProviderType } from '../../infra/providers/index.js';
import type { ExecActorConfig, ExecConfig, ExecEffort } from './types.js';

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
const DEFAULT_EXEC_EFFORT: ExecEffort = 'high';

export const CLAUDE_TOOL_PROVIDERS: ReadonlySet<ProviderType> = new Set(['claude', 'claude-sdk', 'claude-terminal']);

const EXEC_ACTOR_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const RESERVED_EXEC_SESSION_KEY_BASES = new Set([
  'execute',
  'judge',
  'replan',
  'exec-assistant',
  'exec-replan',
  'exec-loop-monitor-small',
  'exec-loop-monitor-large',
  '_loop_judge_execute_judge',
  '_loop_judge_replan_execute_judge',
]);

function assertEffortValue<T extends string>(
  values: readonly T[],
  effort: ExecEffort,
  provider: ProviderType,
  path: string,
): asserts effort is ExecEffort & T {
  if (!values.includes(effort as T)) {
    throw new Error(`Invalid exec config at ${path}: provider "${provider}" does not support effort "${effort}"`);
  }
}

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

export function getDefaultExecEffort(provider: ProviderType): ExecEffort | undefined {
  if (providerSupportsExecEffort(provider, DEFAULT_EXEC_EFFORT)) {
    return DEFAULT_EXEC_EFFORT;
  }
  return getSupportedExecEfforts(provider)[0];
}

export function assertExecProviderEffort(
  provider: ProviderType,
  model: string,
  effort: ExecEffort | undefined,
  path: string,
): void {
  if (effort === undefined) {
    if (getSupportedExecEfforts(provider).length > 0) {
      throw new Error(`Invalid exec config at ${path}: provider "${provider}" requires effort`);
    }
    return;
  }
  if (CLAUDE_TOOL_PROVIDERS.has(provider)) {
    assertEffortValue(CLAUDE_EFFORT_VALUES, effort, provider, path);
    validateClaudeEffortCompatibility(model, effort as ClaudeEffort);
    return;
  }
  if (provider === 'codex') {
    assertEffortValue(CODEX_REASONING_EFFORT_VALUES, effort, provider, path);
    return;
  }
  if (provider === 'copilot') {
    assertEffortValue(COPILOT_EFFORT_VALUES, effort, provider, path);
    return;
  }
  throw new Error(`Invalid exec config at ${path}: provider "${provider}" does not support effort "${effort}"`);
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

export function assertExecConfig(config: ExecConfig): void {
  assertExecProviderEffort(config.session.provider, config.session.model, config.session.effort, 'exec.session.effort');
  assertUniqueActorSessionKeys([...config.workers, ...config.judges]);
  config.workers.forEach((worker, index) => {
    assertExecProviderEffort(worker.provider, worker.model, worker.effort, `exec.workers[${index}].effort`);
  });
  config.judges.forEach((judge, index) => {
    assertExecProviderEffort(judge.provider, judge.model, judge.effort, `exec.judges[${index}].effort`);
  });
}
