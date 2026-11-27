import type { ProviderAgent } from './types.js';

/** A recovery must never silently start another session when its resume ID is missing. */
export function resumeCompactedSession(persona: string, call: ProviderAgent['call']): NonNullable<ProviderAgent['recoverFromCompaction']> {
  return async (prompt, options) => {
    if (options.sessionId !== undefined) return call(prompt, options);
    const error = 'Cannot recover from compaction without a session ID';
    options.onStream?.({ type: 'result', data: { result: error, error, success: false, sessionId: '', failureCategory: 'provider_error' } });
    return { persona, status: 'error', content: error, error, failureCategory: 'provider_error', timestamp: new Date() };
  };
}
