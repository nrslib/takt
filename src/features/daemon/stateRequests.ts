import type { DaemonIngress, DaemonStateOwner } from '../../core/daemon/ports.js';
import type { DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { DaemonConversations } from './conversationState.js';

export function createDaemonStateRequests(options: {
  conversations: DaemonConversations;
  ingress: Pick<DaemonIngress, 'accept'>;
  connectedPorts(id: string): readonly string[];
}): DaemonStateOwner {
  const { conversations } = options;
  const forbidden = (): DaemonStateReply => ({ kind: 'error', code: 'forbidden', message: 'Conversation is outside the current assignment' });
  return { async handle(turn, request, signal) {
    signal.throwIfAborted();
    if (request.kind === 'save_conversation') return conversations.store.save(turn, request.change, signal);
    const source = await conversations.store.read(turn.conversationId);
    if (source?.state.assignment.kind !== 'daemon' || turn.conversationId !== conversationId({ kind: 'daemon' })) return forbidden();
    if (request.kind === 'notify_director') {
      const saved = await conversations.notifications.save({ id: request.notificationId, message: request.message, subject: request.subject }, signal);
      if (saved) conversations.send(turn.conversationId, { kind: 'notice', id: request.notificationId, message: request.message },
        { revision: source.state.revision, stateSequence: source.state.version, operationId: turn.operationId });
      return { kind: 'notification_saved', notificationId: request.notificationId };
    }
    const target = await conversations.store.read(request.conversationId);
    if (target === undefined || target.state.assignment.kind === 'daemon'
      || !await conversations.routing.permits(target.state.assignment, request.conversationId)) return forbidden();
    signal.throwIfAborted();
    if (request.kind === 'get_delivery') return { kind: 'delivery', conversationId: request.conversationId,
      assignment: target.state.assignment, connectedPorts: [...options.connectedPorts(request.conversationId)] };
    const admission = await options.ingress.accept({ eventId: request.eventId, requestId: request.requestId, conversationId: request.conversationId,
      occurredAt: request.occurredAt, source: 'director', event: { kind: 'director_message', directorConversationId: turn.conversationId, text: request.text } });
    return { kind: 'event_accepted', admission };
  } };
}
