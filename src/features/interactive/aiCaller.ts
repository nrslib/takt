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
import type { InternalAgentIsolation, StreamCallback } from '../../shared/types/provider.js';
import type { PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import { expandImageAttachmentPlaceholders } from '../../infra/providers/imageAttachmentPrompt.js';
import { buildProviderRuntimeSystemPrompt } from '../../infra/providers/runtimeSystemPrompt.js';
import {
  providerSupportsAllowedTools,
  providerSupportsPermissionControls,
} from '../../infra/providers/provider-capabilities.js';

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
  permissionMode?: PermissionMode;
  /** Free-form per-call effort override selected in the interactive TUI. */
  effort?: string;
  /** Do not hide an invalid temporary override behind an automatic retry. */
  disableSessionRetry?: boolean;
}

interface CallAIWithRetryOptions {
  imageAttachments?: ImageAttachmentReference[];
  /** Receives what a terminal caller would have printed alongside the answer. */
  onNotice?: (message: string) => void;
  permissionMode?: PermissionMode;
  internalAgentIsolation?: InternalAgentIsolation;
  outputMode?: 'terminal' | 'silent';
  abortSignal?: AbortSignal;
  /**
   * Persist a returned session ID for later resume. Defaults to true.
   *
   * A predicate is evaluated once the provider has answered, so a caller whose
   * turn can be superseded — the TUI interrupts one and starts the next — can
   * refuse to write the session of a turn nobody is waiting for any more.
   */
  persistSession?: boolean | (() => boolean);
  /** Stream observer for callers that render the response themselves (`outputMode: 'silent'`). */
  onStream?: StreamCallback;
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
): Promise<{
  result: CallAIResult | null;
  sessionId: string | undefined;
  /**
   * Why there is no result. A terminal caller reads it off the screen, but a
   * silent one (the Ink TUI) has no screen to read — without this the failure
   * would reach the user as "the assistant returned no response".
   */
  error?: string;
}> {
  const outputMode = options.outputMode ?? 'terminal';
  const display = outputMode === 'terminal'
    ? new StreamDisplay('assistant', isQuietMode())
    : undefined;
  const resolveStreamHandler = (activeDisplay: StreamDisplay | undefined): StreamCallback | undefined =>
    activeDisplay === undefined ? options.onStream : activeDisplay.createHandler();
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
  const shouldPersistSession = (): boolean =>
    typeof options.persistSession === 'function'
      ? options.persistSession()
      : options.persistSession !== false;
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
    const allowedToolsForProvider = providerSupportsAllowedTools(ctx.providerType) === false
      ? undefined
      : allowedTools;
    // Per-call permissionMode is synthesized by the assistant strategy; a session-level mode is
    // resolved user configuration and must still reach the provider for explicit-constraint errors.
    const permissionModeForProvider = providerSupportsPermissionControls(ctx.providerType) === false
      ? ctx.permissionMode
      : options.permissionMode ?? ctx.permissionMode;
    // Only the terminal caller owns stdout; a silent caller (the Ink TUI) renders
    // its own frames and a stray write would corrupt them.
    if (hasImageAttachments && nativeImageAttachments === undefined) {
      // The image did not go to the provider as an image, and the user has to
      // know that. A terminal caller prints it; a silent one is handed the same
      // sentence to render its own way.
      const note = `Provider "${ctx.providerType}" does not support native image input; image paths were added to the prompt.`;
      if (outputMode === 'terminal') {
        info(note);
      } else {
        options.onNotice?.(note);
      }
    }
    const response = await agent.call(promptForProvider, {
      cwd,
      model: ctx.model,
      sessionId,
      ...(allowedToolsForProvider === undefined ? {} : { allowedTools: allowedToolsForProvider }),
      ...(permissionModeForProvider === undefined ? {} : { permissionMode: permissionModeForProvider }),
      ...(options.internalAgentIsolation === undefined
        ? {}
        : { internalAgentIsolation: options.internalAgentIsolation }),
      providerOptions: ctx.providerOptions,
      effort: ctx.effort,
      abortSignal: abortController.signal,
      onStream: resolveStreamHandler(display),
      imageAttachments: nativeImageAttachments,
    });
    display?.flush();
    const success = response.status !== 'blocked' && response.status !== 'error';

    if (!success && sessionId && ctx.effort === undefined && ctx.disableSessionRetry !== true) {
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
        ...(allowedToolsForProvider === undefined ? {} : { allowedTools: allowedToolsForProvider }),
        ...(permissionModeForProvider === undefined ? {} : { permissionMode: permissionModeForProvider }),
        ...(options.internalAgentIsolation === undefined
          ? {}
          : { internalAgentIsolation: options.internalAgentIsolation }),
        providerOptions: ctx.providerOptions,
        effort: ctx.effort,
        abortSignal: abortController.signal,
        onStream: resolveStreamHandler(retryDisplay),
        imageAttachments: nativeImageAttachments,
      });
      retryDisplay?.flush();
      if (retry.sessionId) {
        sessionId = retry.sessionId;
        if (shouldPersistSession()) {
          updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
        }
      }
      const retrySucceeded = retry.status !== 'blocked' && retry.status !== 'error';
      return {
        // A provider that fails puts its reason in `error`; the content of a
        // failed call is often empty, and reporting that empty string would hide
        // what went wrong.
        result: {
          content: retrySucceeded ? retry.content : (retry.error ?? retry.content),
          sessionId: retry.sessionId,
          success: retrySucceeded,
        },
        sessionId,
      };
    }

    if (response.sessionId) {
      sessionId = response.sessionId;
      if (shouldPersistSession()) {
        updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
      }
    }
    return {
      result: {
        content: success ? response.content : (response.error ?? response.content),
        sessionId: response.sessionId,
        success,
      },
      sessionId,
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    log.error('AI call failed', { error: msg });
    if (outputMode === 'terminal') {
      error(msg);
      blankLine();
    }
    return { result: null, sessionId, error: msg };
  } finally {
    options.abortSignal?.removeEventListener('abort', onExternalAbort);
    if (outputMode === 'terminal') {
      process.removeListener('SIGINT', onSigInt);
    }
  }
}
