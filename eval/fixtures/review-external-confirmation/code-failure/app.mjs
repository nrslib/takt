export function receive(event, expectedSignature, seen) {
  if (event.signature !== expectedSignature) throw new Error('invalid signature');
  if (seen.has(event.id)) return { accepted: true, duplicate: true };
  if (!['paid'].includes(event.type)) throw new Error('unsupported event');
  seen.add(event.id);
  return { accepted: true, duplicate: false, status: event.type };
}
