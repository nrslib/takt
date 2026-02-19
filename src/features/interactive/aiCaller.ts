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
): Promise<{ result: CallAIResult | null; sessionId: string | undefined }> {
  const display = new StreamDisplay('assistant', isQuietMode());
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigInt = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      blankLine();
      info(getLabel('piece.sigintGraceful', ctx.lang));
      abortController.abort();
      return;
    }
    blankLine();
    error(getLabel('piece.sigintForce', ctx.lang));
    process.exit(EXIT_SIGINT);
  };
  process.on('SIGINT', onSigInt);
  let { sessionId } = ctx;

  try {
    const agent = ctx.provider.setup({ name: ctx.personaName, systemPrompt });
    const response = await agent.call(prompt, {
      cwd,
      model: ctx.model,
      sessionId,
      allowedTools,
      abortSignal: abortController.signal,
      onStream: display.createHandler(),
    });
    display.flush();
    const success = response.status !== 'blocked' && response.status !== 'error';

    if (!success && sessionId) {
      log.info('Session invalid, retrying without session');
      sessionId = undefined;
      const retryDisplay = new StreamDisplay('assistant', isQuietMode());
      const retryAgent = ctx.provider.setup({ name: ctx.personaName, systemPrompt });
      const retry = await retryAgent.call(prompt, {
        cwd,
        model: ctx.model,
        sessionId: undefined,
        allowedTools,
        abortSignal: abortController.signal,
        onStream: retryDisplay.createHandler(),
      });
      retryDisplay.flush();
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
    error(msg);
    blankLine();
    return { result: null, sessionId };
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}
