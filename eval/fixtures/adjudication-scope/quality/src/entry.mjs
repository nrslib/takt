import { normalizeDelivery } from './normalization.mjs';

export const publish = raw => ({ delivery: normalizeDelivery(raw), status: 'published' });

export function preview(raw) {
  const delivery = {
    recipient: raw.recipient.trim().toLowerCase(),
    subject: raw.subject.trim(),
    retries: Math.max(0, Math.trunc(raw.retries)),
  };
  return { delivery, status: 'preview' };
}
