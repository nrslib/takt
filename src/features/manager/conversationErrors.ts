import { getLabel } from '../../shared/i18n/index.js';

export type ConversationErrorCode = 'queue_full' | 'message_too_large' | 'stale_summary' | 'invalid_assignment' | 'unavailable_attachment'
  | 'registration_recovery' | 'storage_error' | 'shutting_down' | 'invalid_input' | 'operation_failed';

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode) { super(code); }
}

export function conversationErrorResult(error: unknown, language: 'ja' | 'en') {
  const code = error instanceof ConversationError ? error.code
    : error instanceof Error && 'code' in error && error.code === 'registration_recovery' ? 'registration_recovery' : 'operation_failed';
  return { kind: 'error' as const, code, message: getLabel(`manager.conversation.${code}`, language) };
}
