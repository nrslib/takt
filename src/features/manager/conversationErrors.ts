import { getLabel } from '../../shared/i18n/index.js';
import { normalizeErrorReason } from '../../shared/utils/errorReason.js';

export type ConversationErrorCode = 'queue_full' | 'message_too_large' | 'stale_summary' | 'invalid_assignment' | 'unavailable_attachment'
  | 'registration_recovery' | 'storage_error' | 'shutting_down' | 'invalid_input' | 'operation_failed';

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode) { super(code); }
}

export function conversationErrorResult(error: unknown, language: 'ja' | 'en') {
  const code = error instanceof ConversationError ? error.code
    : error instanceof Error && 'code' in error && error.code === 'registration_recovery' ? 'registration_recovery' : 'operation_failed';
  if (code !== 'operation_failed' || error instanceof ConversationError) {
    return { kind: 'error' as const, code, message: getLabel(`manager.conversation.${code}`, language) };
  }
  const reason = normalizeErrorReason(error);
  const key = reason.length > 0 ? 'operation_failed_with_reason' : code;
  return { kind: 'error' as const, code, message: getLabel(`manager.conversation.${key}`, language, { reason }) };
}
