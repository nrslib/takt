import { getProvider } from '../../infra/providers/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { resolveWorkflowConfigValues } from '../../infra/config/index.js';
import type { PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import type { ImageAttachmentReference } from '../../shared/types/image-attachments.js';
import type {
  ClaudeEffort,
  CodexReasoningEffort,
  CopilotEffort,
} from '../../core/models/workflow-types.js';
import { callAIWithRetry, type SessionContext } from '../interactive/aiCaller.js';
import type { FacetLookupConfig } from '../catalog/catalogFacets.js';
import type { ResolvedExecConfig, ResolvedExecSessionConfig } from './types.js';
import { assertExecProviderEffort, CLAUDE_TOOL_PROVIDERS } from './configValidation.js';

interface AskExecAssistantOptions {
  readonly permissionMode?: PermissionMode;
  readonly imageAttachments?: ImageAttachmentReference[];
}

export interface ExecSessionContext extends SessionContext {
  readonly facetLookupConfig: FacetLookupConfig;
}

function buildSessionProviderOptions(session: ResolvedExecSessionConfig): StepProviderOptions | undefined {
  assertExecProviderEffort(session.provider, session.effort, 'exec.session.effort');
  if (session.effort === undefined) {
    return undefined;
  }
  if (CLAUDE_TOOL_PROVIDERS.has(session.provider)) {
    return { claude: { effort: session.effort as ClaudeEffort } };
  }
  if (session.provider === 'codex') {
    return { codex: { reasoningEffort: session.effort as CodexReasoningEffort } };
  }
  if (session.provider === 'copilot') {
    return { copilot: { effort: session.effort as CopilotEffort } };
  }
  throw new Error(`Unreachable: assertExecProviderEffort should have rejected provider "${session.provider}" with effort "${session.effort}"`);
}

export function createExecSessionContext(cwd: string, config: ResolvedExecConfig, sessionId?: string): ExecSessionContext {
  const resolvedConfig = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language']);
  const providerOptions = buildSessionProviderOptions(config.session);
  return {
    provider: getProvider(config.session.provider as ProviderType),
    providerType: config.session.provider,
    model: config.session.model,
    lang: resolvedConfig.language,
    personaName: 'exec-assistant',
    sessionId,
    facetLookupConfig: {
      enableBuiltinWorkflows: resolvedConfig.enableBuiltinWorkflows,
      language: resolvedConfig.language,
    },
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
}

export function shouldKeepExecSession(previous: ResolvedExecSessionConfig, next: ResolvedExecSessionConfig): boolean {
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
