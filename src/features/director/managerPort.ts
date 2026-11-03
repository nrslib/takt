import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { conversationId, conversationIdentity } from '../../infra/conversations/identity.js';
import type { ConversationDelivery, ConversationPort } from '../manager/conversationPort.js';
import { resolveDirectorManager } from './managers.js';

export function createDirectorManagerPort(configDirectory: string, delivery: ConversationDelivery): ConversationPort<ConversationAssignment> {
  return { delivery, async resolve(selected) {
    if (selected.kind === 'daemon') throw new Error('Director cannot address itself through a manager port');
    const manager = await resolveDirectorManager(configDirectory, conversationId(selected));
    const assignment: ConversationAssignment = manager.kind === 'workspace'
      ? { kind: 'workspace', workspaceId: manager.workspaceId }
      : { kind: 'repository', repositoryDirectory: manager.repositoryDirectory };
    const actor = { namespace: 'agent', id: 'director' };
    return { conversationId: conversationId(assignment), assignment, speaker: actor,
      binding: { port: 'director', key: JSON.stringify(conversationIdentity(assignment)), counterpart: { namespace: 'local', id: 'operator' } } };
  } };
}
