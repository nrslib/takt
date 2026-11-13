import { describe, expect, it, vi } from 'vitest';
import type { DaemonIngress } from '../core/daemon/ports.js';
import { EpicSnapshotSchema } from '../infra/epics/projection.js';
import { epicEventId, epicEvents, publishEpicEvents } from '../features/daemon/epicEvents.js';
import { beginEpicVerification, applyEpicVerificationResult, finishEpic, epicView, reviseEpic } from '../infra/epics/state.js';
import { epicRecord, verificationRunId, verificationStartedAt, verificationResultFor, secondGoalId } from './helpers/epic-fixtures.js';
import { epicResult } from '../features/mcp/epicResponse.js';
import { epicSchemas } from '../features/mcp/epicSchemas.js';
import { responseBytes, MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
import { PatrolEventSchema } from '../core/daemon/epicEvent.js';

function started() {
  const member = { repositoryDirectory: '/repositories/api', goalId: secondGoalId };
  return beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
}

describe('Epic event projection', () => {
  it('emits no success for running or stale verification and keeps completion explicit', () => {
    const { epic, run } = started();
    expect(epicEvents(epic)).toEqual([]);
    const verified = applyEpicVerificationResult(epic, verificationResultFor(run));
    expect(epicEvents(verified).map(({ event }) => event.kind)).toEqual(['epic_verification_result']);
    const completed = finishEpic(verified);
    expect(epicEvents(completed).map(({ event }) => event.kind)).toEqual(['epic_verification_result', 'epic_completed']);
    const revised = reviseEpic(verified, { objective: 'changed' }, { kind: 'definition', reason: 'changed', recordedAt: verificationStartedAt });
    expect(epicEvents(revised)).toEqual([]);
  });

  it('includes kind, workspace, Epic, revision and run in durable event identity', () => {
    const { epic, run } = started();
    const event = epicEvents(finishEpic(applyEpicVerificationResult(epic, verificationResultFor(run))))[0]!.event;
    if (event.kind !== 'epic_verification_result') throw new Error('Expected verification event');
    const id = epicEventId(event);
    for (const changes of [{ kind: 'epic_completed' as const }, { workspaceId: secondGoalId }, { epicId: secondGoalId }, { revision: 2 }, { runId: secondGoalId }]) {
      expect(epicEventId({ ...event, ...changes })).not.toBe(id);
    }
    expect(epicEventId({ ...event, operation: { reason: 'retry' } })).toBe(id);
  });

  it('publishes stable events with the operation reason and reports admission failure', async () => {
    const { epic, run } = started();
    const verified = applyEpicVerificationResult(epic, verificationResultFor(run));
    const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId,
      operationId: event.eventId, acceptedSequence: 1 }));
    await publishEpicEvents(verified, { accept }, '確認結果を登録した');
    expect(accept.mock.calls[0]![0]).toMatchObject({ event: { operation: { reason: '確認結果を登録した' } } });
    accept.mockResolvedValue({ kind: 'rejected', reason: 'storage' });
    await expect(publishEpicEvents(verified, { accept })).rejects.toThrow('storage');
  });

  it('validates derived evidence and recovery against the saved run', () => {
    const { epic, run } = started();
    const item = { kind: 'epic', epic: epicView(epic), memberProgress: [], recovery: [run] };
    expect(EpicSnapshotSchema.safeParse(item).success).toBe(true);
    expect(EpicSnapshotSchema.safeParse({ ...item, recovery: [] }).success).toBe(false);
    expect(EpicSnapshotSchema.safeParse({ ...item, epic: { ...item.epic, currentEvidence: run } }).success).toBe(false);
  });
});

describe('Epic MCP response and input', () => {
  it('bounds escaped content and provides byte offsets for saved fields and list continuation', () => {
    const value = { objective: '\u0000日本語'.repeat(50_000) };
    expect(responseBytes(epicResult(value, {}))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    const response = epicResult(value, { path: 'objective', textOffset: 0, maxBytes: 13 });
    const content = response.content[0];
    if (content?.type !== 'text') throw new Error('Expected text');
    expect(JSON.parse(content.text)).toMatchObject({ totalBytes: Buffer.byteLength(value.objective), truncated: true, nextOffset: expect.any(Number) });
    expect(() => epicResult(value, { path: '__proto__' })).toThrow();
    const page = epicResult([epicRecord(), epicRecord()], { offset: 1, limit: 1 });
    if (page.content[0]?.type !== 'text') throw new Error('Expected text');
    expect(JSON.parse(page.content[0].text)).toMatchObject({ offset: 1, returnedCount: 1, nextOffset: null });
  });

  it('requires reasons for mutations and refuses a caller-selected workspace', () => {
    expect(epicSchemas.takt_complete_epic.safeParse({ cwd: '/repo', epicId: epicRecord().id }).success).toBe(false);
    expect(epicSchemas.takt_list_epics.safeParse({ cwd: '/repo', workspaceId: secondGoalId }).success).toBe(false);
    expect(PatrolEventSchema.safeParse({ kind: 'patrol', goalIds: [], workspaceId: epicRecord().workspaceId, epicIds: [epicRecord().id] }).success).toBe(true);
    expect(PatrolEventSchema.safeParse({ kind: 'patrol', goalIds: [] }).success).toBe(false);
  });
});
