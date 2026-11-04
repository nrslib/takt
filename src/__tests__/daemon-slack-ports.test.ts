import { beforeEach, expect, it, vi } from 'vitest';
import { createDaemonSlackPorts, dispatchSlackEvent } from '../features/daemon/slackPorts.js';
import type { SlackClient, SlackEvent } from '../infra/slack/client.js';
import type { ConversationInput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { createSlackConversationPort } from '../features/manager/slackConversationPort.js';

const doubles = vi.hoisted(() => ({ config: vi.fn(), error: vi.fn(), port: vi.fn() }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));
vi.mock('../features/manager/slackConversationPort.js', () => ({ createSlackConversationPort: doubles.port,
  SLACK_GOAL_APPROVE: 'takt_goal_approve', SLACK_GOAL_DISMISS: 'takt_goal_dismiss' }));
const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
});
type SlackPort = ReturnType<typeof createSlackConversationPort>;
function mockPort(receive: ReturnType<typeof vi.fn>) {
  return {
    receive: receive as SlackPort['receive'],
    isInquiryThread: vi.fn<SlackPort['isInquiryThread']>().mockResolvedValue(false),
    receiveAction: vi.fn<SlackPort['receiveAction']>(),
    modalEndpoint: vi.fn<SlackPort['modalEndpoint']>(),
    receiveModal: vi.fn<SlackPort['receiveModal']>(),
  };
}
function message(overrides: Record<string, unknown> = {}): SlackEvent {
  return { type: 'events_api', body: { team_id: 'T1', event: {
    type: 'message', channel: 'C0123', user: 'U0AAA', ts: '1700000000.000001', text: '状況は？', ...overrides,
  } } };
}
it('dispatches authorized messages preserving thread and user identity', async () => {
  const receive = vi.fn();
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]);
  await dispatchSlackEvent(message(), ports);
  await dispatchSlackEvent(message({ thread_ts: '1700000000.000001', ts: '1700000000.000002' }), ports);
  expect(receive.mock.calls).toEqual(Array.from({ length: 2 }, () => [
    { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' }, '状況は？', expect.any(String),
  ]));
});
it('dispatches a broadcast reply once using its own text and parent thread', async () => {
  const receive = vi.fn();
  await dispatchSlackEvent(message({ subtype: 'thread_broadcast', text: '返信本文',
    ts: '1700000000.000003', thread_ts: '1700000000.000001',
    root: { text: '親投稿', ts: '1700000000.000001' },
  }), new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]));
  expect(receive).toHaveBeenCalledExactlyOnceWith(
    { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' }, '返信本文', expect.any(String),
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
    'action', 'choice', 'trigger', expect.any(String));
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
  expect(port.receiveModal).toHaveBeenCalledExactlyOnceWith(endpoint, 'known', 'Allow npm test.', expect.any(String));
  expect(port.receive).not.toHaveBeenCalled();
});

function directorFixture() {
  const client = { start: vi.fn<SlackClient['start']>(), postMessage: vi.fn<SlackClient['postMessage']>(),
    postThreadMessage: vi.fn<SlackClient['postThreadMessage']>(), openModal: vi.fn<SlackClient['openModal']>(),
    stopAccepting: vi.fn(), close: vi.fn<SlackClient['close']>() };
  client.start.mockResolvedValue(undefined);
  client.postMessage.mockResolvedValue({ kind: 'delivered', parentTs: 'posted' });
  client.postThreadMessage.mockResolvedValue({ kind: 'delivered' });
  const read: SnapshotRead = { transferId: 'read', conversationId: 'director', revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () {})(), cancel: vi.fn(), complete: vi.fn() };
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'director-attachment', read });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'director-operation' });
  const factory = vi.fn(() => client);
  const options = { repositories: [{ repositoryDirectory: '/repo', resolveAssignment: async () => ({ kind: 'repository' as const, repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] }), channelId: 'C0123', allowedUserIds: ['U0BBB'], language: 'en' as const }], configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    tokens: { appToken: 'app', botToken: 'bot' }, clientFactory: factory,
    director: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] }, language: 'en' as const } };
  return { client, factory, options };
}

it('shares the connection while routing director and manager messages through their own authorization', async () => {
  const { client, factory, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0BBB'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    expect(ports.listening).toBe(true);
    const receive = client.start.mock.calls[0]![0];
    await receive(message({ channel: 'C0DIR', user: 'U0BBB' }));
    expect(input.open).not.toHaveBeenCalled();
    await receive(message({ channel: 'C0DIR' }));
    expect(input.open).toHaveBeenCalledWith(expect.objectContaining({ assignment: { kind: 'daemon' } }), expect.any(Object));
    expect(managerPort.receive).not.toHaveBeenCalled();
    await receive(message({ channel: 'C0123', user: 'U0BBB' }));
    expect(managerPort.receive).toHaveBeenCalledOnce();
    expect(input.submit).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    ports.stopAccepting();
    await receive(message({ channel: 'C0DIR' }));
    expect(input.submit).toHaveBeenCalledOnce();
  } finally { await ports.close(); }
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('director-attachment');
  expect(managerPort.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
});

it('connects and posts director notifications without registering a manager or scanning its inquiries', async () => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({});
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    await ports.notifications.deliver([{ id: 'notice', message: 'Decision required' }]);
    expect(client.postMessage).toHaveBeenCalledWith('C0DIR', expect.stringContaining('Decision required'), []);
    expect(doubles.port).not.toHaveBeenCalled();
  } finally { await ports.close(); }
});

it.each([1, 2])('keeps director notifications enabled with %i managers sharing its channel', async (count) => {
  const { client, factory, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0BBB'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(managerPort);
  const ports = await createDaemonSlackPorts({ ...options, repositories: ['/repo', '/other'].slice(0, count).map((repositoryDirectory) => ({ ...options.repositories[0]!, repositoryDirectory, channelId: 'C0DIR' })) });
  try {
    expect(ports.listening).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(doubles.port).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    await ports.notifications.deliver([{ id: 'merge', message: 'Merge approval required' }, { id: 'inquiry', message: 'Answer required' }]);
    expect(client.postMessage).toHaveBeenCalledExactlyOnceWith('C0DIR', expect.stringContaining('Merge approval required'), []);
    expect(client.postMessage.mock.calls[0]![1]).toContain('Answer required');
    await client.start.mock.calls[0]![0](message({ channel: 'C0DIR' }));
    expect(input.submit).toHaveBeenCalledOnce();
    expect(managerPort.receive).not.toHaveBeenCalled();
  } finally { await ports.close(); }
  expect(client.close).toHaveBeenCalledOnce();
  expect(managerPort.close).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('director-attachment');
});

it('routes shared-channel speech only to director and replies in the originating thread', async () => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0AAA', 'U0BBB'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    const receive = client.start.mock.calls[0]![0];
    await receive(message({ channel: 'C0DIR', user: 'U0BBB', text: 'G をマージして' }));
    expect(input.open).not.toHaveBeenCalled();
    expect(input.submit).not.toHaveBeenCalled();
    expect(managerPort.receive).not.toHaveBeenCalled();
    expect(client.postThreadMessage).not.toHaveBeenCalled();
    await receive(message({ channel: 'C0DIR', text: 'マージ待ちは？' }));
    expect(input.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ assignment: { kind: 'daemon' } }), expect.any(Object));
    expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      attachmentId: 'director-attachment', command: { kind: 'message', text: 'マージ待ちは？' },
    }));
    const delivery = vi.mocked(input.open).mock.calls[0]![1];
    await delivery.deliver(vi.mocked(input.open).mock.calls[0]![0].conversationId, { kind: 'result', operationId: 'director-operation',
      result: { kind: 'reply', message: '確認待ちです' } }, { revision: 1, stateSequence: 1, operationId: 'director-operation' });
    expect(client.postThreadMessage).toHaveBeenLastCalledWith(
      { channelId: 'C0DIR', parentTs: '1700000000.000001' }, '確認待ちです');
    expect(managerPort.receive).not.toHaveBeenCalled();
    ports.stopAccepting();
    await receive(message({ channel: 'C0DIR' }));
    expect(input.submit).toHaveBeenCalledOnce();
  } finally { await ports.close(); }
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('director-attachment');
});

it.each(['1700000000.000001', '1700000000.000002'])('routes identical shared-channel text according to the binding of parent %s', async (parentTs) => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  managerPort.isInquiryThread.mockImplementation(async (channel: string, parent: string) => channel === 'C0DIR' && parent === '1700000000.000001');
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    await client.start.mock.calls[0]![0](message({ channel: 'C0DIR', thread_ts: parentTs, ts: '1700000000.000100', text: '幅 80 で問題なし' }));
    expect(managerPort.isInquiryThread).toHaveBeenCalledExactlyOnceWith('C0DIR', parentTs);
    if (parentTs === '1700000000.000001') {
      expect(managerPort.receive).toHaveBeenCalledExactlyOnceWith({ teamId: 'T1', channelId: 'C0DIR', userId: 'U0AAA', parentTs }, '幅 80 で問題なし', expect.any(String));
      expect(input.open).not.toHaveBeenCalled();
      expect(input.submit).not.toHaveBeenCalled();
    } else {
      expect(managerPort.receive).not.toHaveBeenCalled();
      expect(input.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ assignment: { kind: 'daemon' } }), expect.any(Object));
      expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: { kind: 'message', text: '幅 80 で問題なし' } }));
    }
  } finally { await ports.close(); }
});

it.each(['U0AAA', 'U0BBB'])('applies only manager authorization to a bound shared-channel reply from %s', async (user) => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0BBB'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  managerPort.isInquiryThread.mockResolvedValue(true);
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    await client.start.mock.calls[0]![0](message({ channel: 'C0DIR', user, thread_ts: '1700000000.000001', text: '幅 80 で問題なし' }));
    expect(managerPort.receive).toHaveBeenCalledTimes(user === 'U0BBB' ? 1 : 0);
    expect(input.open).not.toHaveBeenCalled();
    expect(input.submit).not.toHaveBeenCalled();
    expect(client.postThreadMessage).not.toHaveBeenCalled();
  } finally { await ports.close(); }
});

it.each(['U0AAA', 'U0BBB'])('uses the manager allowlist for shared-channel buttons allowing %s', async (allowedUser) => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: [allowedUser] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    for (const userId of ['U0AAA', 'U0BBB']) await client.start.mock.calls[0]![0]({ type: 'interactive', body: {
      type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C0DIR' }, user: { id: userId }, trigger_id: 'trigger',
      container: { type: 'message', channel_id: 'C0DIR', message_ts: '1700000000.000001' },
      message: { ts: '1700000000.000001', text: 'マージ待ちは？' },
      actions: [{ type: 'button', action_id: 'action', value: 'choice' }],
    } });
    expect(managerPort.receiveAction).toHaveBeenCalledExactlyOnceWith(
      { teamId: 'T1', channelId: 'C0DIR', userId: allowedUser, parentTs: '1700000000.000001' }, 'action', 'choice', 'trigger', expect.any(String));
    expect(input.open).not.toHaveBeenCalled();
    expect(managerPort.receive).not.toHaveBeenCalled();
  } finally { await ports.close(); }
});

it.each(['view_submission', 'view_closed'])('restores shared-channel %s with manager authorization and origin checks', async (type) => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0BBB', 'U0CCC'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  const endpoint = { teamId: 'T1', channelId: 'C0DIR', userId: 'U0BBB', parentTs: '1700000000.000001' };
  managerPort.modalEndpoint.mockImplementation((metadata: string) => metadata === 'known' ? endpoint : undefined);
  doubles.port.mockReturnValue(managerPort);
  const config = doubles.config();
  const repositories = config.manager?.slack === undefined ? [] : options.repositories.map((repository) => ({ ...repository, ...config.manager.slack }));
  const ports = await createDaemonSlackPorts({ ...options, repositories });
  try {
    for (const userId of ['U0AAA', 'U0CCC', 'U0BBB']) await client.start.mock.calls[0]![0]({ type: 'interactive', body: {
      type, team: { id: 'T1' }, user: { id: userId }, view: { callback_id: 'takt_inquiry_permission', private_metadata: 'known',
        state: { values: { permission: { sentence: { type: 'plain_text_input', value: 'Allow npm test.' } } } } },
    } });
    expect(managerPort.receiveModal).toHaveBeenCalledExactlyOnceWith(endpoint, 'known', type === 'view_submission' ? 'Allow npm test.' : undefined, expect.any(String));
    expect(input.open).not.toHaveBeenCalled();
    expect(managerPort.receive).not.toHaveBeenCalled();
  } finally { await ports.close(); }
});

it('does not deliver director notifications or receive director speech without director configuration', async () => {
  const { client, options } = directorFixture();
  doubles.config.mockReturnValue({ manager: { slack: { channelId: 'C0123', allowedUserIds: ['U0AAA'] } } });
  const managerPort = { ...mockPort(vi.fn()), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.port.mockReturnValue(managerPort);
  const ports = await createDaemonSlackPorts({ ...options, director: undefined });
  try {
    await ports.notifications.deliver([{ id: 'notice', message: 'Decision required' }]);
    await client.start.mock.calls[0]![0](message({ channel: 'C0DIR' }));
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(input.open).not.toHaveBeenCalled();
    expect(managerPort.receive).not.toHaveBeenCalled();
  } finally { await ports.close(); }
});

it.each(['missing tokens', 'connection failure'] as const)('does not enable director Slack after %s', async (failure) => {
  const { client, factory, options } = directorFixture();
  doubles.config.mockReturnValue({});
  if (failure === 'connection failure') client.start.mockRejectedValueOnce(new Error('xapp-secret xoxb-secret'));
  const ports = await createDaemonSlackPorts({ ...options, repositories: [], tokens: failure === 'missing tokens' ? undefined : options.tokens });
  try {
    expect(ports.listening).toBe(false);
    await ports.notifications.deliver([{ id: 'notice', message: 'Decision required' }]);
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(input.open).not.toHaveBeenCalled();
    if (failure === 'missing tokens') expect(factory).not.toHaveBeenCalled();
    else {
      await client.start.mock.calls[0]![0](message({ channel: 'C0DIR' }));
      expect(input.open).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledOnce();
    }
    for (const args of doubles.error.mock.calls) {
      for (const secret of ['xapp-secret', 'xoxb-secret']) expect(JSON.stringify(args)).not.toContain(secret);
    }
  } finally { await ports.close(); }
});

it('closes Slack startup on cancellation without waiting for the connection promise', async () => {
  const { client, options } = directorFixture();
  const controller = new AbortController();
  let releaseStart!: () => void;
  let signalEntered!: () => void;
  const starting = new Promise<void>((resolve) => { releaseStart = resolve; });
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  client.start.mockImplementationOnce(async () => { signalEntered(); await starting; });
  const pending = createDaemonSlackPorts({ ...options, repositories: [], signal: controller.signal });
  await entered;
  controller.abort();
  const ports = await pending;
  expect(ports.listening).toBe(false);
  expect(client.stopAccepting).toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
  releaseStart();
  await ports.close();
  expect(client.close).toHaveBeenCalledOnce();
});

it('keeps stable request identity across repeated delivery of the same Slack event', async () => {
  const receive = vi.fn();
  const ports = new Map([['C0123', { allowedUserIds: ['U0AAA'], port: mockPort(receive) }]]);
  const event = message();
  await dispatchSlackEvent(event, ports);
  await dispatchSlackEvent(event, ports);
  expect(receive.mock.calls[0]![2]).toBe(receive.mock.calls[1]![2]);
  expect(receive.mock.calls[0]![2]).toMatch(/^[a-f0-9]{64}$/);
});
