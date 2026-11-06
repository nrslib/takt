import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AcceptedEvent } from '../core/daemon/events.js';
import { AcceptedEventSchema } from '../infra/daemon/eventRecord.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { writePrivateFile } from '../infra/daemon/privateFile.js';
import { FileWatchRecords } from '../infra/daemon/watchRecords.js';

vi.mock('../infra/daemon/process.js', () => ({
  readProcessOwner: async (pid: number) => ({ pid, startTime: 'test-process-start' }),
  observeProcess: async (owner: { pid: number }) => owner.pid === process.pid ? { kind: 'alive', owner } : { kind: 'dead' },
}));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const task = { repositoryDirectory: '/repo', goalId: 'goal', taskName: 'task', runSlug: 'run' };
const retiredObservations = [
  { kind: 'run_too_long', task, startedAt: '2020-01-01T00:00:00Z' },
  { kind: 'run_step_repeated', task, workflow: 'root', step: 'review', stepIdentity: 'review', count: 100 },
  { kind: 'run_log_stalled', task, lastUpdatedAt: '2020-01-01T00:00:00Z' },
  { kind: 'inquiry_stalled', repositoryDirectory: '/repo', goalId: 'goal', questionId: 'question' },
  { kind: 'goal_stalled', repositoryDirectory: '/repo', goalId: 'goal', lastUpdatedAt: '2020-01-01T00:00:00Z' },
] as const;

function event(): AcceptedEvent {
  return { eventId: 'current', requestId: 'current', conversationId: 'manager', operationId: 'current',
    acceptedSequence: 1, lane: 'other', source: 'watcher', occurredAt: '2026-11-06T00:00:00Z',
    event: { kind: 'watch_observation', observation: { kind: 'run_launch_stalled', targetId: 'target', generation: 'generation',
      observedAt: '2026-11-06T00:00:00Z', repositoryDirectory: '/repo' } } };
}

it.each(retiredObservations)('skips stored $kind events and watch records without accepting new ones', async (observation) => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-retired-watch-'));
  directories.push(directory);
  const current = event();
  await new FileEventStore(directory).accept(current);
  const states = ['queued', 'running', 'settling', 'settled'] as const;
  for (const [index, state] of states.entries()) {
    const id = `retired-${state}`;
    const input = { ...current, eventId: id, requestId: id, operationId: id, acceptedSequence: index + 2,
      event: { kind: 'watch_observation', observation: { targetId: 'target', generation: 'generation',
        observedAt: current.occurredAt, ...observation } } };
    const watchInput = { eventId: id, requestId: id, conversationId: input.conversationId, source: input.source,
      occurredAt: input.occurredAt, event: input.event };
    const turn = { conversationId: input.conversationId, operationId: id, generation: 1 };
    const result = { ...turn, event: input, outcome: { kind: 'interrupted' } };
    const record = { state, event: input, ...(state === 'running' ? { turn } : {}),
      ...(state === 'settling' || state === 'settled' ? { result } : {}) };
    const key = createHash('sha256').update(id).digest('hex');
    await writePrivateFile(join(directory, 'daemon-events', `${key}.json`), JSON.stringify(record));
    await writePrivateFile(join(directory, 'daemon-watches', `${key}.json`), JSON.stringify({
      episode: 1, active: true, accepted: state !== 'queued', input: watchInput,
    }));
    expect(await new FileWatchRecords(directory).read(key)).toBeUndefined();
    expect(AcceptedEventSchema.safeParse(input).success).toBe(false);
  }
  const restarted = new FileEventStore(directory);
  const restored = await restarted.restore();
  const pending = [];
  for await (const record of restored.pending) pending.push(record);
  expect(pending).toEqual([{ state: 'queued', event: current }]);
  expect(restored.lastAcceptedSequence).toBe(5);
  expect(await restarted.hasGoalRegistration('/repo', 'goal')).toBe(false);
  expect(await restarted.accept({ ...current, eventId: 'next', requestId: 'next', operationId: 'next', acceptedSequence: 6 }))
    .toEqual({ kind: 'stored' });
  expect((await new FileEventStore(directory).restore()).lastAcceptedSequence).toBe(6);
});

it('still rejects unknown event kinds in storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-unknown-watch-'));
  directories.push(directory);
  const input = { ...event(), event: { kind: 'watch_observation', observation: { kind: 'unknown_observation' } } };
  const key = createHash('sha256').update(input.eventId).digest('hex');
  await writePrivateFile(join(directory, 'daemon-events', `${key}.json`), JSON.stringify({ state: 'queued', event: input }));
  await expect(new FileEventStore(directory).restore()).rejects.toThrow();
  await writePrivateFile(join(directory, 'daemon-watches', `${key}.json`), JSON.stringify({
    episode: 1, active: true, accepted: false, input,
  }));
  await expect(new FileWatchRecords(directory).read(key)).rejects.toThrow();
});
