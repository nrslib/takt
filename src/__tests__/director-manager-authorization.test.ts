import { expect, it } from 'vitest';
import { assertDirectorManagerHumanMessage } from '../core/daemon/directorAuthorization.js';
import { conversationId } from '../infra/conversations/identity.js';
import type { TurnEvent } from '../core/daemon/events.js';

const message = (text: string): TurnEvent => ({ kind: 'human_command', command: { kind: 'message', text },
  speaker: { namespace: 'test', id: 'operator' } });

it.each([
  ['/work/blog でやって', '/work/blog'],
  ['「/work/blog でやって」', '/work/blog'],
  ['"/work/blog" でやって', '/work/blog'],
  ['`/work/blog` でやって', '/work/blog'],
  ['/work/開発 作業 でやって', '/work/開発 作業'],
  ['"/work/開発 作業" でやって', '/work/開発 作業'],
  ['/work/blog', '/work/blog'],
  ['/work/a と /work/b でやって', '/work/b'],
  ['/work/app[1].git でやって', '/work/app[1].git'],
  ['Do this in /work/new-app.', '/work/new-app'],
  ['Do this in /work/new-app. Then prepare it.', '/work/new-app'],
  ['"Do this in /work/new-app."', '/work/new-app'],
  ['「Do this in /work/new-app.」', '/work/new-app'],
  ['Do this in /work/new-app.git.', '/work/new-app.git'],
])('accepts the supplied path in a human message: %s', (text, directory) => {
  expect(() => assertDirectorManagerHumanMessage(message(text), directory)).not.toThrow();
});

it.each([
  '問い合わせの状況を教えて',
  '/work/blog-other でやって',
  '/work/blog/nested でやって',
  '/other/work/blog でやって',
  '/work/blog.git でやって',
])('rejects a path not supplied by the human: %s', (text) => {
  expect(() => assertDirectorManagerHumanMessage(message(text), '/work/blog')).toThrow();
});

it('rejects a shorter path when the human supplies a .git path followed by a period', () => {
  expect(() => assertDirectorManagerHumanMessage(message('Do this in /work/new-app.git.'), '/work/new-app')).toThrow();
});

it.each([false, true])('authorizes batch paths independently when the second path has a .git suffix: %s', (hasSuffix) => {
  const event = message(`/work/a と /work/b${hasSuffix ? '.git' : ''}.`);
  expect(() => assertDirectorManagerHumanMessage(event, '/work/a')).not.toThrow();
  const authorizeSecond = () => assertDirectorManagerHumanMessage(event, '/work/b');
  if (hasSuffix) expect(authorizeSecond).toThrow();
  else expect(authorizeSecond).not.toThrow();
});

it('rejects non-message human commands and watcher events', () => {
  expect(() => assertDirectorManagerHumanMessage({ kind: 'human_command', command: { kind: 'dismiss_summary', revision: 1, conversationId: conversationId({ kind: 'daemon' }) },
    speaker: { namespace: 'test', id: 'operator' } }, '/work/blog')).toThrow();
  expect(() => assertDirectorManagerHumanMessage({ kind: 'watch_observation', observation: { kind: 'watch_failed', reason: '/work/blog',
    targetId: 'watch', generation: '1', observedAt: '2026-11-24T00:00:00Z' } }, '/work/blog')).toThrow();
});
