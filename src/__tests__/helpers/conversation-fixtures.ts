import { conversationId, conversationIdentity } from '../../infra/conversations/identity.js';
import type { ConversationRecord } from '../../infra/conversations/schema.js';

export function conversationRecord(repositoryDirectory: string): ConversationRecord {
  const assignment = { kind: 'repository' as const, repositoryDirectory };
  const actor = { namespace: 'local', id: 'operator' };
  return { schemaVersion: 1, id: conversationId(assignment), agent: 'manager', assignment,
    counterpart: actor, lastSpeaker: actor, provider: 'mock', model: null, sessionId: 'provider-session',
    bindings: [{ port: 'tui', key: JSON.stringify(conversationIdentity(assignment)), counterpart: actor }],
    revision: 4, pending: { revision: 4, repositoryDirectory, summary: {
      objective: 'CSV出力', outOfScope: [], acceptanceCriteria: ['出力できる'], constraints: [],
    } }, approval: null, running: null };
}
