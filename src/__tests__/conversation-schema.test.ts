import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conversationId, conversationIdentity } from '../infra/conversations/identity.js';
import { ConversationAssignmentSchema, ConversationRecordSchema } from '../infra/conversations/schema.js';
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
});
