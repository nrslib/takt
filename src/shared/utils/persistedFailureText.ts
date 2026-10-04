/**
 * Byte cap for any failure-derived text that gets persisted to disk and then
 * replayed into terminal output, retry prompts, or retry notes: TaskFailure.error
 * (tasks.yaml) and SessionState.errorMessage (session-state.json).
 *
 * Without a cap, an oversized upstream error (e.g. a provider dumping raw
 * stdout) is written once and then re-expands into every downstream sink on
 * every subsequent Retry/Requeue. Reuses the existing agent-failure message
 * cap so all failure-text sinks in the codebase share one bound.
 */
import { truncateUtf8PreservingMarker } from './text.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../types/agent-failure.js';

export const MAX_PERSISTED_FAILURE_ERROR_BYTES = MAX_AGENT_FAILURE_MESSAGE_BYTES;

/**
 * Truncate failure-derived text to MAX_PERSISTED_FAILURE_ERROR_BYTES, appending
 * a `[TRUNCATED: N bytes]` marker when truncation occurs. Idempotent: applying
 * it again to an already-bounded value (e.g. on the next tasks.yaml read/write
 * round-trip) does not grow the marker or re-truncate visible content.
 */
export function boundPersistedFailureText(text: string): string {
  return truncateUtf8PreservingMarker(text, MAX_PERSISTED_FAILURE_ERROR_BYTES);
}
