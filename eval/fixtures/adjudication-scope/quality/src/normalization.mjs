export function normalizeDelivery(raw) {
  return {
    recipient: raw.recipient.trim().toLowerCase(),
    subject: raw.subject.trim(),
    retries: Math.max(0, Math.trunc(raw.retries)),
  };
}
