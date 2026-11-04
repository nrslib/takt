import { randomUUID } from 'node:crypto';
import type { TurnStart } from '../../core/daemon/messages.js';
import { conversationId } from '../../infra/conversations/identity.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function turnStart(generation = 1): TurnStart {
  const assignment = { kind: 'repository' as const, repositoryDirectory: '/repository' };
  const id = conversationId(assignment);
  const operationId = randomUUID();
  return { turn: { conversationId: id, operationId, generation },
    event: { eventId: randomUUID(), requestId: randomUUID(), conversationId: id, source: 'tui',
      occurredAt: '2026-11-03T00:00:00.000Z', operationId, acceptedSequence: generation, lane: 'human',
      event: { kind: 'human_command', command: { kind: 'message', text: 'message' }, speaker: { namespace: 'human', id: 'test' } } },
    state: { version: 0, assignment, session: { provider: 'mock', model: null, sessionId: 'shared-session' },
      revision: 1, pending: null, approval: null },
  };
}
