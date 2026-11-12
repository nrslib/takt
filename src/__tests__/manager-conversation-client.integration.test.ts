import { connectConversationIpc } from '../features/daemon/conversationReadiness.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import * as daemonFiles from '../infra/daemon/privateFile.js';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { ManagerView } from '../features/manager/ManagerView.js';
import * as selectionDialog from '../features/manager/ManagerSelectionDialog.js';
import * as transcriptView from '../features/tui/TranscriptEntryView.js';
import * as toolActivityView from '../features/tui/ToolActivityView.js';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { ConversationTransferReceiver } from '../features/manager/conversationTransferReceiver.js';
import * as frames from '../features/daemon/conversationFrames.js';
import * as goalService from '../infra/goals/service.js';
import type { ConversationDelivery, SnapshotItem, SnapshotRead } from '../features/manager/conversationPort.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import * as privateFiles from '../shared/utils/private-file.js';
import { answerInquiry, createInquiry } from '../infra/goals/inquiry.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { conversationDaemon } from './helpers/conversation-daemon.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { removeDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { writeLegacyConversation, conversationRecord } from './helpers/conversation-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { askTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { Goal } from '../infra/goals/schema.js';
import { formatGoalNotification } from '../infra/goals/notifications.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { getLabel } from '../shared/i18n/index.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { deferred, humanTurnText } from './helpers/daemon-turn.js';
import { measureWidth } from '../shared/utils/grapheme.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), resolve: vi.fn(), ensure: vi.fn(), plan: vi.fn() }));
vi.mock('node:net', async (original) => ({ ...await original<typeof import('node:net')>() }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.ensure }));
vi.mock('../infra/daemon/owner.js', async (original) => ({ ...await original<typeof import('../infra/daemon/owner.js')>(), isDaemonOwnerRunning: () => true }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path }));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({ ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (path: string) => path }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/tui/TranscriptEntryView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/TranscriptEntryView.js')>();
  return { ...actual, TranscriptView: vi.fn((props: Parameters<typeof actual.TranscriptView>[0]) =>
    createElement(actual.TranscriptView, props)) };
});
vi.mock('../features/tui/ToolActivityView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/ToolActivityView.js')>();
  return { ...actual, ToolActivityView: vi.fn((props: Parameters<typeof actual.ToolActivityView>[0]) =>
    createElement(actual.ToolActivityView, props)) };
});

let directory: string;
let repository: string;
let assignment: ManagerAssignment;
let server: Awaited<ReturnType<typeof createConversationIpcServer>>;
let fixture: Awaited<ReturnType<typeof conversationDaemon>>;
let service: Awaited<ReturnType<typeof conversationDaemon>>['input'];
let client: ConversationIpcClient;
const owner = { pid: process.pid, identity: { startTime: 'client-integration-owner' }, version: 'test', cliPath: '/test/cli.js' };
// 再接続待ち（500ms）と再読込を挟む待機があるため、既定の 1 秒では負荷時に足りない。
function waitFor<T>(callback: () => T | Promise<T>): Promise<T> { return vi.waitFor(callback, { timeout: 5_000 }); }
const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment }));
function saveGoal(goal: Goal, goalRepository = repository) {
  const path = join(goalRepository, '.takt', 'goals', goal.id);
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'goal.json'), JSON.stringify(goal));
}
beforeEach(async () => {
  vi.clearAllMocks();
  doubles.ensure.mockReset().mockImplementation(async () => {
    const socket = await connectConversationIpc(directory, owner);
    if (socket === undefined) throw new Error('Daemon IPC readiness failed');
    return socket;
  });
  vi.stubEnv('COLUMNS', '100'); vi.stubEnv('LINES', '24');
  doubles.plan.mockReturnValue({ ctx: { providerType: 'mock' } });
  directory = getGlobalConfigDir(); repository = join(directory, 'repository'); mkdirSync(repository, { recursive: true });
  assignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  doubles.assignment.mockResolvedValue(assignment);
  const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  writeLegacyConversation(directory, record);
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } });
  fixture = await conversationDaemon(directory, { resolve: doubles.resolve, close: async () => {} });
  service = fixture.input;
  await writeDaemonOwner(directory, owner);
  server = await createConversationIpcServer(directory, owner, service);
  client = new ConversationIpcClient(assignment, { provider: 'mock', model: 'chosen-model' });
});
afterEach(async () => { cleanup(); client.close(); await fixture.close(); await server.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function complete() { await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('complete'), { timeout: 10_000 }); }

function useToolProvider(call: ProviderAgent['call']): void {
  const executor = createManagerTurnExecutor(repository, {
    ctx: { providerType: 'mock', lang: 'en', model: undefined, provider: makeProvider({ setup: () => ({ call }) }) },
    strategy: { systemPrompt: 'manager' },
  });
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'tool-history', executor });
}

function toolReply(message = 'Tool turn finished') {
  return { persona: 'manager', status: 'done' as const, content: '', timestamp: new Date(),
    structuredOutput: { message, summary: null } };
}

function currentToolPage() {
  const props = vi.mocked(toolActivityView.ToolActivityView).mock.lastCall?.[0];
  expect(props, 'ManagerView should render the shared tool activity view').toBeDefined();
  return props!;
}

function toolRows(): string { return currentToolPage().page.rows.join('\n'); }

async function browseToolPage(app: ReturnType<typeof render>, key: string): Promise<string> {
  const before = currentToolPage();
  app.stdin.write(key);
  await waitFor(() => expect(currentToolPage().state).not.toEqual(before.state));
  return toolRows();
}

it.each(['start', 'result'].flatMap((phase) => ['before publication', 'after publication'].map((timing) => ({ phase, timing }))))(
  'keeps current history when a snapshot starts $timing of the $phase event', async ({ phase, timing }) => {
  const firstDone = deferred<void>(); const secondDone = deferred<void>();
  const startSecondTool = deferred<void>(); const secondResult = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const index = ++invocation;
    if (index === 2) await startSecondTool.promise;
    options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: 'Read', input: { file_path: `turn-${index}.ts` } } });
    if (index === 1) { options.onStream!({ type: 'tool_result', data: { id: 'tool', content: 'previous', isError: false } }); await firstDone.promise; }
    else { await secondResult.promise; options.onStream!({ type: 'tool_result', data: { id: 'tool', content: 'ready', isError: false } }); await secondDone.promise; }
    return toolReply();
  }));
  const connections = observeIpcConnections(); await client.connect(); await complete(); await snapshotView();
  const write = daemonFiles.writePrivateFile;
  const saving = deferred<void>(); const publish = deferred<void>();
  try {
    await client.submit({ kind: 'message', text: 'Previous turn' });
    await waitFor(() => expect(toolRows()).toContain('previous'));
    firstDone.resolve(); await fixture.settled(); await refreshSnapshot(client, connections[0]!);
    await client.submit({ kind: 'message', text: 'Current turn' }); await fixture.executing(2);
    const operationId = client.getSnapshot().state!.running!.operationId;
    vi.spyOn(daemonFiles, 'writePrivateFile').mockImplementation(async (path, content, signal) => {
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
      if (path.endsWith(`/conversations/${client.getSnapshot().state!.conversationId}.json`)
        && text.includes(operationId) && text.includes('turn-2.ts') && (phase === 'start' ? !text.includes('ready') : text.includes('ready'))) {
        saving.resolve(); await publish.promise;
      }
      await write(path, content, signal);
    });
    startSecondTool.resolve(); if (phase === 'result') secondResult.resolve(); await saving.promise;
    const entered = deferred<void>();
    const snapshot = fixture.conversations.snapshot.bind(fixture.conversations);
    vi.spyOn(fixture.conversations, 'snapshot').mockImplementation((id) => {
      const pending = snapshot(id); entered.resolve(); return pending;
    });
    const refreshing = timing === 'before publication' ? refreshSnapshot(client, connections[0]!) : undefined;
    if (refreshing !== undefined) await entered.promise;
    publish.resolve();
    if (refreshing !== undefined) await refreshing;
    else await refreshSnapshot(client, connections[0]!);
    await waitFor(() => expect(toolRows()).toContain('turn-2.ts'));
    expect(client.getSnapshot().items.find((item) => item.kind === 'tool_history')).toMatchObject({ history: { operationId } });
    if (phase === 'result') expect(toolRows()).toContain('ready');
    secondResult.resolve();
    secondDone.resolve(); await fixture.settled();
    await waitFor(() => expect(toolRows()).toContain('ready'));
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2)); await complete();
    expect(toolRows()).toContain('ready');
  } finally { publish.resolve(); firstDone.resolve(); startSecondTool.resolve(); secondResult.resolve(); secondDone.resolve(); await fixture.settled(); }
});

it('removes the previous live history after a tool-free turn and keeps its displayed transcript on reconnect', async () => {
  const finish = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ === 0) {
      options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: 'Read', input: { file_path: 'previous.ts' } } });
      options.onStream!({ type: 'tool_result', data: { id: 'tool', content: 'previous-result', isError: false } });
      await finish.promise;
    }
    return toolReply();
  }));
  const connections = observeIpcConnections(); await client.connect(); await complete(); await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Previous tools' });
    await waitFor(() => expect(toolRows()).toContain('previous-result'));
    finish.resolve(); await fixture.settled(); await refreshSnapshot(client, connections[0]!);
    await client.submit({ kind: 'message', text: 'No tools this turn' }); await fixture.settled();
    await refreshSnapshot(client, connections[0]!);
    expect(client.getSnapshot().items.filter((item) => item.kind === 'tool_history')).toHaveLength(0);
    connections[0]!.socket.destroy(); await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(client.getSnapshot().items.filter((item) => item.kind === 'tool_history')).toHaveLength(0);
    const text = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries.map((entry) => entry.content).join('\n');
    expect(text.split('previous-result')).toHaveLength(2);
  } finally { finish.resolve(); await fixture.settled(); }
});

it('appends the previous tool transcript before the next user message', async () => {
  const secondTurn = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ === 0) {
      options.onStream!({ type: 'tool_use', data: { id: 'previous', tool: 'Read', input: { file_path: 'previous.ts' } } });
      options.onStream!({ type: 'tool_result', data: { id: 'previous', content: 'previous-result', isError: false } });
      return toolReply();
    }
    await secondTurn.promise;
    return toolReply('Second turn');
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'First question' }); await fixture.settled();
    await waitFor(() => expect(toolRows()).toContain('previous-result'));

    app.stdin.write('Next question'); app.stdin.write('\r');
    await fixture.executing(2);
    await waitFor(() => {
      const entries = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
      expect(entries.some((entry) => entry.content.includes('Next question'))).toBe(true);
      expect(entries.some((entry) => entry.content.includes('previous-result'))).toBe(true);
    });
    const entries = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
    const historyIndex = entries.findIndex((entry) => entry.content.includes('previous-result'));
    const questionIndex = entries.findIndex((entry) => entry.role === 'user' && entry.content.includes('Next question'));
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThan(historyIndex);
    expect(entries.filter((entry) => entry.content.includes('previous-result'))).toHaveLength(1);
  } finally { secondTurn.resolve(); await fixture.settled(); }
});

it.each([1, 2])('retains each of %s identical completed results once after unfinished removal and display changes on the same screen', async (count) => {
  const finish = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ > 0) return toolReply('Next turn');
    options.onStream!({ type: 'tool_use', data: { id: 'unfinished', tool: 'Bash', input: { command: 'background' } } });
    for (let index = 0; index < count; index++) {
      options.onStream!({ type: 'tool_use', data: { id: `completed-${index}`, tool: 'Read', input: { file_path: `file-${index}.ts` } } });
      options.onStream!({ type: 'tool_result', data: { id: `completed-${index}`, content: 'ready', isError: false } });
    }
    await finish.promise; return toolReply();
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Keep visible completed results' });
    await waitFor(() => expect(toolRows().split('\n').filter((row) => row === 'ready')).toHaveLength(count));
    finish.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    await waitFor(() => expect(toolRows()).not.toContain('background'));
    await browseToolPage(app, '\x0f');
    while (currentToolPage().page.hasMore) await browseToolPage(app, '\x1b[6~');
    const columns = vi.spyOn(app.stdout, 'columns', 'get');
    columns.mockReturnValue(40); app.stdout.emit('resize');
    await waitFor(() => { for (const row of currentToolPage().page.rows) expect(measureWidth(row)).toBeLessThanOrEqual(40); });
    await browseToolPage(app, '\x0f');
    await client.submit({ kind: 'message', text: 'Advance to the next turn' }); await fixture.settled();
    await waitFor(() => {
      const text = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries.map((entry) => entry.content).join('\n');
      expect(text.split('\n').filter((line) => line === 'ready')).toHaveLength(count);
      expect(text).not.toContain('background');
    });
  } finally { finish.resolve(); await fixture.settled(); }
});

it.each([
  'printf abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  "printf '途中…完了'",
])('retains the exact displayed input in the next transcript after resizing the same screen: %s', async (command) => {
  const finish = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ > 0) return toolReply('Next turn');
    options.onStream!({ type: 'tool_use', data: { id: 'summary', tool: 'Bash', input: { command } } });
    options.onStream!({ type: 'tool_result', data: { id: 'summary', content: 'ready', isError: false } });
    await finish.promise; return toolReply();
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  const columns = vi.spyOn(app.stdout, 'columns', 'get');
  columns.mockReturnValue(40); app.stdout.emit('resize');
  try {
    await client.submit({ kind: 'message', text: 'Show the command' });
    await waitFor(() => {
      expect(toolRows()).toContain('success');
      const header = toolRows().split('\n').find((row) => row.startsWith('✓ Bash'))!;
      expect(header).toBeDefined(); expect(measureWidth(header)).toBeLessThanOrEqual(40);
      if (command.length > 40) expect(header).toMatch(/…$/u);
    });
    columns.mockReturnValue(80); app.stdout.emit('resize');
    await waitFor(() => expect(toolRows()).toContain(`✓ Bash Ran ${command}`));
    finish.resolve(); await fixture.settled();
    await client.submit({ kind: 'message', text: 'Advance to another turn' }); await fixture.settled();
    await waitFor(() => {
      const text = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries.map((entry) => entry.content).join('\n');
      expect(text.split('\n').filter((line) => line === `✓ Bash Ran ${command}`)).toHaveLength(1);
    });
  } finally { finish.resolve(); await fixture.settled(); }
});

it('retains the received start and completion times once after compact display and finite expanded pages on the same screen', async () => {
  const finish = deferred<void>(); let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ > 0) return toolReply('Next turn');
    options.onStream!({ type: 'tool_use', data: { id: 'timed', tool: 'Bash', input: { command: 'printf ready' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'timed', content: 'ready', isError: false } });
    await finish.promise; return toolReply();
  }));
  await client.connect(); await complete();
  const pending = client.getSnapshot().state!.pending!;
  await client.submit({ kind: 'dismiss_summary', revision: pending.revision }); await fixture.settled();
  await waitFor(() => expect(client.getSnapshot().state?.pending).toBeNull());
  const app = await snapshotView();
  vi.spyOn(app.stdout, 'columns', 'get').mockReturnValue(32); app.stdout.emit('resize');
  try {
    await client.submit({ kind: 'message', text: 'Show exact times' });
    await waitFor(() => expect(toolRows()).toMatch(/success @.*…/u));
    const item = client.getSnapshot().items.find((value) => value.kind === 'tool_history');
    expect(item?.kind).toBe('tool_history');
    if (item?.kind !== 'tool_history') throw new Error('Missing received tool history');
    const entry = item.history.history.entries[0]!;
    expect(entry.startedAt).toEqual(expect.any(Number)); expect(entry.completedAt).toEqual(expect.any(Number));
    const timing = `success @${entry.startedAt} → @${entry.completedAt} (${Math.max(0, entry.completedAt! - entry.startedAt!)} ms) ${getLabel('tui.ui.toolHistoryCompletion', 'en')} #${entry.completionSequence}`;
    const observed: string[] = [];
    await browseToolPage(app, '\x0f');
    for (let page = 0; page < 30; page++) {
      observed.push(...currentToolPage().page.rows);
      if (!currentToolPage().page.hasMore) break;
      await browseToolPage(app, '\x1b[6~');
    }
    expect(observed.join('')).toContain(timing);
    expect(currentToolPage().page.hasMore).toBe(false);
    finish.resolve(); await fixture.settled();
    await client.submit({ kind: 'message', text: 'Advance after viewing the times' }); await fixture.settled();
    await waitFor(() => {
      const text = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries.map((entry) => entry.content).join('\n');
      expect(text.split('\n').filter((line) => line === timing)).toHaveLength(1);
    });
  } finally { finish.resolve(); await fixture.settled(); }
});

it.each([5, 6])('fits a %s line draft and expanded results while resizing the same screen without losing its cursor', async (lineCount) => {
  const finish = deferred<void>();
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'long', tool: 'Bash', input: { command: 'printf long' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'long', content: Array.from({ length: 100 }, (_, i) => `result-${i}`).join('\n'), isError: false } });
    await finish.promise; return toolReply();
  }));
  await client.connect(); await complete();
  const pending = client.getSnapshot().state!.pending!;
  await client.submit({ kind: 'dismiss_summary', revision: pending.revision }); await fixture.settled();
  await waitFor(() => expect(client.getSnapshot().state?.pending).toBeNull());
  const app = await snapshotView(); const submit = vi.spyOn(client, 'submit');
  const lines = Array.from({ length: lineCount }, (_, index) => `下書き${index + 1}を保持`);
  const draft = lines.join('\n');
  try {
    await client.submit({ kind: 'message', text: 'Show detailed results with my draft' });
    await waitFor(() => expect(toolRows()).toContain('result-0'));
    app.stdin.write('\x1b[200~' + draft + '\x1b[201~');
    await waitFor(() => expect(app.lastFrame()).toContain(lines.at(-1)!));
    app.stdin.write('\x1b[D'); app.stdin.write('\x1b[D');
    await browseToolPage(app, '\x0f');
    const columns = vi.spyOn(app.stdout, 'columns', 'get');
    for (const width of [80, 40, 80]) {
      columns.mockReturnValue(width); app.stdout.emit('resize');
      await waitFor(() => {
        const frame = app.lastFrame()!; const start = frame.indexOf('✓ Bash');
        expect(start).toBeGreaterThanOrEqual(0);
        const live = frame.slice(start).trimEnd().split('\n');
        for (const line of lines) expect(live.join('\n')).toContain(line);
        for (const row of live) expect(measureWidth(row)).toBeLessThanOrEqual(width);
        expect(live.length).toBeLessThanOrEqual(24);
        expect(currentToolPage().state.expanded).toBe(true);
        expect(currentToolPage().page.hasMore).toBe(true);
      });
    }
    app.stdin.write('追記');
    await waitFor(() => expect(app.lastFrame()).toContain('追記保持'));
    finish.resolve(); await fixture.settled();
    app.stdin.write('\r');
    await waitFor(() => expect(submit.mock.calls.some(([command]) => command.kind === 'message'
      && command.text === draft.slice(0, -2) + '追記' + draft.slice(-2))).toBe(true));
  } finally { finish.resolve(); await fixture.settled(); }
});

it.each([false, true])('retains one timed tool entry across duplicate delivery, repeated snapshots and reconnect with failure=%s', async (isError) => {
  const result = deferred<void>(); const finish = deferred<void>();
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'tool-1', tool: 'Bash', input: { command: 'printf history-ready' } } });
    await result.promise;
    options.onStream!({ type: 'tool_result', data: { id: 'tool-1', content: 'history-ready', isError } });
    await finish.promise;
    return toolReply();
  });
  useToolProvider(call);
  const progress = vi.spyOn(fixture.conversations, 'progress');
  const outputs = vi.fn(); client.onOutput(outputs);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  try {
    expect(await client.submit({ kind: 'message', text: 'Track one tool' })).toMatchObject({ kind: 'accepted' });
    await waitFor(() => expect(toolRows()).toContain('running @'));
    expect(toolRows()).toContain('printf history-ready');
    const startedAt = toolRows().match(/@(\d+)/u)![1];
    result.resolve();
    await waitFor(() => expect(toolRows()).toContain(isError ? 'failure' : 'success'));
    const completed = toolRows();
    expect(completed).toContain(`@${startedAt}`);
    expect(completed).toMatch(/→ @\d+.*\(\d+ ms\)/u);
    expect(completed.split('\n').filter((row) => /^[✓✗] Bash/u.test(row))).toHaveLength(1);
    expect(completed).toContain('history-ready');
    const events = progress.mock.calls.filter(([, message]) => JSON.stringify(message).includes('"id":"tool-1"'));
    expect(events).toHaveLength(2);
    const toolOutputs = () => outputs.mock.calls.filter(([output]) => JSON.stringify(output).includes('"tool-1"'));
    const deliveredCount = toolOutputs().length;
    expect(deliveredCount).toBeGreaterThan(0);
    await refreshSnapshot(client, connections[0]!);
    await refreshSnapshot(client, connections[0]!);
    for (const [turn, message] of events) await fixture.dispatcher.post({ kind: 'turn_progress', turn, message });
    await fixture.dispatcher.drain();
    await refreshSnapshot(client, connections[0]!);
    expect(toolRows()).toBe(completed);
    expect(toolOutputs()).toHaveLength(deliveredCount);
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(toolRows()).toBe(completed);
    expect(toolOutputs()).toHaveLength(deliveredCount);
    expect(app.lastFrame()).toContain('history-ready');
    finish.resolve(); await fixture.settled();
    await refreshSnapshot(client, connections[1]!);
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    expect(toolRows()).toBe(completed);
    expect(app.lastFrame()).toContain('history-ready');
    expect(call).toHaveBeenCalledOnce();
  } finally { result.resolve(); finish.resolve(); await fixture.settled(); }
});

it.each(['operationId', 'generation'] as const)('rejects an old result when only %s differs while reusing the provider tool ID', async (different) => {
  const finishes = [deferred<void>(), deferred<void>()];
  const results = [deferred<void>(), deferred<void>()];
  let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const index = invocation++;
    options.onStream!({ type: 'tool_use', data: { id: 'tool-1', tool: 'Read', input: { file_path: `turn-${index}.ts` } } });
    await results[index]!.promise;
    options.onStream!({ type: 'tool_result', data: { id: 'tool-1', content: `turn-${index}-result`, isError: index === 0 } });
    await finishes[index]!.promise;
    return toolReply(`Turn ${index} finished`);
  }));
  const progress = vi.spyOn(fixture.conversations, 'progress');
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'First turn' });
    await waitFor(() => expect(toolRows()).toContain('turn-0.ts'));
    results[0]!.resolve();
    await waitFor(() => expect(toolRows()).toContain('turn-0-result'));
    const old = progress.mock.calls.find(([, message]) => JSON.stringify(message).includes('turn-0-result'));
    expect(old).toBeDefined();
    finishes[0]!.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    await client.submit({ kind: 'message', text: 'Second turn' });
    await waitFor(() => expect(toolRows()).toContain('turn-1.ts'));
    const current = client.getSnapshot().state!.running!;
    const turn = { ...old![0], operationId: current.operationId, generation: current.generation!,
      [different]: different === 'operationId' ? old![0].operationId : old![0].generation };
    expect(turn[different]).not.toBe(current[different]);
    const runningRows = toolRows();
    await fixture.dispatcher.post({ kind: 'turn_progress', turn, message: old![1] });
    await fixture.dispatcher.drain();
    await refreshSnapshot(client, connections[0]!);
    expect(toolRows()).toBe(runningRows);
    expect(toolRows()).not.toContain('turn-0-result');
    results[1]!.resolve();
    await waitFor(() => expect(toolRows()).toContain('turn-1-result'));
    expect(app.lastFrame()).toContain('turn-1-result');
    expect(toolRows()).toContain('success');
    expect(toolRows()).not.toContain('failure');
    const transcript = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
    expect(transcript.filter((entry) => JSON.stringify(entry).includes('turn-0-result'))).toHaveLength(1);
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(toolRows()).toContain('turn-1-result');
    expect(toolRows()).not.toContain('turn-0-result');
    expect(vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries
      .filter((entry) => JSON.stringify(entry).includes('turn-0-result'))).toHaveLength(1);
    expect(app.lastFrame()).toContain('Turn 0 finished');
  } finally { for (const value of [...results, ...finishes]) value.resolve(); await fixture.settled(); }
});

it.each([false, true])('restores a tool result completed during disconnection on the same client and screen with failure=%s', async (isError) => {
  const finish = deferred<void>(); const reconnect = deferred<void>(); const opening = deferred<void>();
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'offline-tool', tool: 'Bash', input: { command: 'printf offline-result' } } });
    await finish.promise;
    options.onStream!({ type: 'tool_result', data: { id: 'offline-tool', content: 'offline-result', isError } });
    return toolReply();
  });
  useToolProvider(call);
  const connections = observeIpcConnections();
  await client.connect(); await complete(); const app = await snapshotView();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    opening.resolve(); await reconnect.promise; return open(...args);
  });
  try {
    await client.submit({ kind: 'message', text: 'Complete while disconnected' });
    await waitFor(() => expect(toolRows()).toContain('running @'));
    const conversationId = client.getSnapshot().state!.conversationId;
    connections[0]!.socket.destroy();
    await opening.promise;
    expect(client.getSnapshot().connection).not.toBe('connected');
    expect(fixture.activeOperationCount).toBe(1);
    expect(call.mock.calls[0]![1].abortSignal?.aborted).toBe(false);
    finish.resolve(); await fixture.settled();
    expect(fixture.activeOperationCount).toBe(0);
    expect(client.getSnapshot().connection).not.toBe('connected');
    reconnect.resolve();
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete',
      state: { conversationId, running: null } }));
    await waitFor(() => expect(toolRows()).toContain(isError ? 'failure' : 'success'));
    expect(app.lastFrame()).toContain('offline-result');
    const completed = toolRows();
    expect(completed.split('\n').filter((row) => /^[✓✗] Bash/u.test(row))).toHaveLength(1);
    await refreshSnapshot(client, connections[1]!);
    await refreshSnapshot(client, connections[1]!);
    expect(toolRows()).toBe(completed);
    expect(call).toHaveBeenCalledOnce();
    expect(app.lastFrame()).toContain('offline-result');
  } finally { finish.resolve(); reconnect.resolve(); await fixture.settled(); }
});

it('discards an unfinished old tool when the same conversation advances and reconnects', async () => {
  const finishes = [deferred<void>(), deferred<void>()];
  let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const index = invocation++;
    options.onStream!({ type: 'tool_use', data: { id: 'reused', tool: 'Read', input: { file_path: index === 0 ? 'stale.ts' : 'current.ts' } } });
    await finishes[index]!.promise;
    return toolReply();
  }));
  const connections = observeIpcConnections();
  await client.connect(); await complete(); await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Start unfinished tool' });
    await waitFor(() => expect(toolRows()).toContain('stale.ts'));
    finishes[0]!.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    await client.submit({ kind: 'message', text: 'Start next turn' });
    await waitFor(() => expect(toolRows()).toContain('current.ts'));
    expect(toolRows()).not.toContain('stale.ts');
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(toolRows()).toContain('current.ts');
    expect(toolRows()).toContain('running');
    expect(toolRows()).not.toContain('stale.ts');
    const transcript = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
    expect(transcript.filter((entry) => JSON.stringify(entry).includes('stale.ts'))).toEqual([]);
  } finally { for (const value of finishes) value.resolve(); await fixture.settled(); }
});

it.each([
  ['allowed JSON', '{"stdout":"ready secret123","api\\u005fkey":"secret123"}', 'ready [REDACTED]'],
  ['unknown JSON field', '{"private_blob":{"text":"非公開本文"}}', '[structured output omitted]'],
  ['JSON array', '[{"text":"非公開本文"}]', '[structured output omitted]'],
  ['incomplete JSON', '{"stdout":"非公開本文', '[structured output omitted]'],
])('sanitizes %s in the manager compact and expanded view before and after reconnect', async (_name, content, expected) => {
  const finish = deferred<void>();
  let invocation = 0;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    if (invocation++ > 0) return toolReply('Next turn');
    options.onStream!({ type: 'tool_use', data: { id: 'safe-json', tool: 'Bash', input: { command: 'printf ready\x1b[2J' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'safe-json', content, isError: false } });
    await finish.promise;
    return toolReply();
  }));
  const connections = observeIpcConnections();
  await client.connect(); await complete(); const app = await snapshotView();
  const check = () => {
    const rows = currentToolPage().page.rows;
    expect(rows.join('\n')).toContain(expected);
    for (const row of rows) for (const forbidden of ['secret123', '非公開本文', 'private_blob', '\x1b', '{', '}']) {
      expect(row).not.toContain(forbidden);
    }
  };
  try {
    await client.submit({ kind: 'message', text: 'Show a safe result' });
    await waitFor(check);
    await browseToolPage(app, '\x0f'); check();
    expect(currentToolPage().state.expanded).toBe(true);
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    check();
    await browseToolPage(app, '\x0f'); check();
    expect(currentToolPage().state.expanded).toBe(false);
    finish.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    await client.submit({ kind: 'message', text: 'Keep the displayed history in the transcript' });
    await fixture.settled();
    await waitFor(() => expect(vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries
      .some((entry) => entry.content.includes(expected))).toBe(true));
    for (const entry of vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries) {
      for (const forbidden of ['secret123', '非公開本文', 'private_blob', '\x1b']) expect(entry.content).not.toContain(forbidden);
    }
  } finally { finish.resolve(); await fixture.settled(); }
});

it('groups five completed reads and exposes every path and result through bounded detail pages', async () => {
  const finish = deferred<void>();
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    for (let index = 0; index < 5; index++) {
      options.onStream!({ type: 'tool_use', data: { id: `read-${index}`, tool: 'Read', input: { file_path: `日本語-${index}.ts` } } });
      options.onStream!({ type: 'tool_result', data: { id: `read-${index}`, content: `read-result-${index}`, isError: false } });
    }
    await finish.promise;
    return toolReply();
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Read five files' });
    await waitFor(() => expect(toolRows()).toContain('Read 5 files'));
    const compactResults = toolRows().match(/read-result-\d/gu) ?? [];
    expect(compactResults.length).toBeGreaterThanOrEqual(1);
    expect(compactResults.length).toBeLessThanOrEqual(3);
    const pages = [await browseToolPage(app, '\x0f')];
    for (let page = 0; page < 30 && currentToolPage().page.hasMore; page++) {
      pages.push(await browseToolPage(app, '\x1b[6~'));
    }
    expect(currentToolPage().page.hasMore).toBe(false);
    for (let index = 0; index < 5; index++) {
      expect(pages.join('\n')).toContain(`日本語-${index}.ts`);
      expect(pages.join('\n')).toContain(`read-result-${index}`);
    }
    expect(pages.length).toBeGreaterThan(1);
  } finally { finish.resolve(); await fixture.settled(); }
});

it('keeps start order and matches a delayed background failure after a later tool succeeds', async () => {
  const finish = deferred<void>();
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'background', tool: 'Bash', input: { command: 'background-command' } } });
    options.onStream!({ type: 'tool_use', data: { id: 'later', tool: 'Grep', input: { pattern: 'later-search' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'later', content: 'later-success', isError: false } });
    options.onStream!({ type: 'tool_result', data: { id: 'background', content: 'background-failure', isError: true } });
    await finish.promise;
    return toolReply();
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Wait for background completion' });
    await waitFor(() => expect(toolRows()).toContain('background-failure'));
    const rows = toolRows();
    const first = rows.indexOf('✗ Bash'); const second = rows.indexOf('✓ Grep');
    expect(first).toBeGreaterThanOrEqual(0); expect(second).toBeGreaterThan(first);
    const background = rows.slice(first, second); const later = rows.slice(second);
    expect(background).toContain('✗ Bash Ran background-command');
    expect(later).toContain('✓ Grep Used Grep later-search');
    expect(background).toContain('background-command'); expect(background).toContain('failure');
    expect(background).toContain('background-failure'); expect(background).not.toContain('later-success');
    expect(later).toContain('later-search'); expect(later).toContain('success');
    expect(later).toContain('later-success'); expect(later).not.toContain('background-failure');
    expect(Number(background.match(/completion #(\d+)/u)![1])).toBeGreaterThan(Number(later.match(/completion #(\d+)/u)![1]));
    expect(app.lastFrame()).toContain('background-failure');
    expect(app.lastFrame()).toContain('later-success');
    expect(app.lastFrame()).toContain('✗ Bash Ran');
    expect(app.lastFrame()).toContain('✓ Grep Used Grep');
    const expanded = await browseToolPage(app, '\x0f');
    expect(expanded.split('\n')).toContain('✗ Bash Ran');
    expect(expanded.split('\n')).toContain('✓ Grep Used Grep');
    expect(expanded).toContain('background-command');
    expect(expanded).toContain('background-failure');
    expect(expanded).toContain('later-search');
    expect(expanded).toContain('later-success');
  } finally { finish.resolve(); await fixture.settled(); }
});

it('keeps the selected slash completion and running turn while toggling and paging tool history', async () => {
  const finish = deferred<void>();
  let signal: AbortSignal | undefined;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    signal = options.abortSignal;
    options.onStream!({ type: 'tool_use', data: { id: 'long', tool: 'Bash', input: { command: 'completion-history' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'long', content: Array<string>(50).fill('completion-result').join('\n'), isError: false } });
    await finish.promise;
    return toolReply();
  }));
  await client.connect(); await complete(); const app = await snapshotView();
  const submit = vi.spyOn(client, 'submit');
  try {
    await client.submit({ kind: 'message', text: 'Show history beside completions' });
    await waitFor(() => expect(toolRows()).toContain('completion-result'));
    app.stdin.write('/');
    await waitFor(() => expect(app.lastFrame()).toContain('❯ /make-goal'));
    app.stdin.write('\x1b[B');
    await waitFor(() => expect(app.lastFrame()).toContain('❯ /verify'));
    const running = client.getSnapshot().state!.running;
    for (const key of ['\x0f', '\x1b[6~', '\x1b[5~', '\x0f']) {
      await browseToolPage(app, key);
      expect(app.lastFrame()).toContain('❯ /verify');
      expect(client.getSnapshot().state!.running).toEqual(running);
      expect(signal?.aborted).toBe(false);
    }
    app.stdin.write('\t');
    await waitFor(() => expect(app.lastFrame()).toContain('❯ /verify '));
    expect(submit.mock.calls.filter(([command]) => command.kind === 'message')).toHaveLength(1);
  } finally { finish.resolve(); await fixture.settled(); }
});

it('preserves a Japanese draft and insertion point while paging a truncated long result, resizing and reconnecting on the same screen', async () => {
  const finish = deferred<void>();
  const lines = Array.from({ length: 180 }, (_, index) => `row-${String(index).padStart(3, '0')} ${'日本語'.repeat(20)}`);
  expect(Buffer.byteLength(lines.join('\n'))).toBeGreaterThan(16 * 1024);
  let signal: AbortSignal | undefined;
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    signal = options.abortSignal;
    options.onStream!({ type: 'tool_use', data: { id: 'long', tool: 'Bash', input: { command: 'printf long-result' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'long', content: lines.join('\n'), isError: false } });
    options.onStream!({ type: 'tool_use', data: { id: 'running', tool: 'Grep', input: { pattern: 'still-running' } } });
    await finish.promise;
    return toolReply();
  }));
  const connections = observeIpcConnections();
  await client.connect(); await complete(); const app = await snapshotView();
  const submit = vi.spyOn(client, 'submit');
  try {
    await client.submit({ kind: 'message', text: 'Inspect long output' });
    await waitFor(() => expect(toolRows()).toContain('row-000'));
    const compactRows = toolRows().match(/row-\d{3}/gu) ?? [];
    expect(compactRows.length).toBeGreaterThanOrEqual(1);
    expect(compactRows.length).toBeLessThanOrEqual(3);
    app.stdin.write('日本語下書き');
    await waitFor(() => expect(app.lastFrame()).toContain('日本語下書き'));
    app.stdin.write('\x1b[D'); app.stdin.write('\x1b[D');
    const running = { ...client.getSnapshot().state!.running! };
    const pages = [await browseToolPage(app, '\x0f')];
    for (let page = 0; page < 100 && currentToolPage().page.hasMore; page++) {
      pages.push(await browseToolPage(app, '\x1b[6~'));
      expect(currentToolPage().page.rows.length).toBeLessThan(24);
    }
    expect(currentToolPage().page.hasMore).toBe(false);
    expect(pages.join('\n')).toContain('[output truncated]');
    expect(pages.join('\n')).toContain('row-000');
    expect(pages.join('\n')).not.toContain(`row-${String(lines.length - 1).padStart(3, '0')}`);
    expect(pages.join('\n')).toContain('still-running');
    expect(pages.at(-1)).toContain('running');
    await browseToolPage(app, '\x1b[5~');
    const columns = vi.spyOn(app.stdout, 'columns', 'get');
    for (const width of [40, 100, 80]) {
      const beforeResize = toolRows();
      columns.mockReturnValue(width); app.stdout.emit('resize');
      await waitFor(() => {
        expect(app.lastFrame()).toContain('日本語下書き');
        expect(toolRows()).not.toBe(beforeResize);
        for (const row of currentToolPage().page.rows) expect(measureWidth(row)).toBeLessThanOrEqual(width);
      });
    }
    connections[0]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(2));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(client.getSnapshot().state?.running).toEqual(running);
    expect(signal?.aborted).toBe(false);
    app.stdin.write('追記');
    await waitFor(() => expect(app.lastFrame()).toContain('日本語下追記書き'));
    app.stdin.write('\r');
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: 'message', text: '日本語下追記書き' }, expect.any(Function)));
    app.stdin.write('\x1b[27u');
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally { finish.resolve(); await fixture.settled(); }
});

it.each([32, 40])('reserves wrapped control hints and the draft before filling tool detail pages at width %s', async (width) => {
  const finish = deferred<void>();
  useToolProvider(vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'bounded', tool: 'Bash', input: { command: 'printf bounded-result' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'bounded',
      content: Array.from({ length: 120 }, (_, index) => `result-line-${index}`).join('\n'), isError: false } });
    await finish.promise;
    return toolReply();
  }));
  await client.connect(); await complete();
  const pending = client.getSnapshot().state!.pending!;
  await client.submit({ kind: 'dismiss_summary', revision: pending.revision }); await fixture.settled();
  await waitFor(() => expect(client.getSnapshot().state?.pending).toBeNull());
  const app = await snapshotView();
  try {
    await client.submit({ kind: 'message', text: 'Fill the current detail page' });
    await waitFor(() => expect(toolRows()).toContain('result-line-0'));
    app.stdin.write('日本語の下書き');
    await waitFor(() => expect(app.lastFrame()).toContain('日本語の下書き'));
    await browseToolPage(app, '\x0f');
    const previousHeight = currentToolPage().height;
    vi.spyOn(app.stdout, 'columns', 'get').mockReturnValue(width); app.stdout.emit('resize');
    await waitFor(() => {
      expect(currentToolPage().height).not.toBe(previousHeight);
      expect(currentToolPage().state.expanded).toBe(true);
      expect(currentToolPage().page.hasMore).toBe(true);
      const frame = app.lastFrame()!;
      const start = frame.indexOf('✓ Bash');
      expect(start).toBeGreaterThanOrEqual(0);
      const liveRows = frame.slice(start).trimEnd().split('\n');
      for (const row of liveRows) expect(measureWidth(row)).toBeLessThanOrEqual(width);
      expect(liveRows.join('\n')).toContain('日本語の下書き');
      expect(liveRows.join('').replace(/\s/gu, '')).toContain(getLabel('manager.inputHint', 'en').replace(/\s/gu, ''));
      expect(liveRows.length).toBeLessThanOrEqual(24);
    });
  } finally { finish.resolve(); await fixture.settled(); }
});

it('refreshes human merge wait and ongoing counts through IPC when finishing work runs, fails and is retried', async () => {
  const goal: Goal = { ...goalRecord(), status: 'awaiting_merge', completion: {
    goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  saveGoal(goal);
  await client.connect(); await complete();
  const app = await snapshotView();
  const check = async (awaiting: boolean) => {
    await waitFor(() => {
      expect(displayedGoals(client)).toMatchObject([{ id: goal.id, awaitingHumanMerge: awaiting }]);
      expect(app.lastFrame()).toContain(getLabel('manager.counts', 'en', {
        goals: awaiting ? '0' : '1', awaiting: awaiting ? '1' : '0', questions: '0',
      }));
    });
  };
  await check(true);
  for (const { statuses, awaiting } of [
    { statuses: ['pending'], awaiting: false },
    { statuses: ['running'], awaiting: false },
    { statuses: ['failed'], awaiting: false },
    { statuses: ['exceeded'], awaiting: false },
    { statuses: ['pr_failed'], awaiting: false },
    { statuses: ['failed', 'pending'], awaiting: false },
    { statuses: ['failed', 'completed'], awaiting: true },
  ]) {
    writeFileSync(join(repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks: statuses.map((status, index) => ({
      name: `finishing-work-${index}`, goal_id: goal.id, merge_task: true, status,
      created_at: '2026-11-08T00:00:00.000Z', started_at: null, completed_at: null,
    })) }));
    await client.refresh(); await complete();
    await check(awaiting);
  }
});

it.each([false, true])('delivers Bash descriptions and ordered text through IPC with final JSON streamed=%s without saving transient output or sending it to Slack', async (streamFinal) => {
  const prose = 'コードを読んでいるところです。';
  const useTool = deferred<void>();
  const respond = deferred<void>();
  const finish = deferred<void>();
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'thinking', data: { thinking: 'private-reasoning-marker' } });
    options.onStream!({ type: 'thinking', data: { thinking: 'private-reasoning-marker' } });
    await useTool.promise;
    options.onStream!({ type: 'text', data: { text: prose.slice(0, 7) } });
    options.onStream!({ type: 'text', data: { text: prose.slice(7) } });
    options.onStream!({ type: 'tool_use', data: { id: 'activity-tool', tool: 'Bash', input: {
      description: '見回りの予定のコードを読む', command: 'private-input-marker', timeout: 1000,
    } } });
    await respond.promise;
    options.onStream!({ type: 'tool_result', data: { id: 'activity-tool', content: 'private-result-marker', isError: false } });
    options.onStream!({ type: 'text', data: { text: '調べがつきました。' } });
    await finish.promise;
    const structuredOutput = { message: 'Final activity reply', summary: null };
    if (streamFinal) options.onStream!({ type: 'text', data: { text: JSON.stringify(structuredOutput) } });
    return { persona: 'manager', status: 'done',
      content: `${prose}\n調べがつきました。\n${JSON.stringify(structuredOutput)}`,
      timestamp: new Date(), structuredOutput };
  });
  const executor = createManagerTurnExecutor(repository, {
    ctx: { providerType: 'mock', lang: 'en', model: undefined, provider: makeProvider({ setup: () => ({ call }) }) },
    strategy: { systemPrompt: 'manager' },
  });
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'activity', executor });
  const outputs = vi.fn();
  client.onOutput(outputs);
  const writes = vi.spyOn(daemonFiles, 'writePrivateFile');
  const savedResults = vi.spyOn(fixture.events, 'saveResult');
  await client.connect(); await complete();
  const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
  const slack = { deliver: vi.fn<ConversationDelivery['deliver']>(async () => ({ kind: 'delivered' })) };
  const slackOpen = await service.open({ ...selected, binding: { ...selected.binding, port: 'slack' } }, slack);
  slackOpen.read.cancel();
  const app = await snapshotView();
  const transcript = () => vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
  const activities = () => outputs.mock.calls.map(([value]) => value).filter((value) => value.kind === 'activity');
  await waitFor(() => expect(transcript()).toHaveLength(1));
  const initialEntries = [...transcript()];
  try {
    expect(await client.submit({ kind: 'message', text: 'Show activity' })).toMatchObject({ kind: 'accepted' });
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.extendedThinking', 'en')));
    expect(transcript()).toEqual([...initialEntries, { role: 'user', content: 'Show activity' }]);
    useTool.resolve();
    await waitFor(() => expect(app.lastFrame()).toContain('見回りの予定のコードを読む'));
    const activityRow = app.lastFrame()!.split('\n').find((row) => row.includes('見回りの予定のコードを読む'))!;
    expect(activityRow).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 見回りの予定のコードを読む.*\b\d+s\b/u);
    expect(measureWidth(activityRow)).toBeLessThanOrEqual(80);
    expect(transcript()).toEqual([...initialEntries, { role: 'user', content: 'Show activity' },
      { role: 'assistant', content: prose }]);
    const beforeTool = outputs.mock.calls.map(([output]) => output);
    const beforeIndex = beforeTool.findIndex((output) => output.message === prose);
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(beforeIndex).toBeLessThan(beforeTool.findIndex((output) => output.kind === 'activity' && output.activity.kind === 'tool'));
    // A periodic snapshot must not clear the active tool from the same running turn.
    await client.refresh(); await complete();
    expect(app.lastFrame()).toContain('見回りの予定のコードを読む');
    respond.resolve();
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('tui.ui.responding', 'en')));
    finish.resolve();
    await fixture.settled();
    await waitFor(() => {
      expect(app.lastFrame()).toContain('Final activity reply');
      expect(app.lastFrame()).not.toContain('見回りの予定のコードを読む');
      expect(app.lastFrame()).not.toContain(getLabel('tui.ui.responding', 'en'));
    });
    expect(activities()[0].activity).toEqual({ kind: 'thinking' });
    expect(activities().filter((output) => output.activity.kind === 'tool').map((output) => output.activity)).toEqual([
      { kind: 'tool', tool: 'Bash', description: '見回りの予定のコードを読む' },
    ]);
    expect(activities().at(-1).activity).toEqual({ kind: 'responding' });
    expect(transcript()).toEqual([...initialEntries, { role: 'user', content: 'Show activity' },
      { role: 'assistant', content: prose },
      { role: 'assistant', content: 'Final activity reply' }]);
    const delivered = outputs.mock.calls.map(([output]) => output);
    expect(delivered.filter((output) => output.kind === 'turn_text').map((output) => output.message)).toEqual([
      prose,
    ]);
    expect(delivered.filter((output) => output.kind === 'result')).toHaveLength(1);
    const finalIndex = delivered.findIndex((output) => output.kind === 'result' && output.result.message === 'Final activity reply');
    const textIndex = delivered.findIndex((output) => output.message === prose);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeLessThan(finalIndex);
    const transientKinds = new Set(delivered.filter((output) =>
      [prose, '調べがつきました。'].includes(output.message)).map((output) => output.kind));
    const slackOutputs = slack.deliver.mock.calls.map((args) => args[1]);
    expect(slackOutputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'Final activity reply' } }));
    for (const output of slackOutputs) {
      expect(output).not.toMatchObject({ kind: 'activity' });
      expect(transientKinds.has(output.kind)).toBe(false);
      const json = JSON.stringify(output);
      for (const transient of ['見回りの予定のコードを読む', prose, '調べがつきました。']) expect(json).not.toContain(transient);
    }
    const read = await fixture.dispatcher.snapshot(client.getSnapshot().state!.conversationId);
    const items = [];
    for await (const item of read.items) items.push(item);
    read.cancel();
    for (const persisted of [writes.mock.calls, savedResults.mock.calls, items, client.getSnapshot()]) {
      const json = JSON.stringify(persisted);
      for (const transient of [prose, '調べがつきました。', 'private-reasoning-marker']) expect(json).not.toContain(transient);
      JSON.parse(json, (key, value: unknown) => {
        expect(key).not.toBe('activity');
        return value;
      });
    }
    expect(JSON.stringify(outputs.mock.calls)).not.toContain('private-reasoning-marker');
  } finally { useTool.resolve(); respond.resolve(); finish.resolve(); await fixture.settled(); service.detach(slackOpen.attachmentId); }
});

it('does not transfer text after interruption during its conversation read', async () => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const outputs = vi.fn(); client.onOutput(outputs);
  await client.connect(); await complete();
  const conversationId = client.getSnapshot().state!.conversationId;
  const read = fixture.store.read.bind(fixture.store);
  vi.spyOn(fixture.store, 'read').mockImplementationOnce(async (id) => {
    entered.resolve(); await release.promise; return read(id);
  });
  const progress = fixture.conversations.progress({ conversationId, operationId: randomUUID(), generation: 1 },
    { kind: 'turn_text', message: '本文を配送しない' }, controller.signal);
  try {
    await entered.promise;
    controller.abort();
    release.resolve(); await progress;
    expect(outputs.mock.calls.filter(([output]) => output.kind === 'turn_text')).toEqual([]);
  } finally { release.resolve(); await progress; }
});

it('suppresses patrol text while showing its Bash description and elapsed time on the connected screen', async () => {
  const finish = deferred<void>();
  const goal: Goal = { ...goalRecord(), executionStatus: 'active' };
  saveGoal(goal);
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: '見回りの途中の文' } });
    options.onStream!({ type: 'tool_use', data: { id: 'patrol', tool: 'Bash', input: { description: '見回りの状態を調べる' } } });
    await finish.promise;
    options.onStream!({ type: 'text', data: { text: '見回りの終了前の文' } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), structuredOutput: { message: 'Patrol final reply', summary: null } };
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'patrol-text', executor });
  const outputs = vi.fn(); client.onOutput(outputs);
  await client.connect(); await complete();
  const app = await snapshotView();
  try {
    expect(await fixture.dispatcher.accept({ conversationId: client.getSnapshot().state!.conversationId,
      eventId: randomUUID(), requestId: randomUUID(), source: 'daemon', occurredAt: new Date().toISOString(),
      event: { kind: 'patrol', repositoryDirectory: repository, goalIds: [goal.id] } })).toMatchObject({ kind: 'accepted' });
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => {
      const row = app.lastFrame()!.split('\n').find((line) => line.includes('見回りの状態を調べる'));
      expect(row).toBeDefined();
      expect(row).toMatch(/\b\d+s\b/u);
    });
    finish.resolve(); await fixture.settled();
    await waitFor(() => expect(app.lastFrame()).toContain('Patrol final reply'));
    const transcript = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
    for (const message of ['見回りの途中の文', '見回りの終了前の文']) {
      expect(outputs.mock.calls.map(([output]) => output.message)).not.toContain(message);
      expect(transcript.map((entry) => entry.content)).not.toContain(message);
    }
  } finally { finish.resolve(); await fixture.settled(); }
});

it('keeps already displayed text but suppresses buffered and late text after interruption of the same turn', async () => {
  const finish = deferred<void>();
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: '中断前に表示する文' } });
    options.onStream!({ type: 'tool_use', data: { id: 'before', tool: 'Bash', input: {} } });
    options.onStream!({ type: 'text', data: { text: '中断時に未確定の文' } });
    await finish.promise;
    options.onStream!({ type: 'tool_use', data: { id: 'after', tool: 'Read', input: {} } });
    options.onStream!({ type: 'text', data: { text: '中断後に届く文' } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), structuredOutput: { message: 'Cancelled final reply', summary: null } };
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'interrupt-text', executor });
  const outputs = vi.fn(); client.onOutput(outputs);
  await client.connect(); await complete();
  const app = await snapshotView();
  const transcript = () => vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
  try {
    expect(await client.submit({ kind: 'message', text: 'Interrupt the running turn' })).toMatchObject({ kind: 'accepted' });
    await waitFor(() => expect(transcript()).toContainEqual({ role: 'assistant', content: '中断前に表示する文' }));
    const running = client.getSnapshot().state!.running!;
    expect(await client.submit({ kind: 'abort_turn', operationId: running.operationId, generation: running.generation! })).toMatchObject({ kind: 'accepted' });
    const deliveredBefore = outputs.mock.calls.length;
    finish.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state?.running).toBeNull());
    expect(transcript()).toContainEqual({ role: 'assistant', content: '中断前に表示する文' });
    for (const message of ['中断時に未確定の文', '中断後に届く文', 'Cancelled final reply']) {
      expect(transcript().map((entry) => entry.content)).not.toContain(message);
      expect(outputs.mock.calls.slice(deliveredBefore).map(([output]) => output.message)).not.toContain(message);
    }
    expect(app.lastFrame()).toContain('中断前に表示する文');
  } finally { finish.resolve(); await fixture.settled(); }
});

it.each([false, true])('displays next-turn text once after an interrupted turn with its running state delayed=%s', async (delayed) => {
  const finishFirst = deferred<void>();
  const emitText = deferred<void>();
  const finishNext = deferred<void>();
  const reading = deferred<void>();
  const releaseRunning = deferred<void>();
  const message = '次のターンを調べています。';
  execute.mockImplementationOnce(async (input) => {
    input.onText!('中断前に表示する文');
    await finishFirst.promise;
    return { message: 'Interrupted reply', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  execute.mockImplementationOnce(async (input) => {
    await emitText.promise;
    input.onText!(message);
    await finishNext.promise;
    return { message: 'Next turn completed', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const outputs = vi.fn(); client.onOutput(outputs);
  await client.connect(); await complete();
  const app = await snapshotView();
  const transcript = () => vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
  const textEntries = () => transcript().filter((entry) => entry.role === 'assistant' && entry.content === message);
  try {
    await client.submit({ kind: 'message', text: 'Start the first turn' });
    await waitFor(() => {
      expect(client.getSnapshot().state?.running).not.toBeNull();
      expect(transcript()).toContainEqual({ role: 'assistant', content: '中断前に表示する文' });
    });
    const first = client.getSnapshot().state!.running!;
    expect(await client.submit({ kind: 'abort_turn', operationId: first.operationId, generation: first.generation! })).toMatchObject({ kind: 'accepted' });
    finishFirst.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state).toMatchObject({ running: null, interrupted: true }));
    await waitFor(() => expect(app.lastFrame()).toContain('Turn interrupted'));

    const snapshot = fixture.dispatcher.snapshot.bind(fixture.dispatcher);
    vi.spyOn(fixture.dispatcher, 'snapshot').mockImplementationOnce(async (id) => {
      const read = await snapshot(id);
      reading.resolve();
      await releaseRunning.promise;
      return read;
    });
    const accepted = await client.submit({ kind: 'message', text: 'Start the next turn' });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Turn was not accepted');
    await reading.promise;
    if (!delayed) {
      releaseRunning.resolve();
      await waitFor(() => expect(client.getSnapshot().state?.running?.operationId).toBe(accepted.operationId));
    }
    emitText.resolve();
    await waitFor(() => expect(outputs).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'turn_text', operationId: accepted.operationId, message,
    })));
    if (delayed) expect(client.getSnapshot().state).toMatchObject({ running: null, interrupted: true });
    await waitFor(() => expect(textEntries()).toEqual([{ role: 'assistant', content: message }]));
    releaseRunning.resolve();
    await waitFor(() => expect(client.getSnapshot().state?.running?.operationId).toBe(accepted.operationId));
    expect(textEntries()).toHaveLength(1);
    finishNext.resolve(); await fixture.settled();
    await waitFor(() => expect(app.lastFrame()).toContain('Next turn completed'));
    expect(textEntries()).toHaveLength(1);
    expect(transcript()).toContainEqual({ role: 'assistant', content: '中断前に表示する文' });
    expect(transcript().findIndex((entry) => entry.content === message))
      .toBeLessThan(transcript().findIndex((entry) => entry.content === 'Next turn completed'));
  } finally {
    finishFirst.resolve(); emitText.resolve(); releaseRunning.resolve(); finishNext.resolve(); await fixture.settled();
  }
});

it.each([false, true])('preserves next-turn text while settling with a snapshot before text delivery=%s', async (refreshBeforeText) => {
  const finishFirst = deferred<void>();
  const emitText = deferred<void>();
  const finishNext = deferred<void>();
  const deliveringText = deferred<void>();
  const releaseText = deferred<void>();
  const finished = deferred<void>();
  const message = '次のターンを調べています。';
  execute.mockImplementationOnce(async (input) => {
    input.onText!('中断前に表示する文');
    await finishFirst.promise;
    return { message: 'Interrupted reply', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  execute.mockImplementationOnce(async (input) => {
    await emitText.promise;
    input.onText!(message);
    await finishNext.promise;
    return { message: 'Next turn completed', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const outputs = vi.fn(); client.onOutput(outputs);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const transcript = () => vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
  const assistantEntries = () => transcript().filter((entry) => entry.role === 'assistant');
  await waitFor(() => expect(assistantEntries()).toHaveLength(1));
  const initialEntries = [...assistantEntries()];
  const id = client.getSnapshot().state!.conversationId;
  const readState = async () => {
    const read = await fixture.dispatcher.snapshot(id);
    try {
      for await (const item of read.items) {
        if (item.kind === 'state') return { operationId: read.operationId, state: item.state };
      }
      throw new Error('Snapshot state was not delivered');
    } finally { read.cancel(); }
  };
  try {
    await client.submit({ kind: 'message', text: 'Start the first turn' });
    await waitFor(() => {
      expect(client.getSnapshot().state?.running).not.toBeNull();
      expect(assistantEntries()).toEqual([...initialEntries, { role: 'assistant', content: '中断前に表示する文' }]);
    });
    const first = client.getSnapshot().state!.running!;
    expect(await client.submit({ kind: 'abort_turn', operationId: first.operationId, generation: first.generation! })).toMatchObject({ kind: 'accepted' });
    finishFirst.resolve(); await fixture.settled();
    await waitFor(() => expect(client.getSnapshot().state).toMatchObject({ running: null, interrupted: true }));
    await waitFor(() => expect(app.lastFrame()).toContain('Turn interrupted'));
    expect((await readState()).state).toMatchObject({ running: null, interrupted: true });

    const deliver = service.deliver.bind(service);
    vi.spyOn(service, 'deliver').mockImplementation(async (conversationId, output, version, signal) => {
      if (output.kind === 'turn_text' && output.message === message) {
        deliveringText.resolve();
        await releaseText.promise;
      }
      await deliver(conversationId, output, version, signal);
    });
    const post = fixture.dispatcher.post.bind(fixture.dispatcher);
    vi.spyOn(fixture.dispatcher, 'post').mockImplementation((event) => {
      const pending = post(event);
      if (event.kind === 'turn_finished') finished.resolve();
      return pending;
    });
    const apply = vi.spyOn(fixture.conversations, 'apply');
    const accepted = await client.submit({ kind: 'message', text: 'Start the next turn' });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Turn was not accepted');
    await waitFor(() => expect(client.getSnapshot().state).toMatchObject({
      running: { operationId: accepted.operationId }, interrupted: false,
    }));
    const started = await readState();
    expect(started.operationId).toBe(accepted.operationId);
    emitText.resolve();
    await deliveringText.promise;
    finishNext.resolve();
    await finished.promise;
    const settling = await readState();
    expect(settling).toMatchObject({ operationId: null, state: { running: { operationId: accepted.operationId } } });
    expect(apply).not.toHaveBeenCalled();
    expect(outputs).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_text', message }));
    expect(assistantEntries()).toEqual([...initialEntries, { role: 'assistant', content: '中断前に表示する文' }]);
    if (refreshBeforeText) await refreshSnapshot(client, connections[0]!);
    const beforeText = client.getSnapshot().state!;
    releaseText.resolve();
    await waitFor(() => expect(outputs).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'turn_text', operationId: accepted.operationId, message,
    })));
    await fixture.settled();
    await waitFor(() => expect(app.lastFrame()).toContain('Next turn completed'));
    if (!refreshBeforeText) await refreshSnapshot(client, connections[0]!);
    expect({
      startedInterrupted: started.state.interrupted,
      settlingInterrupted: settling.state.interrupted,
      clientBeforeText: { operationId: beforeText.running?.operationId ?? null, interrupted: beforeText.interrupted },
      entries: assistantEntries(),
    }).toEqual({
      startedInterrupted: false,
      settlingInterrupted: false,
      clientBeforeText: { operationId: refreshBeforeText ? null : accepted.operationId, interrupted: false },
      entries: [
        ...initialEntries,
        { role: 'assistant', content: '中断前に表示する文' },
        { role: 'assistant', content: message },
        { role: 'assistant', content: 'Next turn completed' },
      ],
    });
    expect(outputs.mock.calls.filter(([output]) => output.kind === 'turn_text' && output.message === message)).toHaveLength(1);
    expect(client.getSnapshot().state).toMatchObject({ running: null, interrupted: false });
  } finally {
    finishFirst.resolve(); emitText.resolve(); finishNext.resolve(); releaseText.resolve(); await fixture.settled();
  }
});

it('shows the latest early activity when a connected TUI finally receives the delayed running state', async () => {
  const reading = deferred<void>();
  const releaseRunning = deferred<void>();
  const finish = deferred<void>();
  const outputs = vi.fn(); client.onOutput(outputs);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const observed = vi.fn();
  const receiver = new ConversationTransferReceiver(client.getSnapshot().state!.conversationId, {
    state: vi.fn(), item: vi.fn(), remove: vi.fn(), output: observed, read: vi.fn(),
  });
  receiver.authenticated();
  const decoder = new frames.ConversationFrameDecoder();
  const transfers = new Set<string>();
  connections[0]!.socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.decode(chunk)) {
      const envelope = frame as { output?: { kind: string; purpose?: string; transferId: string } };
      const output = envelope.output;
      if (output === undefined) continue;
      if (output.kind === 'transfer_start' && output.purpose === 'output') transfers.add(output.transferId);
      if (transfers.has(output.transferId)) receiver.receive(frame);
      if (output.kind === 'transfer_end' || output.kind === 'transfer_error') transfers.delete(output.transferId);
    }
  });
  const snapshot = fixture.dispatcher.snapshot.bind(fixture.dispatcher);
  vi.spyOn(fixture.dispatcher, 'snapshot').mockImplementationOnce(async (id) => {
    const read = await snapshot(id);
    reading.resolve();
    await releaseRunning.promise;
    return read;
  });
  execute.mockImplementationOnce(async (input) => {
    input.onActivity!({ kind: 'thinking' });
    input.onActivity!({ kind: 'tool', tool: 'EarlyTool' });
    await finish.promise;
    return { message: 'Early activity turn completed', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  try {
    const accepted = await client.submit({ kind: 'message', text: 'Start with delayed running' });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Turn was not accepted');
    await reading.promise;
    await waitFor(() => expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'activity', activity: { kind: 'tool', tool: 'EarlyTool' },
    }), expect.anything()));
    expect(client.getSnapshot().state!.running).toBeNull();
    expect(outputs.mock.calls.filter(([output]) => output.kind === 'activity')).toEqual([]);
    expect(app.lastFrame()).not.toContain('EarlyTool');

    releaseRunning.resolve();

    await waitFor(() => expect(app.lastFrame()).toContain('EarlyTool'));
    expect(outputs.mock.calls.filter(([output]) => output.kind === 'activity')).toEqual([[expect.objectContaining({
      operationId: accepted.operationId, activity: { kind: 'tool', tool: 'EarlyTool' },
    })]]);
    finish.resolve();
    await fixture.settled();
    await waitFor(() => {
      expect(app.lastFrame()).toContain('Early activity turn completed');
      expect(app.lastFrame()).not.toContain('EarlyTool');
    });
  } finally { releaseRunning.resolve(); finish.resolve(); await fixture.settled(); }
});

it('restores current activity for a late TUI and after reconnect, then forgets it when the turn ends', async () => {
  const finish = deferred<void>();
  const readingThinking = deferred<void>();
  const releaseThinking = deferred<void>();
  let holdThinking = false;
  const read = fixture.store.read.bind(fixture.store);
  vi.spyOn(fixture.store, 'read').mockImplementation(async (id) => {
    if (holdThinking) {
      holdThinking = false;
      readingThinking.resolve();
      await releaseThinking.promise;
    }
    return read(id);
  });
  execute.mockImplementationOnce(async (input) => {
    holdThinking = true;
    input.onActivity!({ kind: 'thinking' });
    input.onActivity!({ kind: 'tool', tool: 'ReconnectTool' });
    await finish.promise;
    return { message: 'Reconnected turn completed', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const beforeTurn = Date.now();
  await client.submit({ kind: 'message', text: 'Start before attaching' });
  await fixture.executing(1);
  await readingThinking.promise;
  await waitFor(() => expect(client.getSnapshot().state?.running?.startedAt).toBeGreaterThanOrEqual(beforeTurn));
  const startedAt = client.getSnapshot().state!.running!.startedAt;
  expect(startedAt).toBeLessThanOrEqual(Date.now());
  client.close();
  client = new ConversationIpcClient(assignment, { provider: 'mock' });
  const outputs = vi.fn();
  client.onOutput(outputs);
  const activities = () => outputs.mock.calls.map(([output]) => output).filter((output) => output.kind === 'activity');
  try {
    await client.connect(); await complete();
    expect(client.getSnapshot().state?.running?.startedAt).toBe(startedAt);
    await waitFor(() => expect(activities()).toHaveLength(1));
    expect(activities()[0]).toMatchObject({ activity: { kind: 'tool', tool: 'ReconnectTool' } });
    releaseThinking.resolve();
    await fixture.dispatcher.drain();
    expect(activities()).toHaveLength(1);
    // 接続完了後にマウントしても、初期配送の現在値を表示できる。
    const app = await snapshotView();
    await waitFor(() => expect(app.lastFrame()).toContain('ReconnectTool'));
    await client.refresh(); await complete();
    expect(client.getSnapshot().state?.running?.startedAt).toBe(startedAt);
    expect(activities()).toHaveLength(1);
    connections[1]!.socket.destroy();
    await waitFor(() => expect(activities()).toHaveLength(2));
    await waitFor(() => {
      expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
      expect(client.getSnapshot().state?.running?.startedAt).toBe(startedAt);
      expect(app.lastFrame()).toContain('ReconnectTool');
    });
    finish.resolve();
    await fixture.settled();
    await waitFor(() => {
      expect(app.lastFrame()).toContain('Reconnected turn completed');
      expect(app.lastFrame()).not.toContain('ReconnectTool');
    });
    connections[2]!.socket.destroy();
    await waitFor(() => expect(connections).toHaveLength(4));
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }));
    expect(activities()).toHaveLength(2);
    expect(app.lastFrame()).not.toContain('ReconnectTool');
  } finally { releaseThinking.resolve(); finish.resolve(); await fixture.settled(); }
});

it('restores cached activity after an initial transfer fails and a snapshot retry succeeds', async () => {
  const finish = deferred<void>();
  execute.mockImplementationOnce(async (input) => {
    input.onActivity!({ kind: 'tool', tool: 'RetriedTool' });
    await finish.promise;
    return { message: 'Retried turn completed', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const originalOutputs = vi.fn();
  client.onOutput(originalOutputs);
  await client.connect(); await complete();
  await client.submit({ kind: 'message', text: 'Start before failed attachment' });
  try {
    await waitFor(() => expect(originalOutputs).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'activity', activity: { kind: 'tool', tool: 'RetriedTool' },
    })));
    client.close();
    const write = frames.writeConversationFrame;
    let failed = false;
    vi.spyOn(frames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
      const envelope = value as { output?: { kind: string } };
      if (!failed && envelope.output?.kind === 'transfer_end') {
        failed = true;
        throw new Error('Initial snapshot write failed');
      }
      return write(socket, value);
    });
    client = new ConversationIpcClient(assignment, { provider: 'mock' });
    const outputs = vi.fn();
    client.onOutput(outputs);
    await client.connect();
    await waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'incomplete' }));
    expect(outputs).not.toHaveBeenCalled();
    await client.refresh(); await complete();
    await waitFor(() => expect(outputs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'activity', activity: { kind: 'tool', tool: 'RetriedTool' },
    })));
    const app = await snapshotView();
    await waitFor(() => expect(app.lastFrame()).toContain('RetriedTool'));
    await client.refresh(); await complete();
    expect(outputs).toHaveBeenCalledOnce();
    finish.resolve();
    await fixture.settled();
    await waitFor(() => {
      expect(app.lastFrame()).toContain('Retried turn completed');
      expect(app.lastFrame()).not.toContain('RetriedTool');
    });
  } finally { finish.resolve(); await fixture.settled(); }
});

it('shows a goal event reply once while connected and does not copy it to workLog', async () => {
  const goal = goalRecord();
  saveGoal(goal);
  const message = 'Goal event reply';
  execute.mockResolvedValueOnce({ message, summary: null, sessionId: 'event-session', assignment });
  const connections = observeIpcConnections();
  const outputs = vi.fn();
  client.onOutput(outputs);
  await client.connect(); await complete();
  await snapshotView();
  const observation = connections[0]!;
  const previous = observation.snapshots.length;
  const refreshMarker = 'Goal notification after connecting';
  // スナップショットの転送と、その内容の画面への反映を両方待つための通知。
  saveGoal({ ...goal, notifications: [{ id: randomUUID(), kind: 'custom', body: refreshMarker, recordedAt: new Date().toISOString() }] });

  expect(await fixture.dispatcher.accept({ eventId: randomUUID(), requestId: randomUUID(),
    conversationId: conversationRecord(repository).id, source: 'daemon', occurredAt: new Date().toISOString(),
    event: { kind: 'goal_registered', repositoryDirectory: repository, goalId: goal.id } })).toMatchObject({ kind: 'accepted' });
  await fixture.settled();
  await waitFor(() => expect(outputs).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message } })));
  await waitFor(() => {
    expect(observation.snapshots.length).toBeGreaterThan(previous);
    expect(observation.snapshots.at(-1)!.complete).toBe(true);
  });
  await waitFor(() => {
    const entries = vi.mocked(transcriptView.TranscriptView).mock.lastCall![0].entries;
    expect(entries.some((entry) => entry.content.includes(refreshMarker))).toBe(true);
    expect(entries.filter((entry) => entry.content.includes(message))).toHaveLength(1);
  });
  expect((await new GoalStore(repository).get(goal.id)).workLog).toEqual([]);
  expect(execute).toHaveBeenCalledOnce();
});

it.each([
  { size: 'short', text: 'Keep reading while this request is admitted' },
  { size: 'larger than an input batch', text: 'x'.repeat(16 * 1024) },
])('starts both snapshots independently while a $size message response is pending', async ({ text }) => {
  const second = new ConversationIpcClient(assignment, { provider: 'mock' });
  const pendingReads: Promise<SnapshotRead>[] = [];
  try {
    await client.connect(); await complete(); await second.connect();
    await vi.waitFor(() => expect(second.getSnapshot().readStatus).toBe('complete'));
    const released = gate(); const submitted = gate(); const readsEntered = gate();
    let reads = 0;
    vi.spyOn(service, 'submit').mockImplementationOnce(async () => {
      submitted.release(); await released.promise;
      return { kind: 'accepted', operationId: randomUUID() };
    });
    const snapshot = service.snapshot.bind(service);
    vi.spyOn(service, 'snapshot').mockImplementation((id) => {
      const reading = snapshot(id).then(async (read) => {
        if (++reads >= 2) readsEntered.release();
        await released.promise; return read;
      });
      pendingReads.push(reading); return reading;
    });
    try {
      const message = client.submit({ kind: 'message', text });
      await submitted.promise;
      const snapshots = [client.refresh(), second.refresh()];
      await readsEntered.promise;
      released.release();
      await expect(Promise.all([message, ...snapshots])).resolves.toEqual([
        { kind: 'accepted', operationId: expect.any(String) }, undefined, undefined,
      ]);
    } finally { released.release(); }
    await complete();
    expect(second.getSnapshot().connection).toBe('connected');
  } finally { await Promise.allSettled(pendingReads); second.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function heldRead(read: SnapshotRead, entered: ReturnType<typeof gate>, released: ReturnType<typeof gate>): SnapshotRead {
  return { ...read, items: (async function* () {
    let held = false;
    for await (const item of read.items) {
      yield item;
      if (!held) { held = true; entered.release(); await released.promise; }
    }
    if (!held) { entered.release(); await released.promise; }
  })() };
}

function captureAndStopPolling() {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  return async () => {
    await vi.waitFor(() => expect(intervals.mock.calls.some(([, milliseconds]) => milliseconds === 500)).toBe(true));
    for (const [index, [, milliseconds]] of intervals.mock.calls.entries()) {
      if (milliseconds === 500) clearInterval(intervals.mock.results[index]!.value as ReturnType<typeof setInterval>);
    }
  };
}

it('connects to the current daemon when the previous daemon stops during assignment resolution', async () => {
  client.close();
  let expired = false;
  let restarted = false;
  const port = createTuiConversationPort(directory, { deliver: async () => ({ kind: 'unavailable', reason: 'IPC only' }) });
  doubles.ensure.mockImplementationOnce(async () => {
    if (expired) {
      await writeDaemonOwner(directory, owner);
      server = await createConversationIpcServer(directory, owner, service);
      restarted = true;
    }
    const socket = await connectConversationIpc(directory, owner);
    if (socket === undefined) throw new Error('Daemon IPC readiness failed');
    return socket;
  });
  client = new ConversationIpcClient(assignment, undefined, { reconnect: false, port: { ...port, async resolve(selected) {
    const resolved = await port.resolve(selected);
    await server.close();
    await removeDaemonOwner(directory, owner, { signal: new AbortController().signal, timeoutMs: 5000 });
    expired = true;
    return resolved;
  } } });
  try {
    await client.connect();
    await complete();
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', state: { pending: { revision: 4 } } });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    if (expired && !restarted) {
      await writeDaemonOwner(directory, owner);
      server = await createConversationIpcServer(directory, owner, service);
    }
  }
});

it('regenerates with /make-goal on the same screen and registers the new proposal only with Up and Enter', async () => {
  const outputs: unknown[] = []; client.onOutput((output) => outputs.push(output));
  const summary = { objective: 'Replacement JSON export', outOfScope: ['CSV'], acceptanceCriteria: ['JSON exists'], constraints: [] };
  const generate = vi.fn(async (_input: ManagerTurnInput) => ({ message: 'Replacement ready', summary, sessionId: 'session', assignment }));
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute: generate } });
  const registration = vi.spyOn(goalService, 'registerReservedGoal');
  await client.connect(); await complete();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => expect(app.lastFrame()).toContain('CSV出力'));
  const submissions = vi.spyOn(client, 'submit');
  let draft = '';
  for (const character of '/make-goal') {
    draft += character;
    app.stdin.write(character);
    await waitFor(() => expect(app.lastFrame()).toContain('❯ ' + draft));
  }
  app.stdin.write('\r');
  await waitFor(() => expect(submissions.mock.calls.map(([command]) => command)).toEqual([
    { kind: 'message', text: getLabel('manager.goSummaryRequest', 'en'), display: false },
  ]));
  await expect(submissions.mock.results[0]!.value).resolves.toMatchObject({ kind: 'accepted' });
  await fixture.settled();
  expect(generate).toHaveBeenCalledOnce();
  await waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'Replacement ready' } })));
  await waitFor(() => {
    expect(client.getSnapshot().state).toMatchObject({ pending: { revision: 5, summary }, approval: null, running: null });
    expect(app.lastFrame()!.split(summary.objective)).toHaveLength(2);
    expect(app.lastFrame()!.split('CSV出力')).toHaveLength(2);
    expect(client.getSnapshot().state).toMatchObject({ pending: { revision: 5, summary }, approval: null, running: null });
  });
  const record = conversationRecord(repository);
  expect((await new ConversationStateStore(directory).read(record.id))?.record).toMatchObject({
    pending: { revision: 5, summary }, approval: null, running: null,
  });
  expect(humanTurnText(generate.mock.calls[0]![0].prompt)).toBe(getLabel('manager.goSummaryRequest', 'en'));
  expect(registration).not.toHaveBeenCalled();
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  registration.mockImplementation(async ({ id, objective, outOfScope, acceptanceCriteria, constraints }) => {
    const goal = { ...goalRecord(), id, objective, outOfScope, acceptanceCriteria, constraints }; saveGoal(goal); return goal;
  });
  app.stdin.write('\x1b[A');
  app.stdin.write('\r');
  await waitFor(async () => expect((await new ConversationStateStore(directory).read(record.id))?.record?.approval)
    .toMatchObject({ revision: 5, state: 'registered' }));
  const receipt = (await new ConversationStateStore(directory).read(record.id))?.record!.approval!;
  const goals = (await new GoalStore(repository).list()).goals;
  expect(goals).toHaveLength(1);
  expect(await new GoalStore(repository).get(receipt.goalId)).toMatchObject(summary);
  expect(registration).toHaveBeenCalledOnce();
});

it.each(['response', 'transfer'] as const)('approves the displayed proposal once while a background %s is held', async (phase) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  await client.connect(); await complete();
  const entered = gate(); const released = gate();
  const snapshot = service.snapshot.bind(service);
  vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
    const read = await snapshot(id);
    if (phase === 'transfer') return heldRead(read, entered, released);
    entered.release(); await released.promise; return read;
  });
  const registration = vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async ({ id, objective, outOfScope, acceptanceCriteria, constraints }) => {
    const goal = { ...goalRecord(), id, objective, outOfScope, acceptanceCriteria, constraints }; saveGoal(goal); return goal;
  });
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.summaryInputHint', 'en').replace(/\s/gu, ''));
  });
  const submissions = vi.spyOn(client, 'submit');
  const refreshing = client.refresh();
  try {
    await entered.promise;
    await waitFor(() => expect(service.snapshot).toHaveBeenCalled());
    expect.soft(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect.soft(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.summaryInputHint', 'en').replace(/\s/gu, ''));
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledExactlyOnceWith({ kind: 'approve_summary', revision: 4 }, undefined));
    expect(connection.mock.calls.filter(([bytes]) => String(bytes).includes('"kind":"approve_summary"'))).toHaveLength(1);
    // The server finishes the current input batch before accepting another one.
    if (phase === 'response') released.release();
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
    const record = conversationRecord(repository);
    await waitFor(async () => expect((await new ConversationStateStore(directory).read(record.id))?.record?.approval)
      .toMatchObject({ revision: 4, state: 'registered' }));
    expect(registration).toHaveBeenCalledOnce();
  } finally { released.release(); await refreshing.catch(() => {}); app.unmount(); }
});

it('does not send approval before the initial transfer ends and enables it on the same screen after completion', async () => {
  const entered = gate(); const released = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    const opened = await open(...args);
    return { ...opened, read: heldRead(opened.read, entered, released) };
  });
  await client.connect();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  const submissions = vi.spyOn(client, 'submit');
  try {
    await entered.promise;
    await waitFor(() => {
      expect(app.lastFrame()).toContain('CSV出力');
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
    });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(client.getSnapshot().readStatus).not.toBe('complete');
    released.release(); await complete();
    await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.summaryInputHint', 'en').replace(/\s/gu, ''));
  });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    expect(submissions.mock.calls[0]![0]).toEqual({ kind: 'approve_summary', revision: 4 });
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
  } finally { released.release(); app.unmount(); }
});

it.each(['read failure', 'disconnect'] as const)('blocks approval after a background %s until a fresh transfer completes on the same screen', async (failure) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  await client.connect(); await complete();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.summaryInputHint', 'en').replace(/\s/gu, ''));
  });
  const submissions = vi.spyOn(client, 'submit');
  const entered = gate(); const released = gate();
  let refreshing: Promise<void> | undefined;
  try {
    if (failure === 'read failure') {
      const goal = goalRecord(); saveGoal(goal);
      writeFileSync(join(repository, '.takt', 'goals', goal.id, 'goal.json'), '{broken');
      await Promise.allSettled([client.refresh()]);
      await waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
      saveGoal(goal);
      const snapshot = service.snapshot.bind(service);
      vi.spyOn(service, 'snapshot').mockImplementation(async (id) => heldRead(await snapshot(id), entered, released));
      refreshing = client.refresh();
    } else {
      const open = service.open.bind(service);
      vi.spyOn(service, 'open').mockImplementation(async (...args) => {
        const opened = await open(...args);
        return { ...opened, read: heldRead(opened.read, entered, released) };
      });
      const index = connection.mock.calls.findIndex(([bytes]) => String(bytes).includes('"method":"open"'));
      (connection.mock.contexts[index] as net.Socket).destroy();
    }
    await entered.promise;
    await waitFor(() => {
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
      expect(app.lastFrame()).toContain('CSV出力');
    });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(client.getSnapshot().readStatus).not.toBe('complete');
    released.release(); await refreshing; await complete();
    await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.summaryInputHint', 'en').replace(/\s/gu, ''));
  });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    expect(submissions.mock.calls[0]![0]).toEqual({ kind: 'approve_summary', revision: 4 });
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
  } finally { released.release(); await refreshing?.catch(() => {}); app.unmount(); }
});

it.each([
  { kind: 'approve_summary', concurrent: false }, { kind: 'approve_summary', concurrent: true },
  { kind: 'dismiss_summary', concurrent: false }, { kind: 'dismiss_summary', concurrent: true },
] as const)('restores a complete latest proposal after stale $kind (concurrent refresh: $concurrent)', async ({ kind, concurrent }) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  const notifications = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation((input, delivery) => open(input, {
    deliver: async (...args) => { await notifications.promise; return delivery.deliver(...args); },
  }));
  const pending = { ...conversationRecord(repository).pending!, revision: 5,
    summary: { objective: 'Latest proposal five', outOfScope: [], acceptanceCriteria: ['Latest accepted'], constraints: [] } };
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: {
    execute: async () => ({ message: 'updated', summary: pending.summary, sessionId: 'session', assignment }),
  } });
  const registration = vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async ({ id }) => {
    const goal = { ...goalRecord(), ...pending.summary, id }; saveGoal(goal); return goal;
  });
  const trace: Array<{ kind: string; transferId?: string; requestId?: string }> = [];
  const write = frames.writeConversationFrame;
  vi.spyOn(frames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const frame = value as { type: string; requestId?: string; result?: { read?: { transferId: string } }; output?: { kind: string; transferId: string } };
    trace.push({ kind: frame.output?.kind ?? frame.type, requestId: frame.requestId,
      transferId: frame.output?.transferId ?? frame.result?.read?.transferId });
    return write(socket, value);
  });
  const transferFrames = frames.conversationTransferFrames;
  vi.spyOn(frames, 'conversationTransferFrames').mockImplementation((id, metadata, ...args) => {
    const iterator = transferFrames(id, metadata, ...args);
    const stop = iterator.return.bind(iterator);
    iterator.return = (value) => { trace.push({ kind: 'cancel', transferId: metadata.transferId }); return stop(value); };
    return iterator;
  });
  const reads: Array<{ read: SnapshotRead; release(): void }> = [];
  const snapshot = service.snapshot.bind(service);
  let app: ReturnType<typeof render> | undefined;
  try {
    await client.connect(); await complete();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
    await waitFor(() => expect(app!.lastFrame()).toContain('CSV出力'));
    // この競合は明示 refresh だけを入力とし、定期 refresh は停止して比較する。
    for (const [index, [, milliseconds]] of intervals.mock.calls.entries()) {
      if (milliseconds === 500) clearInterval(intervals.mock.results[index]!.value as ReturnType<typeof setInterval>);
    }
    const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
    const other = await open(selected, { deliver: async () => ({ kind: 'delivered' }) });
    await other.read.items[Symbol.asyncIterator]().return?.();
    await service.submit({ attachmentId: other.attachmentId, requestId: randomUUID(), speaker: selected.speaker,
      command: { kind: 'message', text: 'Produce the next proposal' } });
    await waitFor(async () => expect((await fixture.store.read(selected.conversationId))?.record).toMatchObject({ pending, running: null }));
    expect(client.getSnapshot().state?.pending?.revision).toBe(4);
    vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
      const read = await snapshot(id); const wait = gate(); reads.push({ read, release: wait.release });
      await wait.promise; trace.push({ kind: 'snapshot_resolved', transferId: read.transferId }); return read;
    });
    const openWrite = connection.mock.calls.findIndex(([bytes]) => String(bytes).includes('"method":"open"'));
    const socket = connection.mock.contexts[openWrite] as net.Socket;
    const submissions = vi.spyOn(client, 'submit');
    if (concurrent) socket.cork();
    if (kind === 'approve_summary') { app.stdin.write('\x1b[A'); app.stdin.write('\r'); }
    else app.stdin.write('\x1b[27u');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    let refreshed: Promise<void> | undefined;
    if (concurrent) { refreshed = client.refresh(); socket.uncork(); }
    const stale = await submissions.mock.results[0]!.value;
    expect(stale).toMatchObject({ kind: 'error', code: 'stale_summary' });
    refreshed ??= client.refresh();
    await waitFor(() => expect(reads).toHaveLength(1));
    expect((await fixture.store.read(selected.conversationId))?.record).toMatchObject({ pending, approval: null, running: null });
    expect(registration).not.toHaveBeenCalled();
    reads[0]!.release();
    await refreshed;
    await complete();
    await waitFor(() => expect(app!.lastFrame()).toContain(pending.summary.objective));
    expect(client.getSnapshot().state?.pending).toEqual(pending);
    const transferId = reads[0]!.read.transferId;
    const transfer = trace.filter((entry) => entry.transferId === transferId).map(({ kind }) => kind);
    expect(transfer.indexOf('response')).toBeGreaterThanOrEqual(0);
    expect(transfer.indexOf('response')).toBeLessThan(transfer.indexOf('transfer_start'));
    expect(transfer.indexOf('transfer_start')).toBeLessThan(transfer.indexOf('transfer_end'));
    expect(transfer).not.toContain('cancel');
    expect(submissions.mock.calls.map(([command]) => command)).toEqual([{ kind, revision: 4 }]);
    expect((await fixture.store.read(selected.conversationId))?.record?.approval).toBeNull();
    expect(registration).not.toHaveBeenCalled();
    expect((await new GoalStore(repository).list()).goals).toEqual([]);
    if (kind === 'approve_summary') { app.stdin.write('\x1b[A'); app.stdin.write('\r'); }
    else app.stdin.write('\x1b[27u');
    await waitFor(() => expect(submissions).toHaveBeenCalledTimes(2));
    expect(submissions.mock.calls[1]![0]).toEqual({ kind, revision: 5 });
    expect(await submissions.mock.results[1]!.value).toMatchObject({ kind: 'accepted' });
    await waitFor(async () => expect((await fixture.store.read(selected.conversationId))?.record).toMatchObject({ pending: null, running: null }));
    if (kind === 'approve_summary') {
      const receipt = (await fixture.store.read(selected.conversationId))!.record.approval!;
      expect(receipt).toMatchObject({ revision: 5, state: 'registered' });
      expect((await new GoalStore(repository).get(receipt.goalId)).objective).toBe(pending.summary.objective);
      expect(registration).toHaveBeenCalledOnce();
    } else {
      expect((await fixture.store.read(selected.conversationId))?.record?.approval).toBeNull();
      expect((await new GoalStore(repository).list()).goals).toEqual([]);
      expect(registration).not.toHaveBeenCalled();
    }
  } finally {
    app?.unmount();
    for (const read of reads) read.release();
    notifications.release();
  }
});
async function displayedSelection(key: string, kind: 'answer' | 'goal') {
  const stopPolling = captureAndStopPolling();
  const component = vi.spyOn(selectionDialog, 'ManagerSelectionDialog');
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment,
    initialDiagnostics: [], onExit() {} }));
  await stopPolling();
  let readCompleted = false;
  const unsubscribe = client.subscribe(() => {
    if (client.getSnapshot().readStatus === 'complete') readCompleted = true;
  });
  try {
    app.stdin.write(key);
    await waitFor(() => expect(component.mock.calls.some(([props]) => props.selection.kind === kind)).toBe(true));
    await waitFor(() => expect(readCompleted).toBe(true));
  } finally {
    unsubscribe();
    await stopPolling();
  }
  return { selection: [...component.mock.calls].reverse().find(([props]) => props.selection.kind === kind)![0].selection,
    frame: () => app.lastFrame() };
}

it('re-resolves an invalidated repository attachment into its new workspace without replaying a rejected mutation', async () => {
  await client.connect(); await complete();
  const original = client.getSnapshot().state!.conversationId;
  assignment = { kind: 'workspace', workspaceId: randomUUID(), name: 'Promoted workspace', repositoryDirectories: [repository] };
  doubles.assignment.mockResolvedValue(assignment);
  const rejected = await client.submit({ kind: 'message', text: 'Do not replay this request' });
  expect(rejected).toMatchObject({ kind: 'error', code: 'invalid_assignment' });
  await complete();
  expect(client.getSnapshot().state?.conversationId).not.toBe(original);
  expect(client.getSnapshot().state?.assignment).toEqual({ kind: 'workspace', workspaceId: assignment.workspaceId });
  expect(client.getSnapshot().items).toContainEqual({ kind: 'assignment', assignment });
  expect(execute).not.toHaveBeenCalled();
  expect(service.attachmentCount).toBe(1);
});

it('retains the corrupt-record diagnostic and incomplete status until a repaired read completes on the same client', async () => {
  const goal = goalRecord();
  saveGoal(goal);
  const file = join(repository, '.takt', 'goals', goal.id, 'goal.json');
  writeFileSync(file, '{broken');
  await client.connect();
  await waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
  expect(client.getSnapshot().connection).toBe('connected');
  expect(client.getSnapshot().state?.pending?.revision).toBe(4);
  expect(client.getSnapshot().items).toContainEqual({ kind: 'display_event', event: expect.objectContaining({
    message: expect.stringContaining(file),
  }) });
  saveGoal(goal);
  await client.refresh(); await complete();
  expect(client.getSnapshot().items.filter((item) => item.kind === 'goal')).toEqual([
    { kind: 'goal', goal: { id: goal.id, objective: goal.objective, status: goal.status,
      executionStatus: goal.executionStatus, awaitingHumanMerge: false, repositoryDirectory: repository } },
  ]);
  expect(client.getSnapshot().items.some((item) => item.kind === 'display_event' && item.event.message.includes(file))).toBe(false);
});

it.each([7, 9])('restores every pending constraint for %i large entries through the production receiver', async (count) => {
  const record = conversationRecord(repository);
  record.pending!.summary.constraints = Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a'));
  writeLegacyConversation(directory, record);
  await client.connect(); await complete();
  expect(client.getSnapshot().state).toMatchObject({ conversationId: record.id, revision: 4, pending: record.pending });
  const component = vi.mocked(transcriptView.TranscriptView);
  render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => {
    const entries = component.mock.calls.at(-1)![0].entries.filter((entry) => entry.content.includes(record.pending!.summary.objective));
    expect(entries).toHaveLength(1);
    for (const value of record.pending!.summary.constraints) expect(entries[0]!.content).toContain(value);
  });
  expect((await new ConversationStateStore(directory).read(record.id))?.record?.pending).toEqual(record.pending);
});

it.each([7, 9])('restores the exact IDs, order and objectives of %i large goals through the production receiver', async (count) => {
  const goals = Array.from({ length: count }, (_, index) => ({ ...goalRecord(),
    id: String(index + 1).padStart(8, '0') + '-1111-4111-8111-111111111111', objective: String(index).padEnd(128 * 1024, 'a') }));
  for (const goal of [...goals].reverse()) saveGoal(goal);
  await client.connect(); await complete();
  expect(client.getSnapshot().items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []))
    .toEqual(goals.map(({ id, objective, status, executionStatus }) => ({ id, objective, status, executionStatus, awaitingHumanMerge: false, repositoryDirectory: repository })));
  const { selection } = await displayedSelection('\x07', 'goal');
  if (selection.kind !== 'goal') throw new Error('Expected goal selection');
  expect(selection.candidates).toEqual(goals.map(({ id, objective, status, executionStatus }) => ({
    id, objective, status, executionStatus, awaitingHumanMerge: false, repositoryDirectory: repository,
  })));
});

it.each([7, 9])('restores every option created by the real question operation for %i large options', async (count) => {
  const goal = goalRecord(); saveGoal(goal);
  const options = Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a'));
  const producer = await askTaktGoalQuestion({ cwd: repository, goalId: goal.id, body: 'Choose', options }, {}, new AbortController().signal);
  expect(producer.isError).not.toBe(true);
  const saved = (await new GoalStore(repository).get(goal.id)).questions![0]!;
  await client.connect(); await complete();
  expect(client.getSnapshot().items.filter((item) => item.kind === 'inquiry')).toEqual([{ kind: 'inquiry', inquiry: {
    target: { goalId: goal.id, repositoryDirectory: repository }, question: saved, objective: goal.objective,
  } }]);
  const { selection } = await displayedSelection('\x12', 'answer');
  if (selection.kind !== 'answer') throw new Error('Expected inquiry selection');
  expect(selection.candidates).toEqual([{ goalId: goal.id, repositoryDirectory: repository, objective: goal.objective, question: saved }]);
});

it('removes the same standalone approval after withdrawal and refresh on the same client', async () => {
  const connections = observeIpcConnections();
  const inquiry = await new StandaloneInquiryStore(directory, { kind: 'repository', repositoryDirectory: repository }).create({ body: 'Please confirm the operation' });
  await client.connect(); await complete();
  const inquiries = () => client.getSnapshot().items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry] : []);
  expect(inquiries()).toEqual([{ target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: repository } }, question: inquiry }]);
  const { selection, frame } = await displayedSelection('\x12', 'answer');
  if (selection.kind !== 'answer') throw new Error('Expected inquiry selection');
  expect(selection.candidates).toEqual([{ goalId: null, owner: { kind: 'repository', repositoryDirectory: repository }, question: inquiry }]);
  await waitFor(() => expect(frame()).toContain(inquiry.body));
  await vi.waitFor(() => expect(connections[0]!.snapshots.at(-1)!.complete).toBe(true), { timeout: 10_000 });
  await new StandaloneInquiryStore(directory, assignment).withdraw(inquiry.id);
  await refreshSnapshot(client, connections[0]!);
  expect(inquiries()).toEqual([]);
  await waitFor(() => expect(frame()).not.toContain(inquiry.body));
});

it('forwards attachment overrides into the daemon runtime and delivers the completed operation result', async () => {
  const output = vi.fn(); client.onOutput(output);
  await client.connect(); await complete();
  const result = await client.submit({ kind: 'message', text: 'continue' });
  expect(result.kind).toBe('accepted');
  await waitFor(() => expect(output).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'finished' } })));
  expect(doubles.resolve).toHaveBeenCalledWith(assignment, expect.any(AbortSignal), { provider: 'mock', model: 'chosen-model' });
  expect(execute.mock.calls.map(([input]) => humanTurnText(input.prompt))).toContain('continue');
  expect(client.getSnapshot().state).toMatchObject({ running: null, revision: 5 });
});

it('uses the explicit provider when opening even if the default provider plan is unavailable', async () => {
  doubles.plan.mockImplementation((_cwd: string, overrides: { provider?: string }) => {
    if (overrides.provider !== 'mock') throw new Error('Default provider plan is unavailable');
    return { ctx: { providerType: 'mock' } };
  });
  await client.connect(); await complete();
  expect(client.getSnapshot()).toMatchObject({ connection: 'connected', state: { conversationId: conversationRecord(repository).id } });
  expect(doubles.plan).not.toHaveBeenCalled();
});

interface ReceivedSnapshot {
  transferId: string;
  items: SnapshotItem[];
  complete: boolean;
}

function observeIpcConnections() {
  const connections: Array<{ socket: net.Socket; bytes: number; snapshots: ReceivedSnapshot[]; failures: number }> = [];
  const connect = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation((path, listener) => {
    const socket = connect(path, listener);
    const observation = { socket, bytes: 0, snapshots: [] as ReceivedSnapshot[], failures: 0 };
    connections.push(observation);
    const decoder = new frames.ConversationFrameDecoder();
    const fragments = new Map<string, Buffer[]>();
    socket.on('data', (chunk: Buffer) => {
      observation.bytes += chunk.length;
      for (const raw of decoder.decode(chunk)) {
        const envelope = raw as { type: string; output?: { kind: string; transferId: string; purpose?: string;
          itemIndex: number; finalFragment: boolean; data: string } };
        const output = envelope.output;
        if (envelope.type !== 'event' || output === undefined) continue;
        if (output.kind === 'transfer_start' && output.purpose === 'snapshot') {
          observation.snapshots.push({ transferId: output.transferId, items: [], complete: false });
        }
        const snapshot = observation.snapshots.find((read) => read.transferId === output.transferId);
        if (snapshot === undefined) continue;
        if (output.kind === 'transfer_data') {
          const key = JSON.stringify([output.transferId, output.itemIndex]);
          const parts = fragments.get(key) ?? [];
          parts.push(Buffer.from(output.data, 'base64'));
          if (output.finalFragment) {
            snapshot.items.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as SnapshotItem);
            fragments.delete(key);
          } else fragments.set(key, parts);
        } else if (output.kind === 'transfer_end') snapshot.complete = true;
        else if (output.kind === 'transfer_error') observation.failures++;
      }
    });
    return socket;
  });
  return connections;
}

type IpcObservation = ReturnType<typeof observeIpcConnections>[number];

async function refreshSnapshot(value: ConversationIpcClient, observation: IpcObservation) {
  const previous = observation.snapshots.length;
  await value.refresh();
  await vi.waitFor(() => {
    expect(observation.snapshots).toHaveLength(previous + 1);
    expect(observation.snapshots.at(-1)!.complete).toBe(true);
  }, { timeout: 10_000 });
  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete', error: null });
  return observation.snapshots.at(-1)!;
}

function seedSnapshotGoals(count: number, recordsPerGoal: number, noticesPerGoal: number): Goal[] {
  const recordedAt = '2000-01-01T00:00:00.000Z';
  const goals: Goal[] = Array.from({ length: count }, (_, goalIndex) => ({
    ...goalRecord(), id: `${String(goalIndex + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    objective: `Snapshot goal ${goalIndex + 1}`,
    questions: [createInquiry({ body: `Snapshot question ${goalIndex + 1}`, options: ['CSV', 'JSON'] })],
    workLog: Array.from({ length: recordsPerGoal }, (_, index) => ({ id: randomUUID(), recordedAt,
      summary: `Historical work ${goalIndex}/${index} `.padEnd(1024, 'w') })),
    notifications: Array.from({ length: noticesPerGoal }, (_, index) => ({ id: randomUUID(), recordedAt,
      kind: 'custom', body: `Historical notice ${goalIndex}/${index} `.padEnd(1024, 'n') })),
  }));
  for (const goal of goals) saveGoal(goal);
  return goals;
}

function displayedGoals(value: ConversationIpcClient) {
  return value.getSnapshot().items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []);
}

function displayedInquiries(value: ConversationIpcClient) {
  return value.getSnapshot().items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry] : []);
}

async function snapshotView() {
  const stopPolling = captureAndStopPolling();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment,
    initialDiagnostics: [], onExit() {} }));
  await stopPolling();
  vi.spyOn(app.stdout, 'columns', 'get').mockReturnValue(80);
  app.stdout.emit('resize');
  await stopPolling();
  // バイト計測と差分の観測には明示 refresh だけを使う。
  return app;
}

async function openSnapshotMenu(app: ReturnType<typeof render>, kind: 'answer' | 'goal', observation: IpcObservation) {
  const previous = observation.snapshots.length;
  app.stdin.write(kind === 'answer' ? '\x12' : '\x07');
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel(`manager.selectionTitles.${kind}`, 'en'));
    expect(observation.snapshots).toHaveLength(previous + 1);
    expect(observation.snapshots.at(-1)!.complete).toBe(true);
  });
}

it('[SCN-SNAP-SIZE-P1] receives at most 4096 IPC bytes for an unchanged refresh and retains the displayed goals and inquiries', async () => {
  seedSnapshotGoals(30, 100, 10);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const observation = connections[0]!;
  const goals = displayedGoals(client);
  const inquiries = displayedInquiries(client);
  expect(goals).toHaveLength(30);
  expect(inquiries).toHaveLength(30);
  const app = await snapshotView();
  const headings = [getLabel('manager.assignmentHeading', 'en', { name: 'repository' }),
    getLabel('manager.counts', 'en', { goals: String(goals.length), awaiting: '0', questions: String(inquiries.length) })];
  await vi.waitFor(() => expect(app.lastFrame()).toContain(headings.join(' | ')));
  const bytes = observation.bytes;

  const received = await refreshSnapshot(client, observation);

  console.info(`Unchanged snapshot IPC bytes: ${observation.bytes - bytes}`);
  expect.soft(observation.bytes - bytes).toBeGreaterThan(0);
  expect.soft(observation.bytes - bytes).toBeLessThanOrEqual(4096);
  expect.soft(received.items).toHaveLength(0);
  expect.soft(displayedGoals(client)).toEqual(goals);
  expect.soft(displayedInquiries(client)).toEqual(inquiries);
  await vi.waitFor(() => expect(app.lastFrame()).toContain(headings.join(' | ')));
});

it('[SCN-SNAP-SIZE-P2] initially receives all thirty goals and pending inquiries without historical events or notice items', async () => {
  const goals = seedSnapshotGoals(30, 100, 10);
  const connections = observeIpcConnections();

  await client.connect(); await complete();

  const received = connections[0]!.snapshots[0]!;
  expect(received.complete).toBe(true);
  expect(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual(goals.map((goal) => goal.id));
  expect(received.items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry.question.id] : []))
    .toEqual(goals.map((goal) => goal.questions![0]!.id));
  expect(received.items.map((item) => item.kind).filter((kind) => !['state', 'assignment', 'goal', 'inquiry'].includes(kind))).toHaveLength(0);
  expect(displayedGoals(client)).toHaveLength(30);
  expect(displayedInquiries(client)).toHaveLength(30);
});

it('[SCN-SNAP-DELTA-P1] hides appended work logs while displaying the changed goal, notification and manager reply', async () => {
  const [goal] = seedSnapshotGoals(2, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'New work after attachment' };
  saveGoal({ ...goal!, workLog: [...goal!.workLog, record] });
  const workOnly = await refreshSnapshot(client, connections[0]!);
  expect(workOnly.items).toEqual([]);
  expect(app.lastFrame()).not.toContain(record.summary);
  const notification = { id: randomUUID(), recordedAt: record.recordedAt, kind: 'progress' as const, body: 'Visible progress after attachment' };
  saveGoal({ ...goal!, executionStatus: 'paused', workLog: [...goal!.workLog, record],
    notifications: [...goal!.notifications!, notification] });

  const received = await refreshSnapshot(client, connections[0]!);

  expect.soft(received.items.filter((item) => item.kind !== 'state')).toEqual([
    { kind: 'goal', goal: { id: goal!.id, objective: goal!.objective, status: goal!.status,
      executionStatus: 'paused', awaitingHumanMerge: false, repositoryDirectory: repository } },
    { kind: 'display_event', event: { id: JSON.stringify([repository, goal!.id, 'notification', notification.id]),
      message: formatGoalNotification(goal!, notification, 'en', 'repository', 'tui') } },
  ]);
  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  expect(await client.submit({ kind: 'message', text: 'Reply after recording internal work' })).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(app.lastFrame()).toContain('finished'));
  await refreshSnapshot(client, connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  for (const [props] of vi.mocked(transcriptView.TranscriptView).mock.calls) {
    expect(props.entries.some((entry) => entry.content.includes(record.summary))).toBe(false);
  }
  expect((await new GoalStore(repository).get(goal!.id)).workLog).toEqual([...goal!.workLog, record]);
  expect(displayedGoals(client)).toHaveLength(2);
});

it('[SCN-SNAP-DELTA-P2] updates a paused goal and removes its answered inquiry while preserving other rows on the same screen', async () => {
  const [goal, other] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  await openSnapshotMenu(app, 'answer', connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Snapshot goal 1'));
  const unchangedGoal = displayedGoals(client).find((row) => row.id === other!.id);
  const unchangedInquiry = displayedInquiries(client).find((row) => row.target.goalId === other!.id);
  saveGoal({ ...goal!, executionStatus: 'paused', questions: [answerInquiry(goal!.questions![0]!, 'CSV')] });

  await refreshSnapshot(client, connections[0]!);

  expect(displayedGoals(client).find((row) => row.id === goal!.id)?.executionStatus).toBe('paused');
  expect(displayedGoals(client).find((row) => row.id === other!.id)).toEqual(unchangedGoal);
  expect(displayedInquiries(client)).toEqual([unchangedInquiry]);
  await vi.waitFor(() => {
    expect(app.lastFrame()).not.toContain('Snapshot goal 1');
    expect(app.lastFrame()).toContain('Snapshot goal 2');
    expect(app.lastFrame()).toContain(getLabel('manager.counts', 'en', { goals: '2', awaiting: '0', questions: '1' }));
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.answer', 'en')));
  app.stdin.write('\x07');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(`Snapshot goal 1 — ${getLabel('manager.goalStates.paused', 'en')}`));
});

it('[SCN-SNAP-RECONNECT-P1] reconnects the same client and screen with a complete latest list without replaying disconnected history', async () => {
  const [goal] = seedSnapshotGoals(1, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const entered = gate(); const released = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    entered.release(); await released.promise; return open(...args);
  });
  const states: string[] = [];
  const unsubscribe = client.subscribe(() => states.push(client.getSnapshot().connection));
  connections[0]!.socket.destroy();
  try {
    await entered.promise;
    const duringDisconnect = { id: randomUUID(), recordedAt: new Date(Date.now() - 1).toISOString(), summary: 'Work while disconnected' };
    const disconnectedNotification = { id: randomUUID(), recordedAt: duringDisconnect.recordedAt,
      kind: 'progress' as const, body: 'Progress while disconnected' };
    const disconnectedGoal = { ...goal!, workLog: [...goal!.workLog, duringDisconnect],
      notifications: [...goal!.notifications!, disconnectedNotification] };
    saveGoal(disconnectedGoal);
    const added = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440000', objective: 'Added while disconnected' };
    saveGoal(added);
    released.release();
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }), { timeout: 2000 });
    expect(states).toContain('disconnected');
    expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id, added.id]);
    const received = connections[1]!.snapshots[0]!;
    expect(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual([goal!.id, added.id]);
    expect.soft(received.items.map((item) => item.kind).filter((kind) => !['state', 'assignment', 'goal', 'inquiry'].includes(kind))).toEqual([]);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.counts', 'en', { goals: '2', awaiting: '0', questions: '1' })));
    expect(app.lastFrame()).not.toContain(duringDisconnect.summary);
    expect(app.lastFrame()).not.toContain(disconnectedNotification.body);
    const notification = { id: randomUUID(), recordedAt: new Date().toISOString(),
      kind: 'progress' as const, body: 'Progress after reconnection' };
    saveGoal({ ...disconnectedGoal, notifications: [...disconnectedGoal.notifications, notification] });
    const refreshed = await refreshSnapshot(client, connections[1]!);
    expect(refreshed.items.flatMap((item) => item.kind === 'display_event' ? [item.event] : [])).toEqual([
      { id: JSON.stringify([repository, goal!.id, 'notification', notification.id]),
        message: formatGoalNotification(goal!, notification, 'en', 'repository', 'tui') },
    ]);
    await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
    const unchanged = await refreshSnapshot(client, connections[1]!);
    expect(unchanged.items).toEqual([]);
    expect(app.lastFrame()!.split(notification.body)).toHaveLength(2);
    expect(app.lastFrame()).not.toContain(disconnectedNotification.body);
    app.stdin.write('\x07');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(added.objective));
  } finally { released.release(); unsubscribe(); }
});

it('keeps events for identical goals in different workspace repositories across delta reads', async () => {
  const secondRepository = join(directory, 'second-repository');
  mkdirSync(secondRepository, { recursive: true });
  assignment = { kind: 'workspace', workspaceId: randomUUID(), name: 'Workspace', repositoryDirectories: [repository, secondRepository] };
  doubles.assignment.mockResolvedValue(assignment);
  client.close();
  client = new ConversationIpcClient(assignment, { provider: 'mock' });
  const connections = observeIpcConnections();
  await client.connect(); await complete();

  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Shared work' };
  const notification = { id: randomUUID(), kind: 'progress' as const, body: 'Shared notice', recordedAt: record.recordedAt };
  const goal = { ...goalRecord(), workLog: [record], notifications: [notification] };
  saveGoal(goal, repository); saveGoal(goal, secondRepository);
  const received = await refreshSnapshot(client, connections[0]!);
  const events = received.items.flatMap((item) => item.kind === 'display_event' ? [item.event] : []);
  expect(received.complete).toBe(true);
  expect(events.map((event) => event.id).sort()).toEqual([repository, secondRepository].flatMap((path) => [
    JSON.stringify([path, goal.id, 'notification', notification.id]),
  ]).sort());
  expect(client.getSnapshot().items.filter((item) => item.kind === 'goal')).toHaveLength(2);
  expect(client.getSnapshot().items.filter((item) => item.kind === 'display_event')).toHaveLength(2);

  const unchanged = await refreshSnapshot(client, connections[0]!);
  expect(unchanged.items).toEqual([]);
  saveGoal({ ...goal, workLog: [], notifications: [] }, repository);
  const changed = await refreshSnapshot(client, connections[0]!);
  expect(changed.items).toContainEqual({ kind: 'remove', key: JSON.stringify(['display_event', JSON.stringify([repository, goal.id, 'notification', notification.id])]) });
  expect(client.getSnapshot().readStatus).toBe('complete');
  expect(client.getSnapshot().items.flatMap((item) => item.kind === 'display_event' ? [item.event.id] : []).sort())
    .toEqual(events.map((event) => event.id).filter((id) => id !== JSON.stringify([repository, goal.id, 'notification', notification.id])).sort());
});

it('[SCN-SNAP-MULTI-N1] delivers the same new notification once to each attachment when the second client refreshes first', async () => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const second = new ConversationIpcClient(assignment, { provider: 'mock' });
  try {
    await second.connect();
    await vi.waitFor(() => expect(second.getSnapshot().readStatus).toBe('complete'));
    const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Work for both attachments' };
    const notification = { id: randomUUID(), recordedAt: record.recordedAt, kind: 'progress' as const, body: 'Progress for both attachments' };
    saveGoal({ ...goal!, workLog: [record], notifications: [notification] });

    const fromSecond = await refreshSnapshot(second, connections[1]!);
    const fromFirst = await refreshSnapshot(client, connections[0]!);

    const expected = [{ id: JSON.stringify([repository, goal!.id, 'notification', notification.id]),
      message: formatGoalNotification(goal!, notification, 'en', 'repository', 'tui') }];
    for (const received of [fromFirst, fromSecond]) {
      expect(received.items.flatMap((item) => item.kind === 'display_event' ? [item.event] : [])).toEqual(expected);
    }
    for (const [value, observation] of [[client, connections[0]!], [second, connections[1]!]] as const) {
      const unchanged = await refreshSnapshot(value, observation);
      expect.soft(unchanged.items).toEqual([]);
      expect(value.getSnapshot().items.flatMap((item) => item.kind === 'display_event' ? [item.event] : [])).toEqual(expected);
    }
  } finally { second.close(); }
});

it('[SCN-SNAP-UI-P1] preserves the width eighty headings and both menus and displays a new notification exactly once', async () => {
  const goals = seedSnapshotGoals(2, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const headings = [getLabel('manager.assignmentHeading', 'en', { name: 'repository' }),
    getLabel('manager.counts', 'en', { goals: '2', awaiting: '0', questions: '2' })];
  await vi.waitFor(() => expect(app.lastFrame()).toContain(headings.join(' | ')));
  expect(app.lastFrame()).not.toMatch(/Historical (?:work|notice)/u);
  await openSnapshotMenu(app, 'answer', connections[0]!);
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en'));
    for (const goal of goals) expect(app.lastFrame()).toContain(goal.objective);
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.answer', 'en')));
  await openSnapshotMenu(app, 'goal', connections[0]!);
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en'));
    for (const goal of goals) expect(app.lastFrame()).toContain(`${goal.objective} — ${getLabel('manager.goalStates.active', 'en')}`);
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.goal', 'en')));
  const notification = { id: randomUUID(), recordedAt: new Date().toISOString(), kind: 'custom' as const, body: 'New notification after attachment' };
  saveGoal({ ...goals[0]!, notifications: [...goals[0]!.notifications!, notification] });

  await refreshSnapshot(client, connections[0]!);

  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  await refreshSnapshot(client, connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  expect(app.lastFrame()).toContain(headings.join(' | '));
  expect(app.lastFrame()).not.toMatch(/Historical (?:work|notice)/u);
});

it.each(['transfer_data', 'transfer_end'] as const)('releases the read and retries every uncommitted change after %s fails on the same attachment', async (failedKind) => {
  const [goal] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const previousInquiries = displayedInquiries(client);
  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Work retained after failed transfer' };
  const notification = { id: randomUUID(), recordedAt: record.recordedAt, kind: 'progress' as const, body: 'Progress retained after failed transfer' };
  const updated = { ...goal!, executionStatus: 'paused' as const,
    questions: [answerInquiry(goal!.questions![0]!, 'CSV')], workLog: [record], notifications: [notification] };
  saveGoal(updated);
  const released = vi.fn();
  const snapshot = service.snapshot.bind(service);
  vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
    const read = await snapshot(id);
    return { ...read, items: (async function* () {
      try { yield* read.items; }
      finally { released(); }
    })() };
  });
  const write = frames.writeConversationFrame;
  let failedTransfer: string | undefined;
  vi.spyOn(frames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const envelope = value as { output?: { kind: string; transferId: string } };
    if (failedTransfer === undefined && envelope.output?.kind === failedKind) {
      failedTransfer = envelope.output.transferId;
      throw new Error('Snapshot write failed');
    }
    return write(socket, value);
  });

  await client.refresh();
  await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
  expect(connections[0]!.failures).toBe(1);
  expect(released).toHaveBeenCalledOnce();
  expect(displayedInquiries(client)).toEqual(previousInquiries);
  const received = await refreshSnapshot(client, connections[0]!);

  expect(received.items).toContainEqual({ kind: 'goal', goal: { id: goal!.id, objective: goal!.objective, status: goal!.status,
    executionStatus: 'paused', awaitingHumanMerge: false, repositoryDirectory: repository } });
  expect(received.items).toContainEqual({ kind: 'display_event', event: { id: JSON.stringify([repository, goal!.id, 'notification', notification.id]),
    message: formatGoalNotification(goal!, notification, 'en', 'repository', 'tui') } });
  expect(displayedInquiries(client)).toEqual([previousInquiries[1]]);
  expect(displayedGoals(client)).toHaveLength(2);
  expect(released).toHaveBeenCalledTimes(2);
});

it('reuses unchanged goal files and reloads modified or deleted goals on the same attachment', async () => {
  const [goal, other] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  const reads = vi.spyOn(daemonFiles, 'readPrivateFile');
  const goalReads = () => reads.mock.calls.map(([path]) => path).filter((path) => path.endsWith('/goal.json'));
  await client.connect(); await complete();
  expect(goalReads()).toHaveLength(2);
  reads.mockClear();

  await refreshSnapshot(client, connections[0]!);
  expect.soft(goalReads()).toEqual([]);
  reads.mockClear();
  saveGoal({ ...goal!, objective: 'Changed objective after initial snapshot' });
  await refreshSnapshot(client, connections[0]!);
  expect.soft(goalReads()).toEqual([join(repository, '.takt', 'goals', goal!.id, 'goal.json')]);
  expect(displayedGoals(client).find((row) => row.id === goal!.id)?.objective).toBe('Changed objective after initial snapshot');
  rmSync(join(repository, '.takt', 'goals', other!.id), { recursive: true });
  await refreshSnapshot(client, connections[0]!);
  expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id]);
});

it.each(['corruption', 'symlink'] as const)('reports %s after a successful read instead of hiding it behind cached goal data and recovers after repair', async (failure) => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const path = join(repository, '.takt', 'goals', goal!.id, 'goal.json');
  const saved = join(directory, 'saved-goal.json');
  if (failure === 'corruption') writeFileSync(path, '{broken');
  else {
    renameSync(path, saved);
    symlinkSync(saved, path);
  }

  await client.refresh();
  await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));

  expect(client.getSnapshot().connection).toBe('connected');
  expect(connections[0]!.failures).toBe(1);
  expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id]);
  if (failure === 'symlink') rmSync(path);
  saveGoal({ ...goal!, objective: 'Repaired goal file' });
  await refreshSnapshot(client, connections[0]!);
  expect(displayedGoals(client).map((row) => row.objective)).toEqual(['Repaired goal file']);
});

it('applies multiple updates and removals to a thirty-goal list while retaining unrelated entries and their order', async () => {
  const goals = seedSnapshotGoals(30, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const previousGoals = displayedGoals(client);
  const previousInquiries = displayedInquiries(client);
  const changed = [goals[0]!, goals[14]!, goals[29]!];
  const removed = [goals[1]!, goals[15]!];
  for (const goal of changed) saveGoal({ ...goal, executionStatus: 'paused' });
  for (const goal of removed) rmSync(join(repository, '.takt', 'goals', goal.id), { recursive: true });

  const received = await refreshSnapshot(client, connections[0]!);

  expect.soft(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual(changed.map((goal) => goal.id));
  expect(displayedGoals(client)).toEqual(previousGoals.filter((row) => !removed.some((goal) => goal.id === row.id))
    .map((row) => changed.some((goal) => goal.id === row.id) ? { ...row, executionStatus: 'paused' } : row));
  expect(displayedInquiries(client)).toEqual(previousInquiries.filter((row) => !removed.some((goal) => goal.id === row.target.goalId)));
});

it('reprojects unchanged goal files when notification policy changes on the same attachment', async () => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const observation = connections[0]!;
  saveGoal({ ...goal!, notifications: [{ id: randomUUID(), kind: 'custom', body: 'Policy-controlled notice', recordedAt: new Date().toISOString() }] });
  await refreshSnapshot(client, observation);
  const events = () => client.getSnapshot().items.filter((item) => item.kind === 'display_event');
  expect(events()).toHaveLength(1);
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  notifications:\n    custom: false\n');
  invalidateResolvedConfigCache(repository);
  const disabled = await refreshSnapshot(client, observation);
  expect(disabled.items.filter((item) => item.kind === 'remove')).toHaveLength(1);
  expect(events()).toEqual([]);
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  notifications:\n    custom: true\n');
  invalidateResolvedConfigCache(repository);
  await refreshSnapshot(client, observation);
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ event: { message: expect.stringContaining('Policy-controlled notice') } });
});
