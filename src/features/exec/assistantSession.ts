import { getProvider } from '../../infra/providers/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import {
  resolveNonWorkflowProviderModel,
  resolveNonWorkflowProviderOptions,
  resolveWorkflowConfigValues,
} from '../../infra/config/index.js';
import { mergeProviderOptions } from '../../infra/config/providerOptions.js';
import type { PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import type { ImageAttachmentReference } from '../../shared/types/image-attachments.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { callAIWithRetry, type SessionContext } from '../interactive/aiCaller.js';
import type { FacetLookupConfig } from '../catalog/catalogFacets.js';
import type {
  ExecCodexSkillInheritance,
  ResolvedExecConfig,
  ResolvedExecSessionConfig,
} from './types.js';
import { resolveExecCodexSkillInheritance } from './runtimeConfig.js';
import { assertExecProviderEffort, CLAUDE_TOOL_PROVIDERS } from './configValidation.js';

interface AskExecAssistantOptions {
  readonly permissionMode?: PermissionMode;
  readonly imageAttachments?: ImageAttachmentReference[];
  /** Lets the caller stop a turn that is still running. */
  readonly abortSignal?: AbortSignal;
  /**
   * `silent` when the caller draws its own frames: a stray write from the
   * stream display would land in the middle of them.
   */
  readonly outputMode?: 'terminal' | 'silent';
  /** Where the answer streams to when the caller renders it itself. */
  readonly onStream?: StreamCallback;
  /** Receives what a terminal caller would have printed next to the answer. */
  readonly onNotice?: (message: string) => void;
}

export interface ExecSessionContext extends SessionContext {
  readonly facetLookupConfig: FacetLookupConfig;
  readonly codexSkillInheritance: ExecCodexSkillInheritance;
}

function buildSessionProviderOptions(session: ResolvedExecSessionConfig): StepProviderOptions | undefined {
  assertExecProviderEffort(session.provider, session.effort, 'exec.session.effort');
  if (session.effort === undefined) {
    return undefined;
  }
  if (CLAUDE_TOOL_PROVIDERS.has(session.provider)) {
    return { claude: { effort: session.effort } };
  }
  if (session.provider === 'codex') {
    return { codex: { reasoningEffort: session.effort } };
  }
  if (session.provider === 'copilot') {
    return { copilot: { effort: session.effort } };
  }
  throw new Error(`Unreachable: assertExecProviderEffort should have rejected provider "${session.provider}" with effort "${session.effort}"`);
}

function withCodexSkillInheritance(
  providerOptions: StepProviderOptions | undefined,
  inheritance: ExecCodexSkillInheritance,
): StepProviderOptions {
  return {
    ...providerOptions,
    codex: {
      ...providerOptions?.codex,
      skills: inheritance,
    },
  };
}

export function createExecSessionContext(
  cwd: string,
  config: ResolvedExecConfig,
  sessionId?: string,
  codexSkillInheritance: ExecCodexSkillInheritance = resolveExecCodexSkillInheritance(cwd),
): ExecSessionContext {
  const resolvedConfig = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language']);
  const sessionProviderOptions = withCodexSkillInheritance(
    buildSessionProviderOptions(config.session),
    codexSkillInheritance,
  );
  const runtimeProvider = resolveNonWorkflowProviderModel(cwd);
  const providerOptions = runtimeProvider.runtimeManaged
    && runtimeProvider.provider === config.session.provider
    ? resolveNonWorkflowProviderOptions(
        cwd,
        mergeProviderOptions(runtimeProvider.providerOptions, sessionProviderOptions),
      )
    : resolveNonWorkflowProviderOptions(cwd, sessionProviderOptions);
  return {
    provider: getProvider(config.session.provider as ProviderType),
    providerType: config.session.provider,
    model: config.session.model,
    lang: resolvedConfig.language,
    personaName: 'exec-assistant',
    sessionId,
    codexSkillInheritance,
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
  const { result, sessionId, error } = await callAIWithRetry(prompt, systemPrompt, [], cwd, ctx, options);
  if (!result) {
    // The call threw, and its reason is the only account of what happened —
    // replacing it with a generic sentence is how a failure becomes a mystery.
    throw new Error(error ?? 'Exec assistant call failed.');
  }
  if (!result.success) {
    throw new Error(result.content);
  }
  return { content: result.content.trim(), sessionId };
}
