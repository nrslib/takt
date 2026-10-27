import { beforeEach, expect, it, vi } from 'vitest';
import { createDaemonSlackPorts, dispatchSlackEvent, loadSlackRepositoryConfig } from '../features/daemon/slackPorts.js';
import type { SlackClient, SlackEvent } from '../infra/slack/client.js';
import type { ConversationInput } from '../features/manager/conversationPort.js';
import { withInquiryLock } from '../infra/goals/inquiry-lock.js';
import { createInquiry } from '../infra/goals/inquiry.js';

const lock = vi.hoisted(() => ({ tail: Promise.resolve() }));
vi.mock('../infra/goals/inquiry-lock.js', () => ({ withInquiryLock: (_directory: string, action: () => Promise<unknown>) => {
  const next = lock.tail.then(action);
  lock.tail = next.then(() => undefined, () => undefined);
  return next;
} }));
const doubles = vi.hoisted(() => ({ config: vi.fn(), error: vi.fn(), port: vi.fn(), pending: vi.fn(), assignment: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.config }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: () => 'ja' }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));
vi.mock('../features/manager/slackConversationPort.js', () => ({ createSlackConversationPort: doubles.port }));
vi.mock('../infra/goals/pending-inquiries.js', () => ({ iteratePendingInquiries: doubles.pending }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async (value: string) => value }));
vi.mock('../features/manager/assignment.js', () => ({ resolveCurrentManagerAssignment: doubles.assignment }));
const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  lock.tail = Promise.resolve();
  doubles.assignment.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] });
  doubles.pending.mockImplementation(async function* () {});
});
function mockPort(receive: ReturnType<typeof vi.fn>) {
  return { receive, receiveAction: vi.fn(), modalEndpoint: vi.fn(), receiveModal: vi.fn() };
}
function message(overrides: Record<string, unknown> = {}): SlackEvent {
  return { type: 'events_api', body: { team_id: 'T1', event: {
    type: 'message', channel: 'C0123', user: 'U0AAA', ts: '1700000000.000001', text: '状況は？', ...overrides,
  } } };
}
it('loads repository Slack settings and their language without global Slack fallback', () => {
  doubles.config.mockReturnValueOnce({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } }).mockReturnValue({});
  expect(loadSlackRepositoryConfig('/repo')).toEqual({ repositoryDirectory: '/repo', channelId: 'C0123', allowedUserIds: ['U0AAA'], language: 'ja' });
  expect(loadSlackRepositoryConfig('/other')).toBeUndefined();
});
it('dispatches authorized messages preserving thread and user identity', async () => {
  const receive = vi.fn();
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]);
  await dispatchSlackEvent(message(), ports);
  await dispatchSlackEvent(message({ thread_ts: '1700000000.000001', ts: '1700000000.000002' }), ports);
  expect(receive.mock.calls).toEqual(Array.from({ length: 2 }, () => [
    { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' }, '状況は？',
  ]));
});
it('dispatches a broadcast reply once using its own text and parent thread', async () => {
  const receive = vi.fn();
  await dispatchSlackEvent(message({ subtype: 'thread_broadcast', text: '返信本文',
    ts: '1700000000.000003', thread_ts: '1700000000.000001',
    root: { text: '親投稿', ts: '1700000000.000001' },
  }), new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]));
  expect(receive).toHaveBeenCalledExactlyOnceWith(
    { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' }, '返信本文',
  );
});
it.each([{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' }, { channel_type: 'mpim' }, { bot_id: 'B1' }])(
  'filters broadcast replies with %j', async (overrides) => {
    const receive = vi.fn();
    await dispatchSlackEvent(message({ subtype: 'thread_broadcast', thread_ts: '1700000000.000001', ...overrides }),
      new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]));
    expect(receive).not.toHaveBeenCalled();
  },
);
it.each([
  { user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' }, { channel_type: 'mpim' },
  { bot_id: 'B1' }, { subtype: 'bot_message' }, { subtype: 'message_deleted' },
  { subtype: 'message_changed', message: { user: 'U0AAA', text: 'edited', ts: '1700000000.000001' } },
  { text: undefined }, { ts: 1700000000.000001 }, { thread_ts: 1 },
])('ignores unauthorized or non-message input %j', async (overrides) => {
  const receive = vi.fn();
  await dispatchSlackEvent(message(overrides), new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]));
  expect(receive).not.toHaveBeenCalled();
});
it('does not treat interactive events as conversation messages', async () => {
  const receive = vi.fn();
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]);
  for (const id of ['U0AAA', 'U0BBB']) await dispatchSlackEvent({ type: 'interactive', body: {
    team: { id: 'T1' }, channel: { id: 'C0123' }, user: { id }, type: 'block_actions',
  } }, ports);
  expect(receive).not.toHaveBeenCalled();
});

it('dispatches an authorized button with its exact parent and action while rejecting an unauthorized user', async () => {
  const port = mockPort(vi.fn());
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port }]]);
  const body = { type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C0123' }, trigger_id: 'trigger',
    container: { type: 'message', channel_id: 'C0123', message_ts: '1700000000.000001' }, message: { ts: '1700000000.000001' },
    actions: [{ type: 'button', action_id: 'action', value: 'choice' }] };
  for (const userId of ['U0BBB', 'U0AAA']) await dispatchSlackEvent({ type: 'interactive', body: { ...body, user: { id: userId } } }, ports);
  expect(port.receiveAction).toHaveBeenCalledExactlyOnceWith({ teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' },
    'action', 'choice', 'trigger');
  expect(port.receive).not.toHaveBeenCalled();
});

it('restores the channel of a modal only from a known originating endpoint and applies the allowlist', async () => {
  const port = mockPort(vi.fn());
  const endpoint = { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' };
  port.modalEndpoint.mockImplementation((metadata: string) => metadata === 'known' ? endpoint : undefined);
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port }]]);
  for (const [userId, metadata] of [['U0BBB', 'known'], ['U0AAA', 'unknown'], ['U0AAA', 'known']]) {
    await dispatchSlackEvent({ type: 'interactive', body: { type: 'view_submission', team: { id: 'T1' }, user: { id: userId },
      view: { callback_id: 'takt_inquiry_permission', private_metadata: metadata,
        state: { values: { permission: { sentence: { type: 'plain_text_input', value: 'Allow npm test.' } } } } } } }, ports);
  }
  expect(port.receiveModal).toHaveBeenCalledExactlyOnceWith(endpoint, 'known', 'Allow npm test.');
  expect(port.receive).not.toHaveBeenCalled();
});

it('coalesces overlapping inquiry polls and waits for their delivery before closing the client', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  doubles.assignment.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] });
  const question = createInquiry({ body: 'Width?' });
  doubles.pending.mockImplementationOnce(async function* () {});
  doubles.pending.mockImplementation(async function* () {
    yield { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo', objective: 'Goal', question };
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const port = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn(), delivery: {
    deliver: vi.fn(async () => { await gate; return { kind: 'delivered' as const }; }),
  } };
  doubles.port.mockReturnValue(port);
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn(), postThreadMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const manager = await createDaemonSlackPorts({ projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: () => client });
  const first = manager.pollInquiries();
  const second = manager.pollInquiries();
  try {
    await vi.waitFor(() => expect(port.delivery.deliver).toHaveBeenCalledOnce());
    const closing = manager.close();
    expect(client.close).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, closing]);
    expect(doubles.pending).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledOnce();
  } finally { release(); await first; await second; }
});
it('disables every repository sharing a channel and logs the channel and repositories', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const factory = vi.fn();
  const manager = await createDaemonSlackPorts({ projects: ['/first', '/second'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: factory });
  expect(manager.listening).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  expect(doubles.port).not.toHaveBeenCalled();
  await dispatchSlackEvent(message(), new Map());
  expect(input.open).not.toHaveBeenCalled();
  expect(doubles.error).toHaveBeenCalledWith(expect.any(String), { channelId: 'C0123', repositories: ['/first', '/second'] });
  await manager.close();
});
it('starts one shared client and routes events through the configured repository port until shutdown', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const port = { receive: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(port);
  const client: SlackClient = { start: vi.fn(), postThreadMessage: vi.fn(), postMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const manager = await createDaemonSlackPorts({ projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: () => client });
  expect(manager.listening).toBe(true);
  const receive = vi.mocked(client.start).mock.calls[0]![0];
  await receive(message());
  expect(port.receive).toHaveBeenCalledOnce();
  manager.stopAccepting();
  expect(manager.listening).toBe(false);
  await receive(message());
  expect(port.receive).toHaveBeenCalledOnce();
  await manager.close();
  expect(port.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
});
it('does not initialize a Slack connection when shutdown already started', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  doubles.port.mockReturnValue({ receive: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() });
  const client: SlackClient = { start: vi.fn(), postThreadMessage: vi.fn(), postMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const controller = new AbortController();
  controller.abort();
  const factory = vi.fn(() => client);
  const options = { projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: factory, signal: controller.signal };
  const manager = await createDaemonSlackPorts(options);
  try {
    expect(manager.listening).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  } finally { await manager.close(); }
});
it.each(['during startup', 'after startup'] as const)('closes admission on abort %s and never reopens it', async (stage) => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const port = { receive: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(port);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client: SlackClient = { start: vi.fn(() => gate), postThreadMessage: vi.fn(), postMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const controller = new AbortController();
  const options = { projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: () => client, signal: controller.signal };
  const initializing = createDaemonSlackPorts(options);
  try {
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
    if (stage === 'after startup') {
      release();
      expect((await initializing).listening).toBe(true);
    }
    controller.abort();
    expect(client.stopAccepting).toHaveBeenCalled();
    expect(port.stopAccepting).toHaveBeenCalled();
    await vi.mocked(client.start).mock.calls[0]![0](message());
    expect(port.receive).not.toHaveBeenCalled();
    release();
    const manager = await initializing;
    expect(manager.listening).toBe(false);
    await vi.mocked(client.start).mock.calls[0]![0](message());
    expect(port.receive).not.toHaveBeenCalled();
    manager.stopAccepting();
    expect(manager.listening).toBe(false);
  } finally { release(); await (await initializing).close(); }
  expect(port.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
});
it.each([undefined, { appToken: 'app', botToken: 'bot' }])('does not connect without repository configuration or tokens %j', async (tokens) => {
  doubles.config.mockReturnValue({});
  const factory = vi.fn();
  const manager = await createDaemonSlackPorts({ projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input, tokens, clientFactory: factory });
  expect(manager.listening).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  await manager.close();
});
it('owns one port per repository and cleans it and the shared client after connection failure', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const port = { stopAccepting: vi.fn(), close: vi.fn(), receive: vi.fn() };
  doubles.port.mockReturnValue(port);
  const client: SlackClient = { start: vi.fn().mockRejectedValue(new Error('xapp-test-1 xoxb-test-2')),
    postThreadMessage: vi.fn(), postMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const manager = await createDaemonSlackPorts({ projects: ['/repo', '/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, clientFactory: () => client });
  expect(manager.listening).toBe(false);
  expect(doubles.port).toHaveBeenCalledOnce();
  expect(port.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
  for (const args of doubles.error.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(args)).not.toContain(token);
});

it('posts inquiries saved after connection while the initial scan is in progress', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  let resume!: () => void;
  let scanning!: () => void;
  const started = new Promise<void>((resolve) => { scanning = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let question: ReturnType<typeof createInquiry> | undefined;
  doubles.pending.mockImplementation(async function* () {
    scanning();
    await gate;
    if (question !== undefined) yield { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo', objective: 'Goal', question };
  });
  const port = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn(), delivery: { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) } };
  doubles.port.mockReturnValue(port);
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn(), postThreadMessage: vi.fn(), openModal: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const initializing = createDaemonSlackPorts({ projects: ['/repo'], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: () => client });
  await started;
  const saving = withInquiryLock(process.env.TAKT_CONFIG_DIR!, async () => { question = createInquiry({ body: 'Width?' }); });
  resume();
  const manager = await initializing;
  await saving;
  try {
    await manager.pollInquiries();
    expect(port.delivery.deliver).toHaveBeenCalledOnce();
  } finally { await manager.close(); }
});
