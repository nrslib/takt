/**
 * AI call with automatic retry on stale/invalid session.
 *
 * Extracted from conversationLoop.ts for single-responsibility:
 * this module handles only the AI call + retry logic.
 */

import {
  updatePersonaSession,
} from '../../infra/config/index.js';
import { isQuietMode } from '../../shared/context.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { info, error, blankLine, StreamDisplay } from '../../shared/ui/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { EXIT_SIGINT } from '../../shared/exitCodes.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getProvider } from '../../infra/providers/index.js';
import type { ImageAttachmentReference } from '../../shared/types/image-attachments.js';
import type { PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import { expandImageAttachmentPlaceholders } from '../../infra/providers/imageAttachmentPrompt.js';
import { buildProviderRuntimeSystemPrompt } from '../../infra/providers/runtimeSystemPrompt.js';

const log = createLogger('ai-caller');

/** Result from a single AI call */
export interface CallAIResult {
  content: string;
  sessionId?: string;
  success: boolean;
}

/** Initialized session context for conversation loops */
export interface SessionContext {
  provider: ReturnType<typeof getProvider>;
  providerType: ProviderType;
  model: string | undefined;
  lang: 'en' | 'ja';
  personaName: string;
  sessionId: string | undefined;
  providerOptions?: StepProviderOptions;
}

interface CallAIWithRetryOptions {
  imageAttachments?: ImageAttachmentReference[];
  permissionMode?: PermissionMode;
  outputMode?: 'terminal' | 'silent';
  abortSignal?: AbortSignal;
}

/**
 * Call AI with automatic retry on stale/invalid session.
 *
 * On session failure, clears sessionId and retries once without session.
 * Updates sessionId and persists it on success.
 */
export async function callAIWithRetry(
  prompt: string,
  systemPrompt: string,
  allowedTools: string[],
  cwd: string,
  ctx: SessionContext,
  options: CallAIWithRetryOptions = {},
): Promise<{ result: CallAIResult | null; sessionId: string | undefined }> {
  const outputMode = options.outputMode ?? 'terminal';
  const display = outputMode === 'terminal'
    ? new StreamDisplay('assistant', isQuietMode())
    : undefined;
  const abortController = new AbortController();
  const onExternalAbort = (): void => {
    abortController.abort(options.abortSignal?.reason);
  };
  if (options.abortSignal?.aborted) {
    onExternalAbort();
  } else {
    options.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }
  let sigintCount = 0;
  const onSigInt = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      blankLine();
      info(getLabel('workflow.sigintGraceful', ctx.lang));
      abortController.abort();
      return;
    }
    blankLine();
    error(getLabel('workflow.sigintForce', ctx.lang));
    process.exit(EXIT_SIGINT);
  };
  if (outputMode === 'terminal') {
    process.on('SIGINT', onSigInt);
  }
  let { sessionId } = ctx;

  try {
    const resolvedSystemPrompt = buildProviderRuntimeSystemPrompt(
      systemPrompt,
      ctx.lang,
      ctx.provider.getRuntimeInstructions(),
    );
    const agent = ctx.provider.setup({ name: ctx.personaName, systemPrompt: resolvedSystemPrompt });
    const hasImageAttachments = options.imageAttachments !== undefined && options.imageAttachments.length > 0;
    const nativeImageAttachments = ctx.provider.supportsNativeImageInput
      ? options.imageAttachments
      : undefined;
    const promptForProvider = ctx.provider.supportsNativeImageInput
      ? prompt
      : expandImageAttachmentPlaceholders(prompt, options.imageAttachments);
    if (hasImageAttachments && nativeImageAttachments === undefined) {
      info(`Provider "${ctx.providerType}" does not support native image input; image paths were added to the prompt.`);
    }
    const response = await agent.call(promptForProvider, {
      cwd,
      model: ctx.model,
      sessionId,
      allowedTools,
      permissionMode: options.permissionMode,
      providerOptions: ctx.providerOptions,
      abortSignal: abortController.signal,
      onStream: display?.createHandler(),
      imageAttachments: nativeImageAttachments,
    });
    display?.flush();
    const success = response.status !== 'blocked' && response.status !== 'error';

    if (!success && sessionId) {
      log.info('Session invalid, retrying without session');
      sessionId = undefined;
      const retryDisplay = outputMode === 'terminal'
        ? new StreamDisplay('assistant', isQuietMode())
        : undefined;
      const retryAgent = ctx.provider.setup({ name: ctx.personaName, systemPrompt: resolvedSystemPrompt });
      const retry = await retryAgent.call(promptForProvider, {
        cwd,
        model: ctx.model,
        sessionId: undefined,
        allowedTools,
        permissionMode: options.permissionMode,
        providerOptions: ctx.providerOptions,
        abortSignal: abortController.signal,
        onStream: retryDisplay?.createHandler(),
        imageAttachments: nativeImageAttachments,
      });
      retryDisplay?.flush();
      if (retry.sessionId) {
        sessionId = retry.sessionId;
        updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
      }
      return {
        result: { content: retry.content, sessionId: retry.sessionId, success: retry.status !== 'blocked' && retry.status !== 'error' },
        sessionId,
      };
    }

    if (response.sessionId) {
      sessionId = response.sessionId;
      updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
    }
    return {
      result: { content: response.content, sessionId: response.sessionId, success },
      sessionId,
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    log.error('AI call failed', { error: msg });
    if (outputMode === 'terminal') {
      error(msg);
      blankLine();
    }
    return { result: null, sessionId };
  } finally {
    options.abortSignal?.removeEventListener('abort', onExternalAbort);
    if (outputMode === 'terminal') {
      process.removeListener('SIGINT', onSigInt);
    }
  }
}
