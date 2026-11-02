import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conversationId, conversationIdentity } from '../infra/conversations/identity.js';
import { ConversationAssignmentSchema, ConversationRecordSchema, PendingMessagesSchema,
  MAX_PENDING_MESSAGES, MAX_PENDING_MESSAGES_BYTES } from '../infra/conversations/schema.js';
import { conversationRecord, directorConversationRecord } from './helpers/conversation-fixtures.js';

describe('conversation identity and schema', () => {
  it('derives identity from the complete repository path and keeps the same assignment stable', () => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: '/work/example' };
    expect(conversationIdentity(assignment)).toEqual(['manager', 'repository', '/work/example']);
    expect(conversationId(assignment)).toBe(`manager-${createHash('sha256').update('["manager","repository","/work/example"]').digest('hex')}`);
    expect(conversationId({ ...assignment })).toBe(conversationId(assignment));
    expect(conversationId({ ...assignment, repositoryDirectory: '/other/example' })).not.toBe(conversationId(assignment));
  });

  it('uses workspace identity independently of the repository audience', () => {
    const assignment = { kind: 'workspace' as const, workspaceId: '11111111-1111-4111-8111-111111111111' };
    expect(conversationIdentity(assignment)).toEqual(['manager', 'workspace', assignment.workspaceId]);
    expect(conversationId(assignment)).not.toBe(conversationId({ kind: 'repository', repositoryDirectory: '/work/example' }));
  });

  it('gives the daemon director a stable identity separate from repository and workspace managers', () => {
    const assignment = ConversationAssignmentSchema.parse({ kind: 'daemon' });
    const id = conversationId(assignment);

    expect(conversationId(ConversationAssignmentSchema.parse({ kind: 'daemon' }))).toBe(id);
    expect(id).not.toBe(conversationId({ kind: 'repository', repositoryDirectory: '/work/example' }));
    expect(id).not.toBe(conversationId({ kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111' }));
    expect(ConversationRecordSchema.parse(directorConversationRecord())).toMatchObject({ agent: 'director', assignment });
  });

  it('rejects a director agent attached to a repository manager identity', () => {
    expect(ConversationRecordSchema.safeParse({ ...conversationRecord('/work/example'), agent: 'director' }).success).toBe(false);
  });

  it('rejects a manager agent attached to the daemon director identity', () => {
    expect(ConversationRecordSchema.safeParse({ ...directorConversationRecord(), agent: 'manager' }).success).toBe(false);
  });

  it.each(['lastSpeaker', 'model', 'sessionId', 'pending', 'approval', 'running'] as const)('requires nullable field %s', (field) => {
    const value: Record<string, unknown> = { ...conversationRecord('/work/example') };
    delete value[field];
    expect(ConversationRecordSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { schemaVersion: 2 }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { id: `manager-${'0'.repeat(64)}` }, { message: 'あいことばキリン' },
    { pending: { ...conversationRecord('/work/example').pending, revision: 3 } },
  ])('rejects invalid persisted metadata %j', (invalid) => {
    expect(ConversationRecordSchema.safeParse({ ...conversationRecord('/work/example'), ...invalid }).success).toBe(false);
  });

  it('retains an opaque binding without interpreting its port or endpoint key', () => {
    const record = conversationRecord('/work/example');
    record.bindings = [{ port: 'opaque-port', key: 'not a URL; not a transport instruction', counterpart: record.counterpart }];
    expect(ConversationRecordSchema.parse(record)).toEqual(record);
  });

  it('requires the original pending input for an unresolved reservation', () => {
    const record = conversationRecord('/work/example');
    record.approval = { state: 'reserved', revision: 4, repositoryDirectory: '/work/example', goalId: '11111111-1111-4111-8111-111111111111' };
    expect(ConversationRecordSchema.parse(record)).toEqual(record);
    expect(ConversationRecordSchema.safeParse({ ...record, pending: null }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...record, approval: { ...record.approval, revision: 3 } }).success).toBe(false);
  });

  it('validates the director source and speaker in the shared waiting list', () => {
    const record = conversationRecord('/work/example');
    const message = { operationId: '00000000-0000-4000-8000-000000000001', text: 'request',
      speaker: { namespace: 'agent', id: 'director' }, directorConversationId: conversationId({ kind: 'daemon' }) };
    expect(ConversationRecordSchema.parse({ ...record, directorMessages: [message] }).directorMessages).toEqual([message]);
    expect(ConversationRecordSchema.safeParse({ ...record, directorMessages: [{ ...message, speaker: record.counterpart }] }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...record, directorMessages: [{ ...message, directorConversationId: record.id }] }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...directorConversationRecord(), directorMessages: [message] }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...record, directorMessages: [message, message] }).success).toBe(false);
  });

  it('accepts the pending message count limit and rejects one more without changing the input', () => {
    const record = conversationRecord('/work/example');
    const messages = Array.from({ length: MAX_PENDING_MESSAGES }, (_, index) => ({
      operationId: randomUUID(), text: `message ${index}`, speaker: record.counterpart,
    }));
    expect(PendingMessagesSchema.parse(messages)).toEqual(messages);
    expect(PendingMessagesSchema.safeParse([
      ...messages, { ...messages[0]!, operationId: randomUUID() },
    ]).success).toBe(false);
    expect(messages).toHaveLength(MAX_PENDING_MESSAGES);
  });

  it.each(['a', 'あ', '\n'])('limits the complete pending JSON in UTF-8 bytes, including escaping (%j)', (unit) => {
    const record = conversationRecord('/work/example');
    const message = { operationId: randomUUID(), text: '', speaker: record.counterpart,
      agentOverrides: { provider: 'mock' as const, model: 'chosen' } };
    const budget = MAX_PENDING_MESSAGES_BYTES - Buffer.byteLength(JSON.stringify([message]), 'utf8');
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
    const text = unit.repeat(Math.floor(budget / unitBytes)) + 'a'.repeat(budget % unitBytes);
    const messages = [{ ...message, text }];
    expect(Buffer.byteLength(JSON.stringify(messages), 'utf8')).toBe(MAX_PENDING_MESSAGES_BYTES);
    expect(PendingMessagesSchema.safeParse(messages).success).toBe(true);
    expect(PendingMessagesSchema.safeParse([{ ...message, text: `${text}a` }]).success).toBe(false);
    expect(PendingMessagesSchema.safeParse([
      { ...message, text: 'short', agentOverrides: { model: 'a'.repeat(MAX_PENDING_MESSAGES_BYTES) } },
    ]).success).toBe(false);
  });

  it('retains previously accepted oversized queues for recovery while rejecting new admission', () => {
    const record = conversationRecord('/work/example');
    const messages = Array.from({ length: MAX_PENDING_MESSAGES + 1 }, () => ({
      operationId: randomUUID(), text: 'accepted before limits', speaker: record.counterpart,
    }));
    expect(PendingMessagesSchema.safeParse(messages).success).toBe(false);
    expect(ConversationRecordSchema.parse({ ...record, directorMessages: messages }).directorMessages).toEqual(messages);
  });

  it('requires an active director speaker and removes its operation ID from the waiting list on start', () => {
    const record = conversationRecord('/work/example');
    const message = { operationId: '00000000-0000-4000-8000-000000000001', text: 'request',
      speaker: { namespace: 'agent', id: 'director' }, directorConversationId: conversationId({ kind: 'daemon' }) };
    const running = { operationId: message.operationId, directorConversationId: message.directorConversationId,
      kind: 'message', owner: { pid: 1234, identity: { startTime: 'owner' } } };
    expect(ConversationRecordSchema.safeParse({ ...record, running }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...record, lastSpeaker: message.speaker, running, directorMessages: [message] }).success).toBe(false);
    expect(ConversationRecordSchema.parse({ ...record, lastSpeaker: message.speaker, running, directorMessages: [] }).pending).toEqual(record.pending);
  });

  it.each([conversationRecord('/work/example'), directorConversationRecord()])('persists human input and its execution options for $agent', (record) => {
    const message = { operationId: '00000000-0000-4000-8000-000000000001', text: 'human request',
      speaker: record.counterpart, agentOverrides: { provider: 'mock', model: 'chosen' } };
    expect(ConversationRecordSchema.parse({ ...record, directorMessages: [message] }).directorMessages).toEqual([message]);
    expect(ConversationRecordSchema.safeParse({ ...record, directorMessages: [message, message] }).success).toBe(false);
    expect(ConversationRecordSchema.safeParse({ ...record, directorMessages: [{ ...message, agentOverrides: { provider: 'unknown' } }] }).success).toBe(false);
  });
});
