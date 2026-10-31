import { Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSlashCompletion } from '../features/tui/useSlashCompletion.js';
import { resolveSlashCompletions } from '../features/tui/slashCompletion.js';
import { getLabel } from '../shared/i18n/index.js';

afterEach(cleanup);

function mountCompletion() {
  const complete = vi.fn();
  const unhandled = vi.fn();
  function Probe() {
    const [draft, setDraft] = useState('/');
    const completion = useSlashCompletion(resolveSlashCompletions(draft, 'en', {}));
    useInput((input, key) => {
      if (input === 'e') {
        setDraft('/re');
        completion.reset();
      } else if (!completion.handleInput(key, complete)) unhandled(input);
    });
    return createElement(Text, {}, completion.completions.map((item, index) =>
      (index === completion.completionIndex ? '*' : '') + item.command).join('|'));
  }
  return { app: render(createElement(Probe)), complete, unhandled };
}

it('cycles candidates in both directions and fills the selected command with a trailing space', async () => {
  const { app, complete, unhandled } = mountCompletion();
  await vi.waitFor(() => expect(app.lastFrame()).toContain('*/accept'));
  app.stdin.write('\x1b[A');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('*/paste-image'));
  app.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('*/accept'));
  app.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('*/go'));
  app.stdin.write('\t');
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith('/go '));
  expect(unhandled).not.toHaveBeenCalled();
});

it('hides on Esc, lets the next Esc reach the caller, and resets selection when editing', async () => {
  const { app, unhandled, complete } = mountCompletion();
  await vi.waitFor(() => expect(app.lastFrame()).toContain('/accept'));
  app.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('*/go'));
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).toBe(''));
  expect(unhandled).not.toHaveBeenCalled();
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(unhandled).toHaveBeenCalledOnce());
  app.stdin.write('e');
  await vi.waitFor(() => expect(app.lastFrame()).toBe('*/resume'));
  app.stdin.write('\t');
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith('/resume '));
});

it.each(['ja', 'en'] as const)('resolves only the supplied manager command and its translated description in %s', (lang) => {
  const definitions = [{ command: '/make-goal', labelKey: 'manager.makeGoalDescription' }];
  for (const draft of ['/', '/ma', '/make-goal']) {
    expect(resolveSlashCompletions(draft, lang, {}, definitions)).toEqual([
      { command: '/make-goal', description: getLabel('manager.makeGoalDescription', lang) },
    ]);
  }
  for (const draft of ['/xyz', 'hello', 'hello /make-goal', '/make-goal ']) {
    expect(resolveSlashCompletions(draft, lang, {}, definitions)).toEqual([]);
  }
});
