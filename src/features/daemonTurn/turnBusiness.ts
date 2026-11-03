import { createHash, randomUUID } from 'node:crypto';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import { retirePendingPatrols } from './retirePatrols.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { TurnStart } from '../../core/daemon/messages.js';
import type { TurnBusiness, TurnIo } from './processRuntime.js';
import { createDaemonConversationRuntime } from '../director/conversationRuntime.js';
import { createConversationTurnService } from '../manager/conversationService.js';
import { prepareSharedServerPoolForForcedShutdown } from '../../infra/opencode/server-pool.js';

export async function createTurnBusiness(configDirectory: string, assignment: ConversationAssignment): Promise<TurnBusiness> {
  if (assignment.kind !== 'daemon') {
    const currentAssignment = await resolveCurrentManagerAssignment(assignment, configDirectory);
    for (const directory of currentAssignment.repositoryDirectories) retirePendingPatrols(directory);
  }
  let current: { input: TurnStart; io: TurnIo } | undefined;
  const runtime = createDaemonConversationRuntime(configDirectory, {
    async tellManager(managerId, text) {
      if (current === undefined || current.input.state.assignment.kind !== 'daemon') throw new Error('Director turn required');
      const reply = await current.io.request({ kind: 'get_delivery', conversationId: managerId });
      if (reply.kind !== 'delivery' || reply.conversationId !== managerId || reply.assignment.kind === 'daemon'
        || conversationId(reply.assignment) !== managerId) throw new Error('Unknown manager delivery');
      const id = randomUUID();
      const accepted = await current.io.request({ kind: 'accept_director_message', eventId: id, requestId: id,
        conversationId: managerId, occurredAt: new Date().toISOString(), text });
      if (accepted.kind !== 'event_accepted') throw new Error('Director message was not accepted');
      return accepted.admission.kind === 'accepted'
        ? { ...accepted.admission, managerId } : accepted.admission;
    },
    async notifyHuman(message, subject) {
      if (current === undefined) throw new Error('Active turn required');
      const notificationId = randomUUID();
      const reply = await current.io.request({ kind: 'notify_director', notificationId, message,
        ...(subject === undefined ? {} : { subject: { ...subject, key: createHash('sha256').update(subject.key).digest('hex') } }) });
      if (reply.kind !== 'notification_saved') throw new Error('Director notification was not saved');
      return { id: reply.notificationId, message };
    },
  });
  const service = createConversationTurnService(configDirectory, runtime);
  return {
    async execute(input, io) {
      current = { input, io };
      try { return await service.execute(input, io); }
      finally { current = undefined; }
    },
    async close() {
      try { await runtime.close(); }
      finally { await prepareSharedServerPoolForForcedShutdown(); }
    },
  };
}

