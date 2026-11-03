import type { AcceptedEvent } from '../../core/daemon/events.js';
import type { TurnQueues } from '../../core/daemon/ports.js';

interface Entry {
  event: AcceptedEvent;
  state: 'saving' | 'queued' | 'running' | 'deferred';
}

export function createTurnQueues(): TurnQueues {
  const human: Entry[] = [];
  const other: Entry[] = [];
  const entries = () => [...human, ...other];
  const get = (eventId: string): Entry => {
    const entry = entries().find(({ event }) => event.eventId === eventId);
    if (entry === undefined) throw new Error(`Unknown queued event: ${eventId}`);
    return entry;
  };
  return {
    add(event) {
      if (entries().some((entry) => entry.event.eventId === event.eventId)) throw new Error(`Duplicate queued event: ${event.eventId}`);
      const lane = event.lane === 'human' ? human : other;
      lane.push({ event, state: 'saving' });
      lane.sort((a, b) => a.event.acceptedSequence - b.event.acceptedSequence);
    },
    confirm(eventId) { get(eventId).state = 'queued'; },
    peekNext(canStart) {
      // 保存中・実行不能の人の発言も、other に追い越させない。
      const waitingHumans = human.filter((entry) => entry.state !== 'running');
      const lane = waitingHumans.length > 0 ? waitingHumans : other.filter((entry) => entry.state === 'saving' || entry.state === 'queued');
      const blocked = new Set<string>();
      for (const { event, state } of lane) {
        if (blocked.has(event.conversationId)) continue;
        blocked.add(event.conversationId);
        if (state === 'queued' && canStart(event.conversationId)) return event;
      }
      return undefined;
    },
    markStarted(eventId) { get(eventId).state = 'running'; },
    defer(eventId) { get(eventId).state = 'deferred'; },
    resumeGoal(repositoryDirectory, goalId) {
      for (const entry of other) {
        const event = entry.event.event;
        if (entry.state === 'deferred' && (event.kind === 'task_completed' || event.kind === 'task_failed')
          && event.task.repositoryDirectory === repositoryDirectory && event.task.goalId === goalId) entry.state = 'queued';
      }
    },
    remove(eventId) {
      const entry = get(eventId);
      const lane = entry.event.lane === 'human' ? human : other;
      lane.splice(lane.indexOf(entry), 1);
    },
    pending(conversationId) {
      return entries().filter(({ event }) => event.conversationId === conversationId).map(({ event }) => event);
    },
  };
}
