import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationService } from '../features/manager/conversationService.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createDaemonSlackPorts } from '../features/daemon/slackPorts.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { SlackEvent } from '../infra/slack/client.js';
import { DebugLogger, initDebugLogger } from '../shared/utils/debug.js';

const sdk = vi.hoisted(() => ({ on: vi.fn(), start: vi.fn(), post: vi.fn(), disconnect: vi.fn(), socket: vi.fn() }));
vi.mock('@slack/socket-mode', () => ({ LogLevel: { ERROR: 'error' }, SocketModeClient: class {
  constructor(options: unknown) { sdk.socket(options); }
  on = sdk.on; start = sdk.start; disconnect = sdk.disconnect;
} }));
vi.mock('@slack/web-api', () => ({ WebClient: class { chat = { postMessage: sdk.post }; } }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async (value: string) => value }));
vi.mock('../features/manager/assignment.js', () => ({
  resolveCurrentManagerAssignment: async (value: { kind: 'repository'; repositoryDirectory: string }) => ({ ...value, repositoryDirectories: [value.repositoryDirectory] }),
  resolveAssignedProjectRoot: async (value: string) => value,
}));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: () => ({ ctx: { providerType: 'mock' } }) }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));

const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: `reply:${input.instruction}`, summary: null, sessionId: 'session', assignment: input.assignment }));
let directory: string;
let repository: string;
let service: ReturnType<typeof createConversationService>;
let slack: Awaited<ReturnType<typeof createDaemonSlackPorts>>;
let tui: Awaited<ReturnType<typeof service.open>>;
let selected: Awaited<ReturnType<ReturnType<typeof createTuiConversationPort>['resolve']>>;
let release: (() => void) | undefined;

async function emit(overrides: Record<string, unknown> = {}) {
  const receive = sdk.on.mock.calls.find(([type]) => type === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  const pending = receive({ type: 'events_api', body: { team_id: 'T1', event: {
    type: 'message', channel: 'C0123', user: 'U0AAA', text: '状況は？', ts: '1700000000.000001', ...overrides,
  } }, ack });
  return { ack, pending };
}
async function finished(posts: number) {
  await vi.waitFor(() => {
    expect(service.activeOperationCount).toBe(0);
    expect(sdk.post).toHaveBeenCalledTimes(posts);
    expect(service.attachmentCount).toBe(1);
  });
}
async function submitTui(text: string) {
  return service.submit({ attachmentId: tui.attachmentId, requestId: 'tui', speaker: selected.speaker, command: { kind: 'message', text } });
}
beforeEach(async () => {
  vi.clearAllMocks();
  sdk.start.mockReset().mockResolvedValue({ ok: true }); sdk.post.mockReset().mockResolvedValue({ ok: true });
  sdk.disconnect.mockResolvedValue(undefined);
  execute.mockReset().mockImplementation(async (input) => ({ message: `reply:${input.instruction}`, summary: null, sessionId: 'session', assignment: input.assignment }));
  release = undefined;
  directory = process.env.TAKT_CONFIG_DIR!;
  repository = join(directory, 'repository');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'language: ja\nmanager:\n  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n');
  DebugLogger.getInstance().reset();
  initDebugLogger({ enabled: true, logFile: join(directory, 'logs', 'daemon.log') });
  new ConversationStore(directory).write(conversationRecord(repository));
  service = createConversationService({ configDirectory: directory, owner: { pid: process.pid, identity: { startTime: 'slack-test' }, version: 'test', cliPath: '/test/cli.js' },
    onDomainChange() {}, runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'ja', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  tui = await service.open(selected, delivery);
  const iterator = tui.read.items[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
});
afterEach(async () => { release?.(); slack?.stopAccepting(); await service?.close(); await slack?.close(); DebugLogger.getInstance().reset(); vi.restoreAllMocks(); });

it('acknowledges shutdown-time messages without starting a turn before or after delayed startup completes', async () => {
  await slack.close();
  sdk.on.mockClear();
  const controller = new AbortController();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sdk.start.mockImplementationOnce(() => gate);
  const options = { projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, signal: controller.signal };
  const initializing = createDaemonSlackPorts(options);
  try {
    service.stopAccepting();
    controller.abort();
    const { ack, pending } = await emit();
    await pending;
    expect(ack).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(sdk.post).not.toHaveBeenCalled();
    expect(await submitTui('after stop')).toMatchObject({ kind: 'error', code: 'shutting_down' });
  } finally {
    release!();
    slack = await initializing;
  }
  expect(slack.listening).toBe(false);
  const { ack, pending } = await emit();
  await pending;
  expect(ack).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(sdk.post).not.toHaveBeenCalled();
  expect(service.activeOperationCount).toBe(0);
  expect(service.attachmentCount).toBe(1);
});

it('routes a channel post through the shared conversation and replies in its new thread', async () => {
  const { pending, ack } = await emit(); await pending; await finished(1);
  expect(ack).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({ instruction: '状況は？', assignment: selected.assignment });
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'C0123', thread_ts: '1700000000.000001', text: 'reply:状況は？' }));
});

it('routes a broadcast reply once to the TUI conversation and replies in the parent thread', async () => {
  const open = vi.spyOn(service, 'open');
  const { pending, ack } = await emit({ subtype: 'thread_broadcast', text: '返信本文',
    ts: '1700000000.000003', thread_ts: '1700000000.000001',
    root: { text: '親投稿', ts: '1700000000.000001' },
  });
  await pending;
  await finished(1);
  expect(ack).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: selected.conversationId }), expect.any(Object));
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('返信本文');
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    channel: 'C0123', thread_ts: '1700000000.000001', text: 'reply:返信本文',
  }));
});

it('shares the TUI record across parent posts, replies and adjacent timestamp threads', async () => {
  const open = vi.spyOn(service, 'open');
  await (await emit()).pending; await finished(1);
  await (await emit({ ts: '1700000000.000003', thread_ts: '1700000000.000001' })).pending; await finished(2);
  await (await emit({ ts: '1700000000.000004', thread_ts: '1700000000.000002' })).pending; await finished(3);
  expect(open.mock.calls.map(([value]) => value.conversationId)).toEqual(Array(3).fill(selected.conversationId));
  const record = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  expect(readdirSync(join(directory, 'conversations'))).toEqual([`${selected.conversationId}.json`]);
  expect(record.bindings.filter(({ port }) => port === 'slack')).toEqual(['1700000000.000001', '1700000000.000002'].map((ts) => {
    const key = JSON.stringify(['T1', 'C0123', ts]);
    return { port: 'slack', key, counterpart: { namespace: 'slack-thread', id: key } };
  }));
  expect(record.lastSpeaker).toEqual({ namespace: 'slack-user', id: '["T1","U0AAA"]' });
  expect(sdk.post.mock.calls.map(([value]) => value.thread_ts)).toEqual(['1700000000.000001', '1700000000.000001', '1700000000.000002']);
});

it('posts only Slack-originated replies to their source threads across a TUI turn', async () => {
  await (await emit({ text: 'first' })).pending; await finished(1);
  expect((await submitTui('local')).kind).toBe('accepted'); await finished(1);
  await (await emit({ text: 'second', thread_ts: '1700000000.000002', ts: '1700000000.000005' })).pending; await finished(2);
  expect(sdk.post.mock.calls.map(([value]) => ({ thread: value.thread_ts, text: value.text }))).toEqual([
    { thread: '1700000000.000001', text: 'reply:first' }, { thread: '1700000000.000002', text: 'reply:second' },
  ]);
});

it.each(['new binding', 'saved binding'])('rejects Slack input during a TUI turn with %s and never executes it later', async (binding) => {
  if (binding === 'saved binding') { await (await emit()).pending; await finished(1); }
  sdk.post.mockClear(); execute.mockClear();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => { await gate; return { message: 'local reply', summary: null, sessionId: 'session', assignment: input.assignment }; });
  await submitTui('local');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  await (await emit({ text: 'こちらも' })).pending;
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: expect.stringContaining('処理中') }));
  release!(); await finished(1);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('local');
});

it('acknowledges the Socket Mode event while the provider is blocked and delivers after release', async () => {
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => { await gate; return { message: 'later', summary: null, sessionId: 'session', assignment: input.assignment }; });
  const startedAt = Date.now();
  const { pending, ack } = await emit();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 2000 });
  expect(ack).toHaveBeenCalledOnce(); expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(service.activeOperationCount).toBe(1); expect(sdk.post).not.toHaveBeenCalled();
  release!(); await pending; await finished(1);
  expect(sdk.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: 'later' }));
});

it.each([{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' },
  ...[{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' }, { bot_id: 'B1' }].map((overrides) => ({
    subtype: 'thread_broadcast', thread_ts: '1700000000.000001', ...overrides,
  })), {
  subtype: 'message_changed', message: { user: 'U0AAA', text: 'edited', ts: '1700000000.000001' },
}])('ignores filtered Slack input without opening a conversation or posting %j', async (event) => {
  const open = vi.spyOn(service, 'open');
  const before = readFileSync(join(directory, 'conversations', `${selected.conversationId}.json`), 'utf-8');
  await (await emit(event)).pending;
  expect(open).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(sdk.post).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, 'conversations', `${selected.conversationId}.json`), 'utf-8')).toBe(before);
});

it('keeps credentials out of configuration, logs, conversation records and replies after a turn and connection failure', async () => {
  await (await emit()).pending; await finished(1); await slack.close();
  sdk.start.mockRejectedValueOnce(new Error('xapp-test-1 xoxb-test-2'));
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  expect(slack.listening).toBe(false);
  const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  expect(files.some(({ name }) => name === 'daemon.log')).toBe(true);
  expect(files.some(({ name }) => name === `${selected.conversationId}.json`)).toBe(true);
  for (const entry of files) {
    const content = readFileSync(join(entry.parentPath, entry.name), 'utf-8');
    for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(content, entry.name).not.toContain(token);
  }
  for (const [post] of sdk.post.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(post)).not.toContain(token);
});
