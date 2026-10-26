import { beforeEach, expect, it, vi } from 'vitest';
import { createDaemonSlackPorts, dispatchSlackEvent, loadSlackRepositoryConfig } from '../features/daemon/slackPorts.js';
import type { SlackClient, SlackEvent } from '../infra/slack/client.js';
import type { ConversationInput } from '../features/manager/conversationPort.js';

const doubles = vi.hoisted(() => ({ config: vi.fn(), error: vi.fn(), port: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.config }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: () => 'ja' }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));
vi.mock('../features/manager/slackConversationPort.js', () => ({ createSlackConversationPort: doubles.port }));
const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
beforeEach(() => vi.resetAllMocks());
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
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: { receive } }]]);
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
  }), new Map([['C0123', { allowedUserIds: ['U0AAA'], port: { receive } }]]));
  expect(receive).toHaveBeenCalledExactlyOnceWith(
    { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' }, '返信本文',
  );
});
it.each([{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' }, { channel_type: 'mpim' }, { bot_id: 'B1' }])(
  'filters broadcast replies with %j', async (overrides) => {
    const receive = vi.fn();
    await dispatchSlackEvent(message({ subtype: 'thread_broadcast', thread_ts: '1700000000.000001', ...overrides }),
      new Map([['C0123', { allowedUserIds: ['U0AAA'], port: { receive } }]]));
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
  await dispatchSlackEvent(message(overrides), new Map([['C0123', { allowedUserIds: ['U0AAA'], port: { receive } }]]));
  expect(receive).not.toHaveBeenCalled();
});
it('does not treat interactive events as conversation messages', async () => {
  const receive = vi.fn();
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: { receive } }]]);
  for (const id of ['U0AAA', 'U0BBB']) await dispatchSlackEvent({ type: 'interactive', body: {
    team: { id: 'T1' }, channel: { id: 'C0123' }, user: { id }, type: 'block_actions',
  } }, ports);
  expect(receive).not.toHaveBeenCalled();
});
it('disables every repository sharing a channel and logs the channel and repositories', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const factory = vi.fn();
  const manager = await createDaemonSlackPorts({ projects: ['/first', '/second'], configDirectory: '/config', input,
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
  const client: SlackClient = { start: vi.fn(), postThreadMessage: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const manager = await createDaemonSlackPorts({ projects: ['/repo'], configDirectory: '/config', input,
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
  const client: SlackClient = { start: vi.fn(), postThreadMessage: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const controller = new AbortController();
  controller.abort();
  const factory = vi.fn(() => client);
  const options = { projects: ['/repo'], configDirectory: '/config', input,
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
  const client: SlackClient = { start: vi.fn(() => gate), postThreadMessage: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const controller = new AbortController();
  const options = { projects: ['/repo'], configDirectory: '/config', input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: () => client, signal: controller.signal };
  const initializing = createDaemonSlackPorts(options);
  try {
    expect(client.start).toHaveBeenCalledOnce();
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
  const manager = await createDaemonSlackPorts({ projects: ['/repo'], configDirectory: '/config', input, tokens, clientFactory: factory });
  expect(manager.listening).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  await manager.close();
});
it('owns one port per repository and cleans it and the shared client after connection failure', async () => {
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const port = { stopAccepting: vi.fn(), close: vi.fn(), receive: vi.fn() };
  doubles.port.mockReturnValue(port);
  const client: SlackClient = { start: vi.fn().mockRejectedValue(new Error('xapp-test-1 xoxb-test-2')),
    postThreadMessage: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const manager = await createDaemonSlackPorts({ projects: ['/repo', '/repo'], configDirectory: '/config', input,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, clientFactory: () => client });
  expect(manager.listening).toBe(false);
  expect(doubles.port).toHaveBeenCalledOnce();
  expect(port.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
  for (const args of doubles.error.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(args)).not.toContain(token);
});
