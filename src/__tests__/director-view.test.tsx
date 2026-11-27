import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectorView } from '../features/director/DirectorView.js';
import { ManagerClientDouble } from './helpers/manager-tui-fixtures.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { stripAnsi } from '../shared/utils/text.js';
import { randomUUID } from 'node:crypto';
import type { SnapshotValue } from '../features/manager/conversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import type { ToolActivityEntry } from '../shared/tool-activity/types.js';

afterEach(cleanup);

function proposalClient() {
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: '/blog' });
  const pending = { revision: 4, managerId, repositoryDirectory: '/blog',
    summary: { objective: '記事一覧', outOfScope: ['記事編集'], acceptanceCriteria: ['公開記事を一覧できる'], constraints: [] } };
  const client = new ManagerClientDouble({ state: { conversationId: conversationId({ kind: 'daemon' }), assignment: { kind: 'daemon' },
    revision: 4, pending, approval: null, running: null, interrupted: false },
  items: [{ kind: 'assignment', assignment: { kind: 'daemon', repositoryDirectories: [] } }] });
  return { client, pending };
}

it('shows the director proposal contents and selected manager and submits one explicit approval', async () => {
  const { client, pending } = proposalClient();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => {
    const frame = app.lastFrame()!.replace(/\s+/gu, '');
    for (const text of [pending.summary.objective, ...pending.summary.outOfScope, ...pending.summary.acceptanceCriteria, pending.managerId]) {
      expect(frame).toContain(text);
    }
    expect(app.lastFrame()).toContain(getLabel('manager.summary.approve', 'en'));
  });
  expect(client.commands()).toEqual([]);
  app.stdin.write('\x1b[A');
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'approve_summary', revision: 4, conversationId: client.getSnapshot().state!.conversationId }]));
});

it('updates the proposal and resets the selected approval on the same director screen', async () => {
  const { client, pending } = proposalClient();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(pending.summary.objective));
  app.stdin.write('\x1b[A');
  const changed = { ...pending, revision: 5, summary: { ...pending.summary, objective: '検索付き記事一覧' } };
  client.change({ state: { ...client.getSnapshot().state!, revision: 5, pending: changed } });
  await vi.waitFor(() => expect(app.lastFrame()).toContain(changed.summary.objective));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'dismiss_summary', revision: 5, conversationId: client.getSnapshot().state!.conversationId }]));
});

it.each(['disconnected', 'reading'].flatMap((status) => [true, false].map((approve) => ({ status, approve }))))(
  'does not submit a director proposal while $status (approve: $approve)', async ({ status, approve }) => {
    const { client } = proposalClient();
    client.change(status === 'disconnected' ? { connection: 'disconnected' } : { readStatus: 'reading' });
    const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel(`manager.conversation.${status}`, 'en')));
    if (approve) app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.commands()).toEqual([]);
  });

function humanInquiry(): Extract<SnapshotValue, { kind: 'inquiry' }> {
  return { kind: 'inquiry', inquiry: {
    target: { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/assigned' },
    objective: 'Export goal',
    question: { id: '650e8400-e29b-41d4-a716-446655440001', kind: 'question', recipient: 'human', status: 'pending',
      body: 'Which output format?', options: ['CSV', 'JSON'] },
  } };
}

it('answers a human inquiry from the initial director snapshot without sending a message to the AI', async () => {
  const item = humanInquiry();
  const client = new ManagerClientDouble({ items: [item] });
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.pendingQuestions', 'en', { count: '1' })));
  app.stdin.write('\x12');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Export goal'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(item.inquiry.question.body));
  app.stdin.write('\r');

  await vi.waitFor(() => expect(client.commands()).toEqual([{
    kind: 'answer_question', target: item.inquiry.target, questionId: item.inquiry.question.id,
    answer: { text: 'CSV' },
  }]));
});

it('closes a displayed inquiry after delegation and shows the same inquiry again when it returns to the human', async () => {
  const item = humanInquiry();
  const client = new ManagerClientDouble();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', 'en')));
  client.change({ items: [item] });
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Pending questions: 1'));
  app.stdin.write('\x12');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Export goal'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(item.inquiry.question.body));

  client.change({ items: [] });
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(item.inquiry.question.body));
  app.stdin.write('\r');
  expect(client.commands()).toEqual([]);

  client.change({ items: [item] });
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Pending questions: 1'));
  app.stdin.write('\x12');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Export goal'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(item.inquiry.question.body));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{
    kind: 'answer_question', target: item.inquiry.target, questionId: item.inquiry.question.id, answer: { text: 'CSV' },
  }]));
});
it('keeps a CR-only bracketed paste as an unsent multi-line draft until Enter', async () => {
  const client = new ManagerClientDouble();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', 'en')));

  app.stdin.write('\x1b[200~first\rsecond\x1b[201~');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('second'));
  expect(client.commands()).toEqual([]);

  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'first\nsecond' }]));
});

it.each(['ja', 'en'] as const)('shows queue capacity rejection in the submitting director TUI (%s)', async (lang) => {
  const client = new ManagerClientDouble();
  const message = getLabel('manager.conversation.queue_full', lang);
  client.submit.mockResolvedValueOnce({ kind: 'error', code: 'queue_full', message });
  const app = render(createElement(DirectorView, { client, lang, onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', lang)));
  app.stdin.write('capacity request');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('capacity request'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'capacity request' }]));
  await vi.waitFor(() => expect(app.lastFrame()!.replace(/\s+/gu, '')).toContain(message.replace(/\s+/gu, '')));
});

it('accepts speech during a running director turn and shows its waiting count', async () => {
  const client = new ManagerClientDouble();
  client.change({ state: { ...client.getSnapshot().state!, running: { operationId: randomUUID(), kind: 'message' }, queuedMessageCount: 1 } });
  client.submit.mockResolvedValueOnce({ kind: 'accepted', operationId: randomUUID(), queuedMessageCount: 2 });
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('tui.ui.thinking', 'en'));
    expect(app.lastFrame()).toContain(getLabel('tui.ui.queuedCount', 'en', { count: '1' }));
  });
  app.stdin.write('new request');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('new request'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'new request' }]));
  await vi.waitFor(() => expect(app.lastFrame()!.replace(/\s+/gu, ' ')).toContain(getLabel('manager.conversation.queued', 'en', { count: '2' })));
  expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.busy', 'en'));
});
it('shows a remote message once and avoids repeating its own accepted message', async () => {
  const client = new ManagerClientDouble();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', 'en')));
  const remote = { kind: 'user_message' as const, operationId: randomUUID(), message: 'Remote request' };
  client.output(remote); client.output(remote);
  await vi.waitFor(() => expect(app.lastFrame()!.split(remote.message)).toHaveLength(2));
  app.stdin.write('Local request');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Local request'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toHaveLength(1));
  const operationId = await client.operation();
  client.output({ kind: 'user_message', operationId, message: 'Local request' });
  await vi.waitFor(() => {
    expect(app.lastFrame()!.split('Local request')).toHaveLength(2);
    expect(app.lastFrame()!.split(remote.message)).toHaveLength(2);
  });
});
it.each(['ja', 'en'] as const)('shows a compact idle screen at 80 columns and detaches without cancelling in %s', async (lang) => {
  const client = new ManagerClientDouble();
  client.change({ state: { ...client.getSnapshot().state!, queuedMessageCount: 0 } });
  const exit = vi.fn();
  const app = render(createElement(DirectorView, { client, lang, onExit: exit }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', lang)));
  Object.defineProperty(app.stdout, 'columns', { configurable: true, get: () => 80 });
  app.stdout.emit('resize');
  expect(app.frames.join('\n').replace(/\s+/gu, ' ')).toContain(getLabel('director.experimentalNotice', lang));
  expect(app.frames.join('\n')).not.toMatch(/provider\s*API/iu);
  expect(app.lastFrame()).toContain(getLabel('director.inputHint', lang));
  expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.waiting', lang, { count: '0' }));
  expect(app.lastFrame()).not.toContain(getLabel('tui.ui.queuedCount', lang, { count: '0' }));
  expect(app.lastFrame()).not.toContain(getLabel('director.pendingQuestions', lang, { count: '0' }));
  await vi.waitFor(() => {
    for (const line of stripAnsi(app.lastFrame()!).split('\n')) expect(measureWidth(line)).toBeLessThanOrEqual(80);
  });
  app.stdin.write('status');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('status'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'status' }]));
  client.output({ kind: 'notice', id: 'notice', message: 'decision required' });
  client.change({ items: [{ kind: 'display_event', event: { id: 'notice', message: 'decision required' } }] });
  await vi.waitFor(() => expect(app.frames.join('\n')).toContain('decision required'));
  app.stdin.write('\x03');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  expect(client.commands()).toEqual([{ kind: 'message', text: 'status' }]);
  app.unmount();
  expect(client.close).toHaveBeenCalled();
});

it('shows director turn status, a running tool, and completed tool details after the reply', async () => {
  const client = new ManagerClientDouble();
  const app = render(createElement(DirectorView, { client, lang: 'ja', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.placeholder', 'ja')));
  const operationId = randomUUID();
  const generation = 1;
  const context = { operationId, generation, callId: 'call' };
  const tool = 'mcp__takt_director__takt_tell_manager';
  const entry: ToolActivityEntry = {
    key: 'tell', toolId: 'tell', tool, input: { message: 'check queue' }, output: '', context, status: 'running', association: 'matched',
  };
  const state = { ...client.getSnapshot().state!, running: { operationId, generation, kind: 'turn' }, queuedMessageCount: 0 };
  client.output({ kind: 'running', state });
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.thinking', 'ja')));
  client.output({ kind: 'activity', operationId, generation, activity: { kind: 'thinking' } });
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.extendedThinking', 'ja')));
  client.output({ kind: 'tool_started', entry });
  client.output({ kind: 'activity', operationId, generation, activity: { kind: 'tool', tool } });
  await vi.waitFor(() => expect(app.lastFrame()).toMatch(/◆ .*takt_tell_manager.*…/u));

  const completed = { ...entry, status: 'failure' as const, result: 'request rejected\nreason one\nreason two\nvalidation detail' };
  client.output({ kind: 'tool_completed', entry: completed });
  client.output({ kind: 'activity', operationId, generation, activity: { kind: 'responding' } });
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('tui.ui.responding', 'ja'));
    expect(app.frames.join('\n')).toMatch(/◆ .*takt_tell_manager.*✗/u);
  });
  client.output({ kind: 'pending', state: { ...state, running: null } });
  client.output({ kind: 'result', operationId, result: { kind: 'reply', message: 'The handoff failed.' } });
  client.change({ items: [{ kind: 'tool_history', history: { operationId, generation, finished: true, history: { entries: [completed] } } }] });
  await vi.waitFor(() => {
    expect(app.frames.join('\n')).toContain('The handoff failed.');
    expect(app.lastFrame()).not.toContain(getLabel('tui.ui.responding', 'ja'));
    expect(app.lastFrame()).toContain('Ctrl+O');
  });
  expect(app.lastFrame()).not.toContain('validation detail');
  app.stdin.write('\x0f');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('validation detail'));
  expect(client.commands()).toEqual([]);
});

it('restores completed tool details from the snapshot on reconnect', async () => {
  const client = new ManagerClientDouble({ connection: 'disconnected', readStatus: 'incomplete' });
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.conversation.disconnected', 'en')));
  const operationId = randomUUID();
  const turn = { operationId, generation: 1 };
  const tool = 'mcp__takt_director__takt_list_managers';
  const entry: ToolActivityEntry = { key: 'saved', tool, toolId: 'saved', context: { ...turn, callId: 'call' },
    input: {}, output: '', result: 'A saved tool result', status: 'success', association: 'matched' };
  client.change({ connection: 'connected', readStatus: 'complete', items: [
    { kind: 'tool_history', history: { ...turn, finished: true, history: { entries: [entry] } } },
    { kind: 'turn_result', operationId, acceptedSequence: 1, result: { kind: 'reply', message: 'Previous reply' } },
  ] });
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Ctrl+O'));
  expect(app.frames.join('\n')).not.toContain('Previous reply');
  app.stdin.write('\x0f');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(entry.result));
});

it('lets the operator page through tool details when a proposal fills the screen', async () => {
  const { client, pending } = proposalClient();
  const operationId = randomUUID();
  const turn = { operationId, generation: 1 };
  const resultLines = Array.from({ length: 30 }, (_, index) => `Result line ${index + 1}.`);
  const entry: ToolActivityEntry = { key: 'many', tool: 'takt_list_managers', toolId: 'many', context: { ...turn, callId: 'call' },
    input: {}, output: '', result: resultLines.join('\n'), status: 'success', association: 'matched' };
  client.change({ items: [{ kind: 'tool_history', history: { ...turn, finished: true, history: { entries: [entry] } } }] });
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  Object.defineProperties(app.stdout, { columns: { configurable: true, value: 80 }, rows: { configurable: true, value: 24 } });
  app.stdout.emit('resize');
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(pending.summary.objective);
    expect(app.lastFrame()).toContain(getLabel('tui.ui.toolHistoryCompact', 'en'));
  });
  app.stdin.write('\x0f');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.toolHistoryExpanded', 'en')));
  expect(app.lastFrame()).not.toContain(pending.summary.objective);
  app.stdin.write('\r');
  app.stdin.write('\x1b[6~');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(resultLines.at(-1)));
  app.stdin.write('\x1b[5~');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(resultLines.at(-1)));
  app.stdin.write('\x0f');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(pending.summary.objective));
  expect(client.commands()).toEqual([]);
});

it('keeps the acceptance visible and appends a later manager result once in the same director screen', async () => {
  const client = new ManagerClientDouble();
  const operationId = '11111111-1111-4111-8111-111111111111';
  const accepted = `queued:${operationId}`;
  const message = `manager result ${operationId}: completed`;
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain('director'));
  client.output({ kind: 'result', operationId: '22222222-2222-4222-8222-222222222222', result: { kind: 'reply', message: accepted } });
  await vi.waitFor(() => expect(app.lastFrame()!.replace(/\s+/gu, ' ')).toContain(accepted));
  const notification = { kind: 'display_event' as const, event: { id: '33333333-3333-4333-8333-333333333333', message } };
  client.refresh.mockImplementation(async () => { client.change({ items: [notification] }); });
  await vi.waitFor(() => expect(app.lastFrame()!.replace(/\s+/gu, ' ')).toContain(message), { timeout: 2000 });
  expect(app.lastFrame()!.replace(/\s+/gu, ' ')).toContain(accepted);
  await client.refresh();
  client.output({ kind: 'notice', ...notification.event });
  client.output({ kind: 'notice', id: '44444444-4444-4444-8444-444444444444', message: 'refresh complete' });
  await vi.waitFor(() => expect(app.lastFrame()).toContain('refresh complete'));
  expect(app.lastFrame()!.replace(/\s+/gu, ' ').split(message)).toHaveLength(2);
  expect(client.commands()).toEqual([]);
  app.unmount();
});
