import { conversationId, conversationIdentity } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { ConversationDelivery, ConversationPort } from './conversationPort.js';

export function createTuiConversationPort(_configDirectory: string, delivery: ConversationDelivery): ConversationPort<ConversationAssignment> {
  return {
    delivery,
    async resolve(selected) {
      const assignment: ConversationAssignment = selected.kind === 'daemon' ? { kind: 'daemon' }
        : selected.kind === 'workspace' ? { kind: 'workspace', workspaceId: selected.workspaceId }
          : { kind: 'repository', repositoryDirectory: selected.repositoryDirectory };
      const actor = { namespace: 'local', id: 'operator' };
      return { conversationId: conversationId(assignment), assignment, speaker: actor,
        binding: { port: 'tui', key: JSON.stringify(conversationIdentity(assignment)), counterpart: actor } };
    },
  };
}
