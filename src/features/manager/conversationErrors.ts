import { getLabel } from '../../shared/i18n/index.js';
import { GoalRegistrationRecoveryError } from '../../infra/goals/service.js';

export type ConversationErrorCode = 'busy' | 'stale_summary' | 'invalid_assignment' | 'unavailable_attachment'
  | 'registration_recovery' | 'storage_error' | 'shutting_down' | 'invalid_input' | 'operation_failed';

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode) { super(code); }
}

export function conversationErrorResult(error: unknown, language: 'ja' | 'en') {
  const code = error instanceof ConversationError ? error.code
    : error instanceof GoalRegistrationRecoveryError ? 'registration_recovery' : 'operation_failed';
  return { kind: 'error' as const, code, message: getLabel(`manager.conversation.${code}`, language) };
}
