import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRecordSchema, serializeTaskRecord, type TaskRecord } from '../infra/task/schema.js';
import {
  buildClaimedTaskRecord, buildExceededTaskRecord, buildRetryTaskRecord, buildTerminalTaskRecord,
} from '../infra/task/taskRecordMutations.js';

const { identity } = vi.hoisted(() => ({ identity: vi.fn<() => { startTime: string } | undefined>(() => ({ startTime: 'new birth' })) }));
vi.mock('../infra/task/taskProcessIdentity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/taskProcessIdentity.js')>(),
  getSelfTaskProcessIdentity: identity,
}));
afterEach(() => { identity.mockReset().mockReturnValue({ startTime: 'new birth' }); });

function pending(): TaskRecord {
  return TaskRecordSchema.parse({
    name: 'owner-test', status: 'pending', content: 'run work',
    created_at: '2026-10-05T00:00:00.000Z', started_at: null, completed_at: null,
  });
}
function running(): TaskRecord {
  return { ...pending(), status: 'running', started_at: '2026-10-05T00:00:00.000Z',
    owner_pid: 12345, owner_start_time: 'old birth' };
}

describe('persisted ordinary task owner metadata', () => {
  it('round-trips the identity captured at claim through the task schema and serializer', () => {
    const claimed = buildClaimedTaskRecord(pending());
    const stored = TaskRecordSchema.parse(serializeTaskRecord(claimed));
    expect(stored).toMatchObject({ status: 'running', owner_pid: process.pid, owner_start_time: 'new birth' });
  });

  it('records an unknown birth when the owner inspector is unavailable', () => {
    identity.mockReturnValueOnce(undefined);
    expect(TaskRecordSchema.parse(buildClaimedTaskRecord(pending()))).toMatchObject({
      owner_pid: process.pid, owner_start_time: null,
    });
  });

  it('captures the new owner when retry starts running', () => {
    const retried = buildRetryTaskRecord(running(), 'running', { resumeSource: { resumeMode: 'retry' } });
    expect(retried).toMatchObject({ owner_pid: process.pid, owner_start_time: 'new birth' });
  });

  it('clears both owner fields when retry queues a task', () => {
    const retried = buildRetryTaskRecord(running(), 'pending', { resumeSource: { resumeMode: 'retry' } });
    expect(TaskRecordSchema.parse(retried)).toMatchObject({ owner_pid: null, owner_start_time: null });
  });

  it('clears the identity when a task becomes failed', () => {
    const failed = buildTerminalTaskRecord(running(), {
      status: 'failed', completed_at: '2026-10-05T01:00:00.000Z', owner_pid: null, failure: { error: 'interrupted' },
    });
    expect(TaskRecordSchema.parse(failed)).toMatchObject({ owner_pid: null, owner_start_time: null });
  });

  it('clears the identity when a task exceeds its iteration limit', () => {
    const exceeded = buildExceededTaskRecord(running(), { currentStep: 'implement', newMaxSteps: 10, currentIteration: 10 });
    expect(TaskRecordSchema.parse(exceeded)).toMatchObject({ status: 'exceeded', owner_pid: null, owner_start_time: null });
  });

  it.each([undefined, null])('accepts a live legacy or unknown owner identity %s', (owner_start_time) => {
    expect(TaskRecordSchema.parse({ ...running(), owner_start_time }).owner_start_time).toBe(owner_start_time);
  });

  it('rejects an identity without an owner PID', () => {
    expect(() => TaskRecordSchema.parse({ ...running(), owner_pid: null })).toThrow(/owner_start_time/);
  });

  it.each(['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const)('rejects a birth identity on a %s task', (status) => {
    expect(() => TaskRecordSchema.parse({
      ...running(), status, owner_pid: null,
      started_at: status === 'pending' ? null : '2026-10-05T00:00:00.000Z',
      completed_at: status === 'pending' ? null : '2026-10-05T01:00:00.000Z',
      ...(status === 'failed' ? { failure: { error: 'failed' } } : {}),
    })).toThrow(/owner_start_time/);
  });
});
