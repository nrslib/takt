import { randomUUID } from 'node:crypto';
import type { DaemonBus } from '../../core/daemon/ports.js';
import type { TurnIdentity } from '../../core/daemon/messages.js';
import type { DirectorMessageOrigin } from '../../infra/conversations/schema.js';

export async function tellDirectorManager(context: { bus: Pick<DaemonBus, 'request'>; turn: TurnIdentity },
  managerId: string, text: string, origin: DirectorMessageOrigin, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = randomUUID();
  const reply = await context.bus.request(context.turn, { kind: 'accept_director_message', eventId: id,
    requestId: id, conversationId: managerId, occurredAt: new Date().toISOString(), text, origin }, signal);
  if (reply.kind === 'error') return reply;
  if (reply.kind !== 'event_accepted') throw new Error('Unexpected director message response');
  return reply.admission.kind === 'accepted' ? { ...reply.admission, managerId } : reply.admission;
}
