import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToString } from 'ink';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptEntryView, TranscriptView } from '../features/tui/TranscriptEntryView.js';
import { formatTranscriptEntryOutput } from '../features/tui/transcriptOutput.js';
import type { OperationResult, PortOutput } from '../features/manager/conversationPort.js';
import type { SnapshotDisplayItem } from '../features/manager/snapshotChanges.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../features/tui/terminalColors.js';
import { stripAnsi } from '../shared/utils/text.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { approveSummary, cwd, DOWN, ENTER, ESC, ManagerClientDouble, mount, promptFrame, QUESTION_MENU, showProposal, typeAndSubmit, waitFor } from './helpers/manager-tui-fixtures.js';

vi.mock('../features/tui/TranscriptEntryView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/TranscriptEntryView.js')>();
  return { ...actual, TranscriptView: vi.fn((props: Parameters<typeof actual.TranscriptView>[0]) =>
    createElement(actual.TranscriptView, props)) };
});

const entries = () => vi.mocked(TranscriptView).mock.calls.at(-1)![0].entries;

describe.each(['ja', 'en'] as const)('manager view (%s)', (lang) => {
  it.each([
    { localAbort: false, reuseOperation: false }, { localAbort: true, reuseOperation: false },
    { localAbort: false, reuseOperation: true }, { localAbort: true, reuseOperation: true },
  ])('separates interrupted text from the next turn before its running state: local=$localAbort reuse=$reuseOperation', async ({ localAbort, reuseOperation }) => {
    const { app, client } = mount(lang);
    const first = { operationId: randomUUID(), generation: 1 };
    const next = { operationId: reuseOperation ? first.operationId : randomUUID(), generation: reuseOperation ? 2 : 1 };
    const state = { ...client.getSnapshot().state!, running: { ...first, kind: 'turn' } };
    client.change({ state });
    await waitFor(() => expect(app.lastFrame()).toMatch(/\b0s\b/u));
    if (localAbort) {
      app.stdin.write(ESC);
      await waitFor(() => expect(client.commands()).toEqual([
        { kind: 'abort_turn', operationId: first.operationId, generation: first.generation },
      ]));
    }
    client.change({ state: { ...state, running: null, interrupted: true } });
    const message = '次のターンを調べています。';
    client.output({ kind: 'turn_text', ...first, message });
    client.output({ kind: 'turn_text', ...next, message });
    await waitFor(() => expect(entries()).toEqual([{ role: 'assistant', content: message }]));
    client.change({ state: { ...state, running: { ...next, kind: 'turn' }, interrupted: false } });
    client.output({ kind: 'turn_text', ...first, message });
    client.change({ state: { ...state, running: null, interrupted: false } });
    client.output({ kind: 'turn_text', ...first, message });
    client.output({ kind: 'result', operationId: next.operationId, result: { kind: 'reply', message: '最終返答' } });
    await waitFor(() => expect(entries()).toEqual([
      { role: 'assistant', content: message }, { role: 'assistant', content: '最終返答' },
    ]));
  });

  it('uses the known turn start on attachment and resets the same operation when its generation changes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const client = new ManagerClientDouble();
    const operationId = randomUUID();
    const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1, startedAt: Date.now() - 65000 } };
    client.change({ state });
    const { app } = mount(lang, client);
    await waitFor(() => expect(app.lastFrame()).toMatch(/\b1m05s\b/u));
    vi.advanceTimersByTime(1000);
    client.change({ state: { ...state, running: { ...state.running } } });
    await waitFor(() => expect(app.lastFrame()).toMatch(/\b1m06s\b/u));
    client.output({ kind: 'running', state: { ...state, running: { ...state.running, generation: 2, startedAt: Date.now() } } });
    await waitFor(() => expect(app.lastFrame()).toMatch(/\b0s\b/u));
  });

  it.each([false, true])('handles text following the terminal state without displaying interrupted text=%s', async (interrupted) => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } };
    client.output({ kind: 'running', state });
    client.output({ kind: 'turn_text', operationId, generation: 1, message: '表示済みの文' });
    await waitFor(() => expect(entries()).toEqual([{ role: 'assistant', content: '表示済みの文' }]));
    client.output({ kind: 'pending', state: { ...state, running: null, interrupted } });
    client.output({ kind: 'turn_text', operationId, generation: 1, message: '終了直前の文' });
    client.output({ kind: 'result', operationId, result: interrupted
      ? { kind: 'error', code: 'interrupted', message: 'Turn interrupted' } : { kind: 'reply', message: '最終返答' } });
    await waitFor(() => expect(app.lastFrame()).toContain(interrupted ? 'Turn interrupted' : '最終返答'));
    expect(entries().filter((entry) => entry.role === 'assistant')).toEqual(interrupted
      ? [{ role: 'assistant', content: '表示済みの文' }]
      : [{ role: 'assistant', content: '表示済みの文' }, { role: 'assistant', content: '終了直前の文' }, { role: 'assistant', content: '最終返答' }]);
  });

  it.each([
    { tool: 'Bash', description: '予定のコードを読む', expected: '予定のコードを読む' },
    { tool: 'Bash', expected: 'Bash' },
    { tool: 'Read', expected: 'Read' },
    { tool: 'mcp__takt_mgr_0123456789abcdef0123456789abcdef__takt_get_goal', expected: 'mcp__takt_mgr_0123456789abcdef0123456789abcdef__takt_get_goal' },
  ])('shows the tool description or name in the running status: $expected', async ({ tool, description, expected }) => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } } });
    const activity = { kind: 'tool' as const, tool, ...(description === undefined ? {} : { description }) };
    client.output({ kind: 'activity', operationId, generation: 1, activity });
    await waitFor(() => expect(app.lastFrame()).toContain(expected));
    expect(entries()).toEqual([]);
  });

  it('redacts sensitive values in tool descriptions shown in the running status', async () => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } } });
    client.output({ kind: 'activity', operationId, generation: 1,
      activity: { kind: 'tool', tool: 'Bash', description: 'Inspect sk-abcdefgh1234' } });
    await waitFor(() => expect(app.lastFrame()).toContain('[REDACTED]'));
    expect(app.lastFrame()).not.toContain('sk-abcdefgh1234');
  });

  it('advances elapsed time on the same screen across activity and refresh updates and resets it for the next turn', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } };
    const row = () => app.lastFrame()!.split('\n').find((line) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u.test(line));
    client.output({ kind: 'running', state });
    await waitFor(() => expect(row()).toMatch(/\b0s\b/u));
    vi.advanceTimersByTime(1000);
    await waitFor(() => expect(row()).toMatch(/\b1s\b/u));
    client.output({ kind: 'activity', operationId, generation: 1, activity: { kind: 'tool', tool: 'Bash' } });
    client.change({ state: { ...state, running: { ...state.running } } });
    await waitFor(() => expect(row()).toContain('Bash'));
    expect(row()).toMatch(/\b1s\b/u);
    vi.advanceTimersByTime(64000);
    await waitFor(() => expect(row()).toMatch(/\b1m05s\b/u));
    client.output({ kind: 'pending', state: { ...state, running: null } });
    await waitFor(() => expect(row()).toBeUndefined());
    client.output({ kind: 'running', state: { ...state, running: { operationId: randomUUID(), kind: 'turn', generation: 2 } } });
    await waitFor(() => expect(row()).toMatch(/\b0s\b/u));
  });

  it.each([
    { tool: 'Bash', description: '予定のコードを読む'.repeat(32).slice(0, 256), prefix: '予定のコードを読む' },
    { tool: 'mcp__takt_mgr_0123456789abcdef0123456789abcdef__takt_list_standalone_inquiries', prefix: 'mcp__takt_mgr_' },
  ])('keeps elapsed time intact at width 80 while truncating the long tool label: $tool', async ({ tool, description, prefix }) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] });
    const { app, client } = mount(lang);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: 80 });
    app.stdout.emit('resize');
    const operationId = randomUUID();
    client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } } });
    const activity = { kind: 'tool' as const, tool, ...(description === undefined ? {} : { description }) };
    client.output({ kind: 'activity', operationId, generation: 1, activity });
    await waitFor(() => expect(app.lastFrame()).toContain(prefix));
    vi.advanceTimersByTime(65000);
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n').filter((row) => row.includes(prefix));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/….*\b1m05s\b/u);
      expect(measureWidth(rows[0]!)).toBeLessThanOrEqual(80);
    });
    expect(entries()).toEqual([]);
  });

  it.each(['completed', 'failed', 'interrupted', 'disconnected', 'next-turn'] as const)(
    'clears transient activity after %s and ignores other turns and generations', async (end) => {
      const { app, client } = mount(lang);
      const operationId = randomUUID();
      const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 4 } };
      client.output({ kind: 'running', state });
      await waitFor(() => expect(client.getSnapshot().state?.running?.operationId).toBe(operationId));
      client.output({ kind: 'activity', operationId, generation: 4, activity: { kind: 'tool', tool: 'TransientTool' } });
      await waitFor(() => expect(app.lastFrame()).toContain('TransientTool'));
      expect(entries()).toEqual([]);
      client.output({ kind: 'activity', operationId: randomUUID(), generation: 4, activity: { kind: 'tool', tool: 'WrongOperation' } });
      client.output({ kind: 'activity', operationId, generation: 3, activity: { kind: 'tool', tool: 'WrongGeneration' } });
      expect(app.lastFrame()).toContain('TransientTool');
      if (end === 'disconnected') client.change({ connection: 'disconnected' });
      else if (end === 'next-turn') client.output({ kind: 'running', state: {
        ...state, running: { operationId: randomUUID(), kind: 'turn', generation: 5 },
      } });
      else {
        client.output({ kind: 'pending', state: { ...state, running: null, interrupted: end === 'interrupted' } });
        client.output({ kind: 'result', operationId, result: end === 'completed'
          ? { kind: 'reply', message: 'Finished' } : { kind: 'error', code: end, message: 'Stopped' } });
      }
      await waitFor(() => {
        expect(app.lastFrame()).not.toContain('TransientTool');
        expect(app.lastFrame()).not.toContain('WrongOperation');
        expect(app.lastFrame()).not.toContain('WrongGeneration');
      });
      client.output({ kind: 'activity', operationId, generation: 3, activity: { kind: 'tool', tool: 'LateTool' } });
      app.stdin.write('After late activity');
      await waitFor(() => expect(app.lastFrame()).toContain('After late activity'));
      expect(app.lastFrame()).not.toContain('LateTool');
      expect(JSON.stringify(entries())).not.toContain('Tool');
    },
  );

  it.each(['message', 'approve_summary'])('shows input rejection immediately during a tool-free running %s operation', async (kind) => {
    const { app, client } = mount(lang);
    client.change({ state: { ...client.getSnapshot().state!, running: { operationId: randomUUID(), kind, generation: 1 } } });
    const message = getLabel('manager.conversation.queue_full', lang);
    client.submit.mockResolvedValueOnce({ kind: 'error', code: 'queue_full', message });
    app.stdin.write('Rejected input\r');
    await waitFor(() => expect(entries()).toContainEqual({ role: 'system', content: message }));
    expect(entries().some((entry) => entry.role === 'user' && entry.content === 'Rejected input')).toBe(true);
    expect(client.commands()).toEqual([{ kind: 'message', text: 'Rejected input' }]);
    expect(client.getSnapshot().state?.running).not.toBeNull();
    client.change({ state: { ...client.getSnapshot().state!, running: null } });
    await waitFor(() => expect(entries()).toContainEqual({ role: 'user', content: 'Rejected input' }));
  });

  it.each([false, true])('recovers a settled message once after reconnect, including a lost acceptance response=%s', async (lostResponse) => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    client.submit.mockImplementationOnce(async (_command, onAccepted) => {
      if (!lostResponse) onAccepted?.(operationId);
      client.change({ connection: 'disconnected' });
      if (lostResponse) throw new Error('Connection lost before acceptance response');
      return { kind: 'accepted', operationId };
    });
    app.stdin.write('Recover this message\r');
    await waitFor(() => expect(client.submit).toHaveBeenCalledOnce());
    const items = [...client.getSnapshot().items, { kind: 'user_message' as const, operationId,
      message: 'Recover this message', acceptedSequence: 1, pending: false }];
    client.change({ connection: 'connected', readStatus: 'complete', state: { ...client.getSnapshot().state!, running: null }, items });
    await waitFor(() => expect(entries().filter((entry) => entry.role === 'user')).toEqual([
      { role: 'user', content: 'Recover this message' },
    ]));
    client.output({ kind: 'user_message', operationId, message: 'Recover this message' });
    client.change({ items: [...items] });
    await waitFor(() => expect(entries().filter((entry) => entry.role === 'user')).toHaveLength(1));
    client.change({ items: [...items, { kind: 'user_message', operationId: randomUUID(), message: 'Recover this message', acceptedSequence: 2, pending: false }] });
    await waitFor(() => expect(entries().filter((entry) => entry.role === 'user')).toHaveLength(2));
  });

  it('keeps a queued message in the queue area above the input and moves it into the log once when its turn starts', async () => {
    const { app, client } = mount(lang);
    const running = { operationId: randomUUID(), kind: 'turn', generation: 1 };
    const context = { callId: 'call', operationId: running.operationId, generation: 1 };
    const state = { ...client.getSnapshot().state!, running };
    client.output({ kind: 'user_message', operationId: running.operationId, message: 'first request' });
    client.output({ kind: 'running', state });
    client.output({ kind: 'tool_completed', entry: { key: 'before', toolId: 'before', tool: 'Bash', input: { command: 'before queue' },
      output: '', context, status: 'success', association: 'matched', result: 'before-result' } });
    await waitFor(() => expect(entries().map((entry) => entry.role)).toEqual(['user', 'tool']));
    const queuedId = randomUUID();
    client.submit.mockResolvedValueOnce({ kind: 'accepted', operationId: queuedId, queuedMessageCount: 1 });
    app.stdin.write('queued request\r');
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'queued request' }]));
    const queuedItem = { kind: 'user_message' as const, operationId: queuedId, message: 'queued request', acceptedSequence: 2, pending: true };
    client.change({ state: { ...state, queuedMessageCount: 1 }, items: [...client.getSnapshot().items, queuedItem] });
    const heading = getLabel('tui.ui.queuedCount', lang, { count: '1' });
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const headingRow = rows.findIndex((row) => row.includes(heading));
      expect(headingRow).toBeGreaterThan(-1);
      expect(rows[headingRow + 1]).toBe('❯ queued request');
      expect(rows[headingRow + 2]!.startsWith('╭')).toBe(true);
    });
    client.output({ kind: 'tool_completed', entry: { key: 'after', toolId: 'after', tool: 'Bash', input: { command: 'after queue' },
      output: '', context, status: 'success', association: 'matched', result: 'after-result' } });
    client.output({ kind: 'result', operationId: running.operationId, result: { kind: 'reply', message: 'first reply' } });
    await waitFor(() => expect(entries().map((entry) => entry.role)).toEqual(['user', 'tool', 'tool', 'assistant']));
    expect(JSON.stringify(entries())).not.toContain('queued request');
    const next = { ...state, running: { operationId: queuedId, kind: 'turn', generation: 1 }, queuedMessageCount: 0 };
    client.change({ state: next });
    await waitFor(() => {
      expect(entries().map((entry) => entry.role)).toEqual(['user', 'tool', 'tool', 'assistant', 'user']);
      expect(entries().at(-1)).toEqual({ role: 'user', content: 'queued request' });
      expect(app.lastFrame()).not.toContain(heading);
    });
    client.output({ kind: 'user_message', operationId: queuedId, message: 'queued request' });
    client.change({ items: [...client.getSnapshot().items.filter((item) => item !== queuedItem), { ...queuedItem, pending: false }] });
    await waitFor(() => expect(entries().filter((entry) => entry.content === 'queued request')).toHaveLength(1));
  });

  it('shows the thinking label without a log entry and commits tools and text in the order they happened', async () => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    const context = { callId: 'call', operationId, generation: 1 };
    client.output({ kind: 'user_message', operationId, message: 'inspect' });
    client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } } });
    client.output({ kind: 'activity', operationId, generation: 1, activity: { kind: 'thinking' } });
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.extendedThinking', lang)));
    client.output({ kind: 'turn_text', operationId, generation: 1, message: 'Reading the file first.' });
    client.output({ kind: 'tool_started', entry: { key: 'read', toolId: 'read', tool: 'Read', input: { file_path: 'a.ts' }, output: '',
      context, status: 'running', association: 'matched' } });
    client.output({ kind: 'activity', operationId, generation: 1, activity: { kind: 'tool', tool: 'Read' } });
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const running = rows.findIndex((row) => row.startsWith('◆ Read a.ts …'));
      expect(running).toBeGreaterThan(-1);
      expect(running).toBeLessThan(rows.findIndex((row) => row.startsWith('╭')));
    });
    client.output({ kind: 'tool_completed', entry: { key: 'read', toolId: 'read', tool: 'Read', input: { file_path: 'a.ts' }, output: '',
      context, status: 'success', association: 'matched', result: 'file body', startedAt: 1000, completedAt: 1074 } });
    client.output({ kind: 'result', operationId, result: { kind: 'reply', message: 'Done.' } });
    await waitFor(() => expect(entries().map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']));
    expect(entries()[2]!.content.split('\n')[0]).toBe('Read a.ts ✓ 74 ms');
    expect(entries().filter((entry) => entry.content.includes('file body'))).toHaveLength(1);
    expect(app.lastFrame()).toContain('◆ Read a.ts ✓ 74 ms');
  });

  it('keeps the committed tools and records the interruption after them', async () => {
    const { client } = mount(lang);
    const operationId = randomUUID();
    const context = { callId: 'call', operationId, generation: 1 };
    const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } };
    client.output({ kind: 'user_message', operationId, message: 'inspect' });
    client.output({ kind: 'running', state });
    client.output({ kind: 'tool_completed', entry: { key: 'done', toolId: 'done', tool: 'Bash', input: { command: 'npm test' }, output: '',
      context, status: 'success', association: 'matched', result: 'kept-result' } });
    client.output({ kind: 'pending', state: { ...state, running: null, interrupted: true } });
    client.output({ kind: 'result', operationId, result: { kind: 'error', code: 'interrupted', message: 'Turn interrupted' } });
    await waitFor(() => expect(entries()).toEqual([
      { role: 'user', content: 'inspect' },
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('kept-result') }),
      { role: 'system', content: 'Turn interrupted' },
    ]));
  });

  it('marks omitted tool output with [more] and keeps the raw clock values out of the log', async () => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } } });
    client.output({ kind: 'tool_completed', entry: { key: 'long', toolId: 'long', tool: 'Bash', input: { command: 'cat log' }, output: '',
      context: { callId: 'call', operationId, generation: 1 }, status: 'success', association: 'matched',
      result: 'one\ntwo\nthree\nfour', startedAt: 1794811657541, completedAt: 1794811660741 } });
    await waitFor(() => expect(entries()).toHaveLength(1));
    const content = entries()[0]!.content;
    expect(content.split('\n')).toEqual(['Bash Ran cat log ✓ 3.2 s', 'one', 'two', 'three', '[more]']);
    expect(app.lastFrame()).not.toContain('@1794811657541');
    expect(app.lastFrame()).not.toMatch(/#\d/u);
  });

  it.each(['reply', 'progress', 'notice'] as const)('distinguishes daemon %s output by kind even with identical text', async (kind) => {
    const { app, client } = mount(lang);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', lang)));
    const message = 'Shared output';
    const operationId = randomUUID();
    const output: PortOutput = kind === 'notice' ? { kind, id: randomUUID(), message } : { kind, operationId, message };
    client.output(output);
    const role = kind === 'reply' ? 'assistant' : 'system';
    await waitFor(() => expect(entries()).toEqual([{ role, content: message }]));
    expect(app.lastFrame()).toContain(`${kind === 'reply' ? '●' : ' '} ${message}`);
    if (kind !== 'reply') expect(app.lastFrame()).not.toContain('●');
  });

  it.each(['failed', 'error'] as const)('keeps the completed %s verification notice in the transcript after interpretation is interrupted', async (verdict) => {
    const { app, client } = mount(lang);
    const operationId = randomUUID();
    const state = { ...client.getSnapshot().state!, running: { operationId, kind: 'turn', generation: 1 } };
    client.output({ kind: 'running', state });
    const content = JSON.stringify({ verdict, runDirectory: '/test/.takt/runs/verify-test' });
    client.output({ kind: 'pending', state: { ...state, running: null, interrupted: true } });
    client.output({ kind: 'result', operationId, result: { kind: 'error', code: 'interrupted', message: content } });
    app.stdin.write('continue');
    await waitFor(() => {
      expect(entries()).toContainEqual({ role: 'system', content });
      expect(app.lastFrame()).toContain(content);
    });
  });

  it.each<OperationResult>([
    { kind: 'reply', message: 'Shared result' },
    { kind: 'notice', message: 'Shared result' },
    { kind: 'answer_saved', answerSaved: true, message: 'Shared result' },
    { kind: 'error', code: 'operation_failed', message: 'Shared result' },
    { kind: 'goal_registered', goal: goalRecord() },
  ])('distinguishes $kind operation results from manager replies', async (result) => {
    const { app, client } = mount(lang);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', lang)));
    client.output({ kind: 'result', operationId: randomUUID(), result });
    await waitFor(() => {
      expect(entries()).toHaveLength(1);
      expect(entries()[0]!.role).toBe(result.kind === 'reply' ? 'assistant' : 'system');
    });
    if (result.kind === 'reply') expect(app.lastFrame()).toContain('● Shared result');
    else expect(app.lastFrame()).not.toContain('●');
  });

  it('shows saved display events and snapshot errors as system notices', async () => {
    const { app, client } = mount(lang);
    client.change({ error: 'Read failed', items: [...client.getSnapshot().items,
      { kind: 'display_event', event: { id: 'saved-notice', message: 'Saved notification' } }] });
    await waitFor(() => expect(entries()).toEqual([
      { role: 'system', content: 'Read failed' }, { role: 'system', content: 'Saved notification' },
    ]));
    expect(app.lastFrame()).not.toContain('●');
  });

  it('shows the full startup notice once before conversation output without adding it to messages or commands', async () => {
    const { app, client } = mount(lang);
    const notice = getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, '');
    const checkNotice = (): void => {
      const text = app.lastFrame()!.replace(/\s+/gu, '');
      expect(text.startsWith(notice)).toBe(true);
      expect(text.split(notice)).toHaveLength(2);
      expect(app.lastFrame()!.split('\n').at(-1)).not.toMatch(/実験的|experimental/iu);
    };
    await waitFor(checkNotice);
    expect(entries()).toEqual([]);
    expect(client.submit).not.toHaveBeenCalled();
    client.output({ kind: 'reply', operationId: randomUUID(), message: 'Conversation reply' });
    await waitFor(() => expect(app.lastFrame()).toContain('Conversation reply'));
    checkNotice();
    expect(entries()).toEqual([{ role: 'assistant', content: 'Conversation reply' }]);
    app.stdin.write('Hello\r');
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'Hello' }]));
    checkNotice();
  });

  it.each([24, 40, 80])('wraps the full yellow startup notice within %i columns', (columns) => {
    const level = chalk.level;
    try {
      chalk.level = 3;
      const output = renderToString(createElement(TranscriptView, {
        entries: [], startupNotice: getLabel('manager.experimentalNotice', lang),
        userMessageColors: FALLBACK_USER_MESSAGE_COLORS,
      }), { columns });
      expect(output).toContain('\x1b[33m');
      const text = stripAnsi(output);
      expect(text.replace(/\s+/gu, '')).toBe(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
      for (const row of text.split('\n')) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    } finally { chalk.level = level; }
  });

  it('shows assignment and counts on one bottom row after the key hints', async () => {
    const client = new ManagerClientDouble();
    const assignment = client.getSnapshot().items[0]!;
    client.change({ items: [assignment, { kind: 'goal', goal: { ...goalRecord(), awaitingHumanMerge: false, repositoryDirectory: cwd } }, {
      kind: 'inquiry', inquiry: { question: createInquiry({ body: 'Pending question' }),
        target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } },
    }] });
    const context = mount(lang, client);
    Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: 120 });
    context.app.stdout.emit('resize');
    const heading = getLabel('manager.assignmentHeading', lang, { name: 'manager-repository' });
    const counts = getLabel('manager.counts', lang, { goals: '1', awaiting: '0', questions: '1' });
    const status = [heading, counts].join(' | ');
    await waitFor(() => {
      const rows = context.app.lastFrame()!.split('\n');
      expect(rows.slice(-2)).toEqual([getLabel('manager.inputHint', lang), status]);
      expect(rows.filter((row) => row.includes(heading) || row.includes(counts))).toEqual([status]);
      expect(rows.join('\n')).not.toContain('/make-goal');
      expect(rows.join('').replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
    });
    expect(client.submit).not.toHaveBeenCalled();
    context.app.stdin.write('/');
    await waitFor(() => expect(context.app.lastFrame()).toContain(`/make-goal  ${getLabel('manager.makeGoalDescription', lang)}`));
    context.app.stdin.write(DOWN);
    await waitFor(() => expect(context.app.lastFrame()).toContain(`/verify  ${getLabel('interactive.commands.verify', lang)}`));
  });

  it('preserves the multiple repository heading on the bottom status row', async () => {
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Workspace',
      repositoryDirectories: [cwd, '/test/second', '/test/third'],
    } }] });
    const { app } = mount(lang, client);
    await waitFor(() => expect(app.lastFrame()!.split('\n').at(-1)).toBe([
      getLabel('manager.assignmentHeadingMultiple', lang, { name: 'manager-repository', count: '2' }),
      getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' }),
    ].join(' | ')));
  });

  it('shows an empty assignment on the bottom status row', async () => {
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Empty workspace',
      repositoryDirectories: [],
    } }] });
    const { app } = mount(lang, client);
    await waitFor(() => expect(app.lastFrame()!.split('\n').at(-1)).toBe([
      getLabel('manager.selectionEmpty.repository', lang),
      getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' }),
    ].join(' | ')));
    expect(app.lastFrame()).not.toContain('manager-repository');
  });

  it.each([0, 2].map((extra) => measureWidth(getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' })) + 15 + extra))('preserves the status suffix with a truncated ordinary assignment heading within %i columns', async (columns) => {
    const { app } = mount(lang);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const status = rows.at(-1)!;
      const [heading] = status.split(' | ');
      const counts = getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' });
      expect(heading).toContain('…');
      expect(status.split(' | ')).toEqual([heading, counts]);
      expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it.each([64, 80])('truncates only the assignment heading and preserves counts within %i columns', async (columns) => {
    const name = '開発repository'.repeat(30);
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory: `/test/${name}`, repositoryDirectories: [`/test/${name}`],
    } }] });
    const { app } = mount(lang, client);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const status = rows.at(-1)!;
      const [heading, counts] = status.split(' | ');
      expect(heading).toContain('…');
      expect(counts).toBe(getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' }));
      expect(rows.filter((row) => row.includes(counts!))).toEqual([status]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it.each([0, 4, 6].map((extra) => measureWidth(getLabel('manager.counts', lang, { goals: '1', awaiting: '0', questions: '1' })) + extra))('shows the assignment above counts within %i columns', async (columns) => {
    const name = `開発-${'repository'.repeat(10)}-末尾`;
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory, repositoryDirectories: [repositoryDirectory],
    } }, { kind: 'goal', goal: { ...goalRecord(), awaitingHumanMerge: false, repositoryDirectory } }, { kind: 'inquiry', inquiry: {
      question: createInquiry({ body: 'Pending question' }),
      target: { goalId: null, owner: { kind: 'repository', repositoryDirectory } },
    } }] });
    const { app } = mount(lang, client);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    const fullHeading = getLabel('manager.assignmentHeading', lang, { name });
    const counts = getLabel('manager.counts', lang, { goals: '1', awaiting: '0', questions: '1' });
    const details = counts;
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const heading = rows.at(-2)!.trimEnd();
      const [start, end] = heading.split('…');
      expect(start!.length).toBeGreaterThan(0);
      expect(end!.length).toBeGreaterThan(0);
      expect(fullHeading.startsWith(start!)).toBe(true);
      expect(fullHeading.endsWith(end!)).toBe(true);
      expect(rows.at(-1)).toBe(details);
      expect(rows.filter((row) => row.includes(counts))).toEqual([details]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it('truncates the second status row at the end on very narrow terminals', async () => {
    const name = '開発repository'.repeat(10);
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory, repositoryDirectories: [repositoryDirectory],
    } }] });
    const { app } = mount(lang, client);
    const counts = getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' });
    const details = counts;
    for (const columns of [1, 2, 8, 12]) {
      Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
      app.stdout.emit('resize');
      await waitFor(() => {
        const rows = app.lastFrame()!.split('\n').slice(-2);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('…');
        const truncatedDetails = rows[1]!.trimEnd();
        expect(truncatedDetails).toMatch(/…$/u);
        expect(details.startsWith(truncatedDetails.slice(0, -1))).toBe(true);
        for (const row of rows) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
      });
    }
  });

  it('separates human merge waits from ongoing goals without changing goal operation candidates', async () => {
    const base = { ...goalRecord(), repositoryDirectory: cwd, awaitingHumanMerge: false };
    const goals = [base, { ...base, id: randomUUID(), status: 'awaiting_merge' as const },
      { ...base, id: randomUUID(), objective: 'Human merge wait', status: 'awaiting_merge' as const, awaitingHumanMerge: true },
      { ...base, id: randomUUID(), executionStatus: 'paused' as const },
      { ...base, id: randomUUID(), status: 'completed' as const },
      { ...base, id: randomUUID(), executionStatus: 'aborted' as const }];
    const client = new ManagerClientDouble();
    client.change({ items: [...client.getSnapshot().items, ...goals.map((goal) => ({ kind: 'goal' as const, goal }))] });
    const { app } = mount(lang, client);
    const counts = getLabel('manager.counts', lang, { goals: '3', awaiting: '1', questions: '0' });
    await waitFor(() => expect(app.lastFrame()).toContain(counts));
    app.stdin.write('\x07');
    await waitFor(() => {
      expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', lang));
      expect(app.lastFrame()).toContain('Human merge wait');
    });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('preserves both ends of a long workspace assignment heading and nonzero counts when resized', async () => {
    const name = `開発-${'👩‍💻e\u0301作業'.repeat(20)}-末尾`;
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Workspace',
      repositoryDirectories: [repositoryDirectory, '/test/second', '/test/third'],
    } }, ...Array.from({ length: 12 }, () => ({ kind: 'goal' as const, goal: { ...goalRecord(), awaitingHumanMerge: false, id: randomUUID(), repositoryDirectory } })),
    ...Array.from({ length: 3 }, () => ({ kind: 'inquiry' as const, inquiry: {
      question: createInquiry({ body: 'Pending question' }),
      target: { goalId: null, owner: { kind: 'repository' as const, repositoryDirectory } },
    } }))] });
    const { app } = mount(lang, client);
    const fullHeading = getLabel('manager.assignmentHeadingMultiple', lang, { name, count: '2' });
    const counts = getLabel('manager.counts', lang, { goals: '12', awaiting: '0', questions: '3' });
    for (const columns of [80, 60, 120]) {
      Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
      app.stdout.emit('resize');
      await waitFor(() => {
        const rows = app.lastFrame()!.split('\n');
        const status = rows.at(-1)!;
        const [heading] = status.split(' | ');
        expect(status.split(' | ')).toEqual([heading, counts]);
        const [start, end] = heading!.trimEnd().split('…');
        expect(start!.length).toBeGreaterThan(0);
        expect(end!.length).toBeGreaterThan(0);
        expect(fullHeading.startsWith(start!)).toBe(true);
        expect(fullHeading.slice(-end!.length)).toBe(end);
        expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
        for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
      });
    }
  });

  it.each([undefined, ['CSV', 'JSON']])('keeps ordinary question answers as the input or selected option (%j)', async (options) => {
    const client = new ManagerClientDouble();
    const question = createInquiry({ body: 'Choose output', ...(options === undefined ? {} : { options }) });
    const target = { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } as const;
    client.change({ items: [client.getSnapshot().items[0]!, { kind: 'inquiry', inquiry: { target, question } }] });
    const context = mount(lang, client);
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '1' })));
    context.app.stdin.write(QUESTION_MENU);
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', lang)));
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.app.lastFrame()).toContain(question.body));
    const text = options === undefined ? 'Use plain text' : options[0]!;
    if (options === undefined) {
      context.app.stdin.write(text);
      await waitFor(() => expect(promptFrame(context)).toContain(text));
    }
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'answer_question', target, questionId: question.id, answer: { text } }]));
    const operationId = await client.operation();
    client.output({ kind: 'result', operationId, result: { kind: 'answer_saved', message: 'Answer stored', answerSaved: true } });
    await waitFor(() => expect(entries().filter((entry) => entry.role === 'user')).toEqual([{ role: 'user', content: text }]));
  });

  describe.each(['completed', 'unable'] as const)('operation request answer: %s', (report) => {
    it.each(['', ' \t\n ', 'Checked the output\nNo errors'])('shows the selected answer with comment %j without an empty user entry', async (comment) => {
      const client = new ManagerClientDouble();
      const question = createInquiry({ kind: 'operation_request', body: 'Confirm output' });
      const target = { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } as const;
      client.change({ items: [client.getSnapshot().items[0]!, { kind: 'inquiry', inquiry: { target, question } }] });
      const context = mount(lang, client);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '1' })));
      context.app.stdin.write(QUESTION_MENU);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', lang)));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.answerStages.report', lang)));
      if (report === 'unable') context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.answerStages.comment', lang)));
      if (comment !== '') {
        context.app.stdin.write('\x1b[200~' + comment + '\x1b[201~');
        await waitFor(() => expect(promptFrame(context)).not.toContain(lang === 'ja' ? '回答を入力してください' : 'Enter your answer'));
      }
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(client.commands()).toEqual([{ kind: 'answer_question', target, questionId: question.id,
        answer: { report, text: comment } }]));
      const operationId = await client.operation();
      client.output({ kind: 'result', operationId, result: { kind: 'answer_saved', message: 'Answer stored', answerSaved: true } });
      const choice = getLabel(`manager.answerChoices.${report}`, lang);
      const content = comment.trim() === '' ? choice : `${choice}\n${comment}`;
      await waitFor(() => {
        expect(entries().filter((entry) => entry.role === 'user')).toEqual([{ role: 'user', content }]);
        expect(context.app.lastFrame()).toContain(choice);
      });
    });
  });
});

it.each(['system', 'assistant'] as const)('renders %s entries at width 80 with the corresponding marker and dim style', (role) => {
  const level = chalk.level;
  try {
    chalk.level = 3;
    const content = 'First line\nSecond line';
    const output = renderToString(createElement(TranscriptEntryView, {
      entry: { role, content }, userMessageColors: FALLBACK_USER_MESSAGE_COLORS,
    }), { columns: 80 });
    const text = stripAnsi(output);
    expect(text).toBe(`${role === 'assistant' ? '●' : ' '} First line\n  Second line\n`);
    if (role === 'system') {
      expect(output).toContain('\x1b[2m');
      expect(text).not.toContain('●');
    } else {
      expect(output).not.toContain('\x1b[2m');
      expect(output).toContain('\x1b[37m● ');
    }
  } finally { chalk.level = level; }
});

it.each([
  { role: 'thinking' as const, marker: '◇' },
  { role: 'tool' as const, marker: '◆' },
])('renders $role entries with the $marker marker, dims the whole entry and leaves a blank row after it', ({ role, marker }) => {
  const level = chalk.level;
  try {
    chalk.level = 3;
    const content = 'First line\nSecond line';
    const entry = { role, content };
    const inkOutput = renderToString(createElement(TranscriptEntryView, { entry, userMessageColors: FALLBACK_USER_MESSAGE_COLORS }), { columns: 80 });
    expect(stripAnsi(inkOutput)).toBe(`${marker} First line\n  Second line\n`);
    for (const row of inkOutput.split('\n').filter((row) => row !== '')) expect(row).toContain('\x1b[2m');
    const ttyOutput = formatTranscriptEntryOutput(entry, FALLBACK_USER_MESSAGE_COLORS);
    expect(stripAnsi(ttyOutput)).toBe(`${marker} First line\n  Second line\n\n`);
    expect(ttyOutput.startsWith('\x1b[2m')).toBe(true);
  } finally { chalk.level = level; }
});

it('commits completed tools directly in delivery order and keeps replacement tails out of the log', async () => {
  const { client } = mount('en');
  const operationId = randomUUID();
  const context = { callId: 'call', operationId, generation: 1 };
  client.output({ kind: 'user_message', operationId, message: 'first' });
  client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { kind: 'turn', operationId, generation: 1 } } });
  client.output({ kind: 'tool_started', entry: { key: '1', toolId: 'tool', tool: 'Bash', input: {}, output: '', context, status: 'running', association: 'matched' } });
  client.output({ kind: 'tool_output', key: '1', text: '', tail: 'provisional' });
  await waitFor(() => expect(entries()).toEqual([{ role: 'user', content: 'first' }]));
  const completed = { key: '1', toolId: 'tool', tool: 'Bash', input: {}, output: '', context, status: 'success' as const, association: 'matched' as const, result: 'completed tool' };
  client.output({ kind: 'tool_completed', entry: completed });
  client.output({ kind: 'result', operationId, result: { kind: 'reply', message: 'reply' } });
  client.output({ kind: 'user_message', operationId: randomUUID(), message: 'second' });
  await waitFor(() => {
    const log = entries();
    expect(log.map((entry) => entry.role)).toEqual(['user', 'tool', 'assistant', 'user']);
    expect(log[1]!.content).toContain('completed tool');
    expect(log[2]!.content).toBe('reply');
    expect(log[3]!.content).toBe('second');
    expect(log.some((entry) => entry.content.includes('provisional'))).toBe(false);
  });
  client.change({ items: [...client.getSnapshot().items, { kind: 'tool_history', history: { operationId, generation: 1, finished: true, history: { entries: [completed] } } }] });
  await waitFor(() => expect(entries()).toHaveLength(4));
});

it('opens completed tool details with Ctrl+O after the active region becomes empty', async () => {
  const { app, client } = mount('en');
  const operationId = randomUUID();
  const context = { callId: 'call', operationId, generation: 1 };
  client.output({ kind: 'running', state: { ...client.getSnapshot().state!, running: { kind: 'turn', operationId, generation: 1 } } });
  client.output({ kind: 'tool_completed', entry: { key: randomUUID(), toolId: 'tool', tool: 'Bash', input: {}, output: '', context,
    status: 'success', association: 'matched', result: 'one\ntwo\nthree\nfour\nhidden-detail' } });
  client.output({ kind: 'pending', state: { ...client.getSnapshot().state!, running: null } });
  await waitFor(() => expect(app.lastFrame()).not.toContain('hidden-detail'));
  app.stdin.write('\x0f');
  await waitFor(() => expect(app.lastFrame()).toContain('hidden-detail'));
});

it('waits only for initial snapshot completion before committing tool entries', async () => {
  const { app, client } = mount('en', new ManagerClientDouble({ readStatus: 'reading' }));
  const operationId = randomUUID();
  const entry = { key: randomUUID(), toolId: 'tool', tool: 'Bash', input: {}, output: '',
    context: { callId: 'call', operationId, generation: 1 }, status: 'success' as const, association: 'matched' as const,
    result: 'completed-during-initial-read' };
  client.output({ kind: 'tool_completed', entry });
  await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en')));
  expect(entries()).toEqual([]);
  client.change({ readStatus: 'complete', items: [...client.getSnapshot().items, { kind: 'tool_history',
    history: { operationId, generation: 1, finished: true, history: { entries: [entry] } } }] });
  await waitFor(() => expect(entries()).toHaveLength(1));
  client.change({ readStatus: 'incomplete' });
  client.output({ kind: 'tool_completed', entry: { ...entry, key: randomUUID(), toolId: 'later', result: 'later-entry' } });
  await waitFor(() => expect(entries()).toHaveLength(2));
});

const savedMessage = (operationId: string, message: string, acceptedSequence: number): SnapshotDisplayItem =>
  ({ kind: 'user_message', operationId, message, acceptedSequence, pending: false });
const savedResult = (operationId: string, acceptedSequence: number, result: OperationResult): SnapshotDisplayItem =>
  ({ kind: 'turn_result', operationId, acceptedSequence, result });
const savedTool = (operationId: string, acceptedSequence: number, result: string): SnapshotDisplayItem => ({ kind: 'tool_history', acceptedSequence,
  history: { operationId, generation: 1, finished: true, history: { entries: [{ key: randomUUID(), toolId: 'tool', tool: 'Bash', input: {}, output: '',
    context: { callId: 'call', operationId, generation: 1 }, status: 'success', association: 'matched', result }] } } });
const logLines = () => entries().map((entry) => entry.role === 'tool'
  ? `tool:${['old-tool', 'new-tool'].find((name) => entry.content.includes(name))}` : `${entry.role}:${entry.content}`);

it('restores saved turns as message, tools and result once at startup and after reconnect, including a turn saved without a result', async () => {
  const old = randomUUID(); const replied = randomUUID(); const interrupted = randomUUID();
  const items = [...new ManagerClientDouble().getSnapshot().items,
    savedMessage(old, 'old question', 1), savedTool(old, 1, 'old-tool'),
    savedMessage(replied, 'new question', 2), savedTool(replied, 2, 'new-tool'), savedResult(replied, 2, { kind: 'reply', message: 'saved reply' }),
    savedMessage(interrupted, 'stopped question', 3), savedResult(interrupted, 3, { kind: 'error', code: 'interrupted', message: 'Turn interrupted' })];
  const { client } = mount('en', new ManagerClientDouble({ items }));
  const restored = ['user:old question', 'tool:old-tool', 'user:new question', 'tool:new-tool', 'assistant:saved reply',
    'user:stopped question', 'system:Turn interrupted'];
  await waitFor(() => expect(logLines()).toEqual(restored));
  client.change({ connection: 'disconnected', readStatus: 'incomplete' });
  const later = randomUUID();
  client.change({ connection: 'connected', readStatus: 'complete',
    items: [...items, savedMessage(later, 'later question', 4), savedResult(later, 4, { kind: 'reply', message: 'later reply' })] });
  await waitFor(() => expect(logLines()).toEqual([...restored, 'user:later question', 'assistant:later reply']));
});

it('does not repeat a reply shown live when a later snapshot contains its saved result', async () => {
  const { client } = mount('en');
  const operationId = randomUUID();
  client.output({ kind: 'user_message', operationId, message: 'live question' });
  client.output({ kind: 'result', operationId, result: { kind: 'reply', message: 'live reply' } });
  await waitFor(() => expect(logLines()).toEqual(['user:live question', 'assistant:live reply']));
  const next = randomUUID();
  client.change({ items: [...client.getSnapshot().items, savedMessage(operationId, 'live question', 1), savedResult(operationId, 1, { kind: 'reply', message: 'live reply' }),
    savedMessage(next, 'next question', 2), savedResult(next, 2, { kind: 'reply', message: 'next reply' })] });
  await waitFor(() => expect(logLines()).toEqual(['user:live question', 'assistant:live reply', 'user:next question', 'assistant:next reply']));
});

it.each(['live', 'snapshot'] as const)('clears the earlier log when the /clear notice arrives from the %s result and keeps later messages', async (source) => {
  const context = mount('en');
  const { app, client } = context;
  const earlier = randomUUID();
  client.output({ kind: 'user_message', operationId: earlier, message: 'earlier question' });
  client.output({ kind: 'result', operationId: earlier, result: { kind: 'reply', message: 'earlier reply' } });
  await waitFor(() => expect(logLines()).toEqual(['user:earlier question', 'assistant:earlier reply']));
  await typeAndSubmit(context, '/clear');
  await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: '/clear' }]));
  const operationId = await client.operation();
  await waitFor(() => expect(logLines()).toContain('user:/clear'));
  const notice = getLabel('manager.conversation.cleared', 'en');
  const result = { kind: 'notice', message: notice } as const;
  if (source === 'live') client.output({ kind: 'result', operationId, result });
  else client.change({ items: [...client.getSnapshot().items, savedResult(operationId, 2, result)] });
  await waitFor(() => expect(logLines()).toEqual([`system:${notice}`]));
  // テスト用の出力は Static がそれまでに書き出した全行を毎回含むので、書き出した結果そのものを確かめられる。
  await waitFor(() => expect(app.lastFrame()).toContain(notice));
  expect(app.lastFrame()).not.toContain('earlier');
  client.output({ kind: 'user_message', operationId: randomUUID(), message: 'later question' });
  await waitFor(() => expect(logLines()).toEqual([`system:${notice}`, 'user:later question']));
  await waitFor(() => expect(app.lastFrame()).toContain('later question'));
  expect(app.lastFrame()).not.toContain('earlier');
});

it('ends the goal proposal request when its live result arrives after the snapshot showed the saved result', async () => {
  const context = mount('en');
  const { app, client } = context;
  await typeAndSubmit(context, '/make-goal');
  const operationId = await client.operation();
  const state = client.getSnapshot().state!;
  client.change({ state: { ...state, running: { operationId, generation: 1, kind: 'message' } } });
  await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summaryWorking', 'en')));
  const result = { kind: 'reply', message: 'Need more detail' } as const;
  client.change({ state: { ...state, running: null }, items: [...client.getSnapshot().items, savedResult(operationId, 1, result)] });
  await waitFor(() => expect(logLines()).toEqual(['assistant:Need more detail']));
  client.output({ kind: 'result', operationId, result });
  await waitFor(() => expect(logLines()).toEqual(['assistant:Need more detail', `system:${getLabel('manager.goSummaryUnavailable', 'en')}`]));
  client.change({ state: { ...state, running: { operationId: randomUUID(), generation: 1, kind: 'message' } } });
  await waitFor(() => expect(app.lastFrame()).toContain('Working'));
  expect(app.lastFrame()).not.toContain(getLabel('manager.summaryWorking', 'en'));
});

it('accepts another registration when the live result of an approval arrives after the snapshot showed the saved result', async () => {
  const context = mount('en');
  const { app, client } = context;
  // 実際のクライアントは読取を終えると新しいスナップショットを通知する。
  client.refresh.mockImplementation(async () => { client.change({}); });
  await showProposal(context);
  approveSummary(context);
  await waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.summary.confirmation', 'en')));
  const operationId = await client.operation();
  const result = { kind: 'error', code: 'registration_failed', message: 'Registration failed' } as const;
  client.change({ items: [...client.getSnapshot().items, savedResult(operationId, 1, result)] });
  await waitFor(() => expect(logLines()).toContain('system:Registration failed'));
  client.output({ kind: 'result', operationId, result });
  await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summary.confirmation', 'en')));
  approveSummary(context);
  await waitFor(() => expect(client.commands()).toEqual([
    { kind: 'approve_summary', revision: 4 }, { kind: 'approve_summary', revision: 4 },
  ]));
});
