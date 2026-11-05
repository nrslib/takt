import { describe, expect, it } from 'vitest';
import { createTurnQueues } from '../features/daemon/turnQueues.js';
import type { AcceptedEvent } from '../core/daemon/events.js';

function event(id: number, lane: 'human' | 'other', conversationId: string): AcceptedEvent {
  return {
    eventId: String(id), requestId: String(id), operationId: String(id), acceptedSequence: id, lane,
    conversationId, occurredAt: '2026-11-03T00:00:00Z', source: 'daemon',
    event: lane === 'human'
      ? { kind: 'human_command', command: { kind: 'message', text: String(id) }, speaker: { namespace: 'test', id: 'person' } }
      : { kind: 'director_message', directorConversationId: 'director', text: String(id) },
  };
}

describe('daemon turn queues', () => {
  it('selects humans first and orders each lane by admission sequence', () => {
    const queue = createTurnQueues();
    for (const value of [event(4, 'human', 'a'), event(2, 'other', 'a'), event(3, 'human', 'a'), event(1, 'other', 'a')]) {
      queue.add(value); queue.confirm(value.eventId);
    }
    const selected: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = queue.peekNext(() => true)!;
      selected.push(next.eventId); queue.markStarted(next.eventId); queue.remove(next.eventId);
    }
    expect(selected).toEqual(['3', '4', '1', '2']);
    expect(queue.peekNext(() => true)).toBeUndefined();
  });

  it('does not let later persistence overtake the same conversation, but allows another human conversation', () => {
    const queue = createTurnQueues();
    for (const value of [event(1, 'human', 'a'), event(2, 'human', 'a'), event(3, 'human', 'b'), event(4, 'other', 'c')]) queue.add(value);
    for (const id of ['2', '3', '4']) queue.confirm(id);
    expect(queue.peekNext(() => true)?.eventId).toBe('3');
    queue.markStarted('3');
    expect(queue.peekNext(() => true)).toBeUndefined();
    queue.confirm('1');
    expect(queue.peekNext(() => true)?.eventId).toBe('1');
  });

  it('selects humans, ordinary events, then patrols while preserving order within each group', () => {
    const queue = createTurnQueues();
    for (const id of [5, 4, 3, 2, 1]) {
      const value = event(id, id === 4 ? 'human' : 'other', 'a');
      if (id === 1 || id === 3) value.event = { kind: 'patrol', repositoryDirectory: '/repo', goalIds: ['goal'] };
      queue.add(value); queue.confirm(value.eventId);
    }
    const selected: string[] = [];
    while (true) {
      const next = queue.peekNext(() => true);
      if (next === undefined) break;
      selected.push(next.eventId); queue.markStarted(next.eventId); queue.remove(next.eventId);
    }
    expect(selected).toEqual(['4', '2', '5', '1', '3']);
  });

  it.each(['saving', 'busy'] as const)('blocks patrols while an ordinary event is %s, including in another conversation', (state) => {
    const queue = createTurnQueues();
    queue.add({ ...event(1, 'other', 'free'), event: { kind: 'patrol', repositoryDirectory: '/repo', goalIds: ['goal'] } });
    queue.confirm('1');
    queue.add(event(2, 'other', 'busy'));
    if (state === 'busy') queue.confirm('2');
    expect(queue.peekNext((id) => id !== 'busy')).toBeUndefined();
    queue.confirm('2');
    expect(queue.peekNext(() => true)?.eventId).toBe('2');
    queue.remove('2');
    expect(queue.peekNext(() => true)?.eventId).toBe('1');
  });

  it('blocks other events while a human waits for a busy conversation', () => {
    const queue = createTurnQueues();
    for (const value of [event(1, 'human', 'busy'), event(2, 'other', 'free')]) { queue.add(value); queue.confirm(value.eventId); }
    expect(queue.peekNext((id) => id !== 'busy')).toBeUndefined();
    queue.remove('1');
    expect(queue.peekNext((id) => id !== 'busy')?.eventId).toBe('2');
  });

  it('holds deferred task results without blocking resume and releases only the matching goal and repository', () => {
    const queue = createTurnQueues();
    const tasks: AcceptedEvent[] = [1, 2, 3].map((id) => ({ ...event(id, 'other', 'a'), event: {
      kind: 'task_completed', task: { repositoryDirectory: id === 2 ? '/other' : '/repo', goalId: id === 3 ? 'other-goal' : 'goal', taskName: String(id) },
      result: { success: true, interrupted: false },
    } }));
    for (const task of tasks) {
      queue.add(task); queue.confirm(task.eventId); queue.markStarted(task.eventId); queue.defer(task.eventId);
    }
    const resumed: AcceptedEvent = { ...event(4, 'other', 'a'),
      event: { kind: 'goal_resumed', repositoryDirectory: '/repo', goalId: 'goal' } };
    queue.add(resumed); queue.confirm(resumed.eventId);
    expect(queue.peekNext(() => true)).toEqual(resumed);
    queue.remove(resumed.eventId);
    expect(queue.pending('a')).toEqual([]);
    queue.resumeGoal({ repositoryDirectory: '/repo', goalId: 'goal' });
    expect(queue.peekNext(() => true)).toEqual(tasks[0]);
    queue.remove('1');
    expect(queue.peekNext(() => true)).toBeUndefined();
    expect(queue.pending('a')).toEqual([]);
  });

  it('keeps waiting messages when only the active event is removed', () => {
    const queue = createTurnQueues();
    for (const value of [event(1, 'human', 'a'), event(2, 'human', 'a')]) { queue.add(value); queue.confirm(value.eventId); }
    queue.markStarted('1'); queue.remove('1');
    expect(queue.pending('a').map((item) => item.eventId)).toEqual(['2']);
  });
});
