import { getProvider } from '../../infra/providers/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import type { PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import {
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_EFFORT_VALUES,
  COPILOT_EFFORT_VALUES,
  type ClaudeEffort,
  type CodexReasoningEffort,
  type CopilotEffort,
} from '../../core/models/workflow-types.js';
import { callAIWithRetry, type SessionContext } from '../interactive/aiCaller.js';
import type { ExecConfig, ExecSessionConfig } from './types.js';
import { assertExecProviderEffort } from './configValidation.js';
import type { ExecEffort } from './types.js';

interface AskExecAssistantOptions {
  readonly permissionMode?: PermissionMode;
}

function requireProviderEffort<T extends string>(values: readonly T[], effort: ExecEffort): T {
  if (!values.includes(effort as T)) {
    throw new Error(`Unsupported exec effort "${effort}" for provider session options.`);
  }
  return effort as T;
}

function buildSessionProviderOptions(session: ExecSessionConfig): StepProviderOptions | undefined {
  assertExecProviderEffort(session.provider, session.model, session.effort, 'exec.session.effort');
  if (session.effort === undefined) {
    return undefined;
  }
  if (session.provider === 'claude' || session.provider === 'claude-sdk' || session.provider === 'claude-terminal') {
    return { claude: { effort: requireProviderEffort<ClaudeEffort>(CLAUDE_EFFORT_VALUES, session.effort) } };
  }
  if (session.provider === 'codex') {
    return { codex: { reasoningEffort: requireProviderEffort<CodexReasoningEffort>(CODEX_REASONING_EFFORT_VALUES, session.effort) } };
  }
  if (session.provider === 'copilot') {
    return { copilot: { effort: requireProviderEffort<CopilotEffort>(COPILOT_EFFORT_VALUES, session.effort) } };
  }
  return undefined;
}

export function createExecSessionContext(cwd: string, config: ExecConfig, sessionId?: string): SessionContext {
  const language = resolveConfigValue(cwd, 'language');
  const providerOptions = buildSessionProviderOptions(config.session);
  return {
    provider: getProvider(config.session.provider as ProviderType),
    providerType: config.session.provider,
    model: config.session.model,
    lang: language === 'ja' ? 'ja' : 'en',
    personaName: 'exec-assistant',
    sessionId,
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
}

export function shouldKeepExecSession(previous: ExecSessionConfig, next: ExecSessionConfig): boolean {
  return previous.provider === next.provider && previous.model === next.model;
}

export async function askExecAssistant(
  cwd: string,
  ctx: SessionContext,
  prompt: string,
  systemPrompt: string,
  options: AskExecAssistantOptions = {},
): Promise<{ content: string; sessionId: string | undefined }> {
  const { result, sessionId } = await callAIWithRetry(prompt, systemPrompt, [], cwd, ctx, options);
  if (!result) {
    throw new Error('Exec assistant call failed.');
  }
  if (!result.success) {
    throw new Error(result.content);
  }
  return { content: result.content.trim(), sessionId };
}
