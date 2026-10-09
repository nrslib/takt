export function receive(event, expectedSignature, seen) {
  if (typeof event.signature !== 'string' || event.signature.length === 0
    || typeof expectedSignature !== 'string' || expectedSignature.length === 0
    || event.signature !== expectedSignature) throw new Error('invalid signature');
  if (seen.has(event.id)) return { accepted: true, duplicate: true };
  if (!['paid', 'refunded'].includes(event.type)) throw new Error('unsupported event');
  seen.add(event.id);
  return { accepted: true, duplicate: false, status: event.type };
}
