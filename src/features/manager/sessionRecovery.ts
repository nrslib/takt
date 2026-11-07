import type { ProviderAgent, ProviderCallOptions } from '../../infra/providers/types.js';
import { createAgentFailureError, isAgentFailureError } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/error.js';

export async function callWithManagerSessionRecovery(
  agent: ProviderAgent,
  prompts: { resume: string; fresh: string },
  options: ProviderCallOptions,
  invalidateSession: (() => Promise<void>) | undefined,
) {
  let sessionId = options.sessionId;
  let usedTools = false;
  const call = async (prompt: string) => {
    options.abortSignal?.throwIfAborted();
    const response = await agent.call(prompt, {
      ...options, sessionId,
      onStream: (event) => {
        if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'tool_output') usedTools = true;
        options.onStream?.(event);
      },
    });
    if (response.status !== 'done') {
      if (response.failureCategory !== undefined) throw createAgentFailureError(response.failureCategory, response.error ?? 'Manager provider failed');
      throw new Error(response.error ?? 'Manager provider failed');
    }
    return { ...response, sessionId: response.sessionId ?? sessionId };
  };
  try {
    return await call(sessionId === undefined ? prompts.fresh : prompts.resume);
  } catch (error) {
    const rejectedResume = sessionId !== undefined && isAgentFailureError(error)
      && error.failureCategory === 'session_continuation_unsupported';
    if (rejectedResume) {
      sessionId = undefined;
      await invalidateSession?.();
    }
    if (usedTools || options.abortSignal?.aborted || (!rejectedResume && !/prompt is too long/i.test(getErrorMessage(error)))) throw error;
    sessionId = undefined;
    if (!rejectedResume) await invalidateSession?.();
    // Both recovery causes share this single retry; tool side effects are never replayed.
    return call(prompts.fresh);
  }
}
