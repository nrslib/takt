import { conversationId, conversationIdentity } from '../../infra/conversations/identity.js';
import { ConversationAssignmentSchema, ConversationRecordSchema, type ConversationRecord } from '../../infra/conversations/schema.js';

export function conversationRecord(repositoryDirectory: string): ConversationRecord & { assignment: { kind: 'repository'; repositoryDirectory: string } } {
  const assignment = { kind: 'repository' as const, repositoryDirectory };
  const actor = { namespace: 'local', id: 'operator' };
  return { schemaVersion: 1, id: conversationId(assignment), agent: 'manager', assignment,
    counterpart: actor, lastSpeaker: actor, provider: 'mock', model: null, sessionId: 'provider-session',
    bindings: [{ port: 'tui', key: JSON.stringify(conversationIdentity(assignment)), counterpart: actor }],
    revision: 4, pending: { revision: 4, repositoryDirectory, summary: {
      objective: 'CSV出力', outOfScope: [], acceptanceCriteria: ['出力できる'], constraints: [],
    } }, approval: null, running: null };
}

export function directorConversationRecord(): ConversationRecord {
  const assignment = ConversationAssignmentSchema.parse({ kind: 'daemon' });
  const actor = { namespace: 'local', id: 'operator' };
  return ConversationRecordSchema.parse({
    schemaVersion: 1, id: conversationId(assignment), agent: 'director', assignment,
    counterpart: actor, lastSpeaker: null, provider: 'mock', model: null, sessionId: null,
    bindings: [{ port: 'tui', key: JSON.stringify(conversationIdentity(assignment)), counterpart: actor }],
    revision: 0, pending: null, approval: null, running: null,
  });
}
