import { expect, it } from 'vitest';
import { assertDirectorManagerHumanMessage } from '../core/daemon/directorAuthorization.js';

it('accepts a human message turn', () => {
  expect(() => assertDirectorManagerHumanMessage({ kind: 'human_command', command: { kind: 'message', text: 'manager を用意して' },
    speaker: { namespace: 'test', id: 'operator' } })).not.toThrow();
});

it('rejects non-message human commands and watcher events', () => {
  expect(() => assertDirectorManagerHumanMessage({ kind: 'human_command', command: { kind: 'dismiss_summary', revision: 1 },
    speaker: { namespace: 'test', id: 'operator' } })).toThrow();
  expect(() => assertDirectorManagerHumanMessage({ kind: 'watch_observation', observation: { kind: 'watch_failed', reason: '/work/blog',
    targetId: 'watch', generation: '1', observedAt: '2026-11-24T00:00:00Z' } })).toThrow();
});
