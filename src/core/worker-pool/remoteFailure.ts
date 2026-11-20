import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export function sanitizeRemoteFailureReason(workerName: string, reason: string, credentialValues: readonly string[]): string {
  const prefix = `Worker ${sanitizeSensitiveText(workerName, [])}: `;
  const hasWorker = reason.startsWith(prefix);
  const detail = hasWorker ? reason.slice(prefix.length) : reason;
  const authenticationFailure = hasWorker || /auth|credential|api.?key|401|403|token|sign.?in/i.test(detail);
  const sanitized = sanitizeSensitiveText(detail, credentialValues);
  return authenticationFailure ? prefix + sanitized : sanitized;
}
