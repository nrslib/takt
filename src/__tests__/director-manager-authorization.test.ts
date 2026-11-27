import { expect, it } from 'vitest';
import { assertDirectorManagerHumanMessage } from '../core/daemon/directorAuthorization.js';
import { conversationId } from '../infra/conversations/identity.js';
import type { TurnEvent } from '../core/daemon/events.js';

const message = (text: string): TurnEvent => ({ kind: 'human_command', command: { kind: 'message', text },
  speaker: { namespace: 'test', id: 'operator' } });

it.each(['/work/blog でやって', '前の発言で指定した場所を追加して'])('allows a repository selected in a human message turn: %s', (text) => {
  expect(() => assertDirectorManagerHumanMessage(message(text))).not.toThrow();
});

it('rejects non-message human commands and watcher events', () => {
  expect(() => assertDirectorManagerHumanMessage({ kind: 'human_command', command: { kind: 'dismiss_summary', revision: 1, conversationId: conversationId({ kind: 'daemon' }) },
    speaker: { namespace: 'test', id: 'operator' } })).toThrow();
  expect(() => assertDirectorManagerHumanMessage({ kind: 'watch_observation', observation: { kind: 'watch_failed', reason: '/work/blog',
    targetId: 'watch', generation: '1', observedAt: '2026-11-24T00:00:00Z' } })).toThrow();
});
