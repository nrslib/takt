import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { conversationId, conversationIdentity } from '../../infra/conversations/identity.js';
import { resolveCurrentManagerAssignment } from './assignment.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { ConversationDelivery, ConversationPort } from './conversationPort.js';

export function createTuiConversationPort(configDirectory: string, delivery: ConversationDelivery): ConversationPort<ConversationAssignment> {
  return {
    delivery,
    async resolve(selected) {
      const requested = selected.kind === 'repository'
        ? { kind: 'repository' as const, repositoryDirectory: await resolveGitRepositoryDirectory(selected.repositoryDirectory) } : selected;
      const current = await resolveCurrentManagerAssignment(requested, configDirectory);
      const assignment: ConversationAssignment = current.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: current.workspaceId }
        : { kind: 'repository', repositoryDirectory: current.repositoryDirectory };
      const actor = { namespace: 'local', id: 'operator' };
      return { conversationId: conversationId(assignment), assignment, speaker: actor,
        binding: { port: 'tui', key: JSON.stringify(conversationIdentity(assignment)), counterpart: actor } };
    },
  };
}
