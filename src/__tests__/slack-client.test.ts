import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSlackClient, type SlackEvent } from '../infra/slack/client.js';

const sdk = vi.hoisted(() => ({ start: vi.fn(), disconnect: vi.fn(), post: vi.fn(), open: vi.fn(), on: vi.fn(), socket: vi.fn(), web: vi.fn(), error: vi.fn() }));
vi.mock('@slack/socket-mode', () => ({ LogLevel: { ERROR: 'error' }, SocketModeClient: class {
  constructor(options: unknown) { sdk.socket(options); }
  on = sdk.on;
  start = sdk.start;
  disconnect = sdk.disconnect;
} }));
vi.mock('@slack/web-api', () => ({ WebClient: class {
  constructor(token: string, options: unknown) { sdk.web(token, options); }
  chat = { postMessage: sdk.post };
  views = { open: sdk.open };
} }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: sdk.error }) }));
beforeEach(() => { vi.resetAllMocks(); sdk.start.mockResolvedValue({ ok: true }); sdk.disconnect.mockResolvedValue(undefined); sdk.post.mockResolvedValue({ ok: true }); });
afterEach(() => vi.useRealTimers());

it('posts a channel parent with blocks and preserves the returned timestamp as a string', async () => {
  const client = createSlackClient({ appToken: 'app', botToken: 'bot' });
  sdk.post.mockResolvedValueOnce({ ok: true, ts: '1700000000.000001' });
  const blocks = [{ type: 'section' as const, text: { type: 'plain_text' as const, text: 'Question' } }];
  expect(await client.postMessage('C0123', 'Question', blocks)).toEqual({ kind: 'delivered', parentTs: '1700000000.000001' });
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith({ channel: 'C0123', text: 'Question', blocks, unfurl_links: false, unfurl_media: false });
  await client.close();
});

it.each([{ ok: true }, { ok: false }, { ok: true, ts: 123 }])('does not claim a parent binding for an invalid post response %j', async (response) => {
  const client = createSlackClient({ appToken: 'app', botToken: 'bot' });
  sdk.post.mockResolvedValueOnce(response);
  expect((await client.postMessage('C0123', 'Question', [])).kind).toBe('unavailable');
  expect(sdk.post).toHaveBeenCalledOnce();
  await client.close();
});

it('opens the supplied modal using the trigger from the interaction', async () => {
  const client = createSlackClient({ appToken: 'app', botToken: 'bot' });
  sdk.open.mockResolvedValueOnce({ ok: true, view: { id: 'V1' } });
  const view = { type: 'modal' as const, title: { type: 'plain_text' as const, text: 'Permission' }, blocks: [] };
  expect(await client.openModal('trigger', view)).toEqual({ kind: 'delivered' });
  expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ trigger_id: 'trigger', view });
  await client.close();
});

it.each(['post', 'modal'] as const)('contains credentials in a failed %s operation without retrying', async (operation) => {
  const client = createSlackClient({ appToken: 'xapp-test-1', botToken: 'xoxb-test-2' });
  sdk.post.mockRejectedValueOnce(new Error('xapp-test-1 xoxb-test-2'));
  sdk.open.mockRejectedValueOnce(new Error('xapp-test-1 xoxb-test-2'));
  const result = operation === 'post' ? await client.postMessage('C0123', 'Question', [])
    : await client.openModal('trigger', { type: 'modal', title: { type: 'plain_text', text: 'Permission' }, blocks: [] });
  expect(result.kind).toBe('unavailable');
  expect(operation === 'post' ? sdk.post : sdk.open).toHaveBeenCalledOnce();
  for (const value of [result, ...sdk.error.mock.calls]) {
    expect(JSON.stringify(value)).not.toContain('xapp-test-1');
    expect(JSON.stringify(value)).not.toContain('xoxb-test-2');
  }
  await client.close();
});

it.each(['events_api', 'interactive'])('acknowledges %s before dispatch and posts the eventual reply to its exact string timestamp', async (type) => {
  const client = createSlackClient({ appToken: 'xapp-test-1', botToken: 'xoxb-test-2' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const thread = { channelId: 'C0123', parentTs: '1700000000.000001' };
  const receive = vi.fn(async () => { await gate; await client.postThreadMessage(thread, 'reply'); });
  await client.start(receive);
  const listener = sdk.on.mock.calls.find(([event]) => event === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  const pending = listener({ type, body: {}, ack });
  try {
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(receive.mock.invocationCallOrder[0]!);
    expect(sdk.post).not.toHaveBeenCalled();
  } finally { release(); await pending; await client.close(); }
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith({ channel: thread.channelId, thread_ts: thread.parentTs,
    text: 'reply', unfurl_links: false, unfurl_media: false });
  expect(sdk.socket.mock.calls[0]![0]).toMatchObject({ appToken: 'xapp-test-1' });
  expect(sdk.web.mock.calls[0]![0]).toBe('xoxb-test-2');
  expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('acknowledges but stops dispatching after admission closes', async () => {
  const client = createSlackClient({ appToken: 'app', botToken: 'bot' });
  const receive = vi.fn();
  await client.start(receive);
  client.stopAccepting();
  const listener = sdk.on.mock.calls.find(([event]) => event === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  await listener({ type: 'interactive', body: {}, ack });
  expect(ack).toHaveBeenCalledOnce();
  expect(receive).not.toHaveBeenCalled();
  await client.close();
});

it('contains SDK diagnostics and returns unavailable without retrying a failed post', async () => {
  const client = createSlackClient({ appToken: 'xapp-test-1', botToken: 'xoxb-test-2' });
  sdk.post.mockRejectedValue(new Error('xapp-test-1 xoxb-test-2'));
  const result = await client.postThreadMessage({ channelId: 'C0123', parentTs: '1.000001' }, 'reply');
  expect(result.kind).toBe('unavailable');
  expect(sdk.post).toHaveBeenCalledOnce();
  const logger = sdk.socket.mock.calls[0]![0].logger;
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level]('xapp-test-1 xoxb-test-2');
  for (const value of [result, ...sdk.error.mock.calls]) {
    expect(JSON.stringify(value)).not.toContain('xapp-test-1');
    expect(JSON.stringify(value)).not.toContain('xoxb-test-2');
  }
  await client.close();
});

it('replaces connection failures with a credential-free error', async () => {
  const client = createSlackClient({ appToken: 'xapp-test-1', botToken: 'xoxb-test-2' });
  sdk.start.mockRejectedValue(new Error('xapp-test-1 xoxb-test-2'));
  await expect(client.start(vi.fn())).rejects.toThrow('Cannot connect to Slack');
  await client.close();
});

it('bounds connection, post and shutdown waits', async () => {
  vi.useFakeTimers();
  sdk.start.mockImplementation(() => new Promise(() => {}));
  sdk.post.mockImplementation(() => new Promise(() => {}));
  sdk.disconnect.mockImplementation(() => new Promise(() => {}));
  const client = createSlackClient({ appToken: 'app', botToken: 'bot' });
  const started = expect(client.start(vi.fn())).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000); await started;
  const posted = client.postThreadMessage({ channelId: 'C', parentTs: '1' }, 'text');
  await vi.advanceTimersByTimeAsync(10_000); expect((await posted).kind).toBe('unavailable');
  const closed = client.close();
  await vi.advanceTimersByTimeAsync(10_000); await closed;
});
