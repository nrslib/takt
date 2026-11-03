import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSlackConversationPort } from '../features/manager/slackConversationPort.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createDaemonSlackPorts } from '../features/daemon/slackPorts.js';
import { createDaemonConversationInput } from '../features/manager/daemonConversationPort.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createSlackClient, type SlackEvent } from '../infra/slack/client.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import type { Admission, EventInput } from '../core/daemon/events.js';
import type { ConversationSnapshot } from '../core/daemon/messages.js';
import type { SnapshotItem } from '../features/manager/conversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';

const sdk = vi.hoisted(() => ({ on: vi.fn(), start: vi.fn(), disconnect: vi.fn(), post: vi.fn(), open: vi.fn() }));
vi.mock('@slack/socket-mode', () => ({ LogLevel: { ERROR: 'error' }, SocketModeClient: class {
  on = sdk.on; start = sdk.start; disconnect = sdk.disconnect;
} }));
vi.mock('@slack/web-api', () => ({ WebClient: class { chat = { postMessage: sdk.post }; views = { open: sdk.open }; } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const repositoryDirectory = '/repo';
const assignment = { kind: 'repository' as const, repositoryDirectory, repositoryDirectories: [repositoryDirectory] };
const id = conversationId(assignment);
const operationId = randomUUID();
const version = { revision: 4, stateSequence: 1, operationId: null };
let slack: Awaited<ReturnType<typeof createDaemonSlackPorts>>;
let input: ReturnType<typeof createDaemonConversationInput>;
let ingress: DaemonIngress;
let events: EventInput[];
let items: SnapshotItem[];
let beforeSave: (event: EventInput) => Promise<void>;
let sequence: number;
let admitted: Map<string, Admission>;

beforeEach(async () => {
  vi.clearAllMocks();
  sdk.start.mockResolvedValue(undefined); sdk.disconnect.mockResolvedValue(undefined);
  sdk.post.mockImplementation(async () => ({ ok: true, ts: `posted-${sdk.post.mock.calls.length}` }));
  sdk.open.mockResolvedValue({ ok: true });
  events = []; items = []; sequence = 0; admitted = new Map(); beforeSave = async () => {};
  ingress = {
    accept: vi.fn(async (event) => {
      const existing = admitted.get(event.requestId);
      if (existing !== undefined) return existing;
      await beforeSave(event);
      events.push(event);
      const receipt = { kind: 'accepted' as const, eventId: event.eventId, operationId: randomUUID(), acceptedSequence: ++sequence };
      admitted.set(event.requestId, receipt);
      return receipt;
    }),
    control: vi.fn().mockResolvedValue({ kind: 'interrupted' }),
    snapshot: vi.fn(async (): Promise<ConversationSnapshot> => ({ ...version, operationId, generation: 5,
      transferId: randomUUID(), conversationId: id, mode: 'initial', cancel: vi.fn(), complete: vi.fn(),
      turnState: { version: 1, assignment, session: { provider: 'mock', model: null, sessionId: 'same-session' }, revision: 4, pending: { revision: 4, repositoryDirectory, summary: { objective: 'work', outOfScope: [], acceptanceCriteria: ['done'], constraints: [] } }, approval: null },
      items: (async function* () { yield* items; })() })),
  };
  input = createDaemonConversationInput({ ingress, resolveAssignment: async (selected) => selected });
  slack = await createDaemonSlackPorts({ configDirectory: process.env.TAKT_CONFIG_DIR!, input,
    repositories: [{ repositoryDirectory, resolveAssignment: async () => assignment, channelId: 'C1', allowedUserIds: ['U1', 'U2'], language: 'en' }],
    tokens: { appToken: 'fake-app', botToken: 'fake-bot' }, clientFactory: createSlackClient });
});
afterEach(async () => { await slack.close(); input.close(); });
function message(text: string, ts = '1700000000.000002', extra: Record<string, unknown> = {}): SlackEvent {
  return { type: 'events_api', body: { team_id: 'T1', event: { type: 'message', channel: 'C1', user: 'U1',
    ts, thread_ts: '1700000000.000001', text, ...extra } } };
}
async function emit(event: SlackEvent, ack = vi.fn(async () => {})) {
  const listener = sdk.on.mock.calls.find(([event]) => event === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  await listener({ ...event, ack });
}
function resultFor(requestId: string) {
  const admission = admitted.get(requestId);
  if (admission?.kind !== 'accepted') throw new Error('Event was not admitted');
  return admission.operationId;
}
it('ACKs transport before persistence and reports acceptance only after durable save', async () => {
  const saving = deferred<void>(); const entered = deferred<void>();
  beforeSave = async () => { entered.resolve(); await saving.promise; };
  const ack = vi.fn(async () => {});
  const receiving = emit(message('hold save'), ack);
  await entered.promise;
  expect(ack).toHaveBeenCalledOnce();
  expect(events).toEqual([]);
  expect(sdk.post).not.toHaveBeenCalled();
  saving.resolve(); await receiving;
  expect(events[0]).toMatchObject({ conversationId: id, source: 'slack', event: { kind: 'human_command',
    command: { kind: 'message', text: 'hold save' }, speaker: { namespace: 'slack-user', id: '["T1","U1"]' } } });
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'C1', thread_ts: '1700000000.000001' }));
});
it('accepts Slack and TUI commands and reads and interrupts while another save is paused', async () => {
  const saving = deferred<void>(); const entered = deferred<void>();
  beforeSave = async (event) => { if (event.event.kind === 'human_command' && event.event.command.kind === 'message'
    && event.event.command.text === 'paused') { entered.resolve(); await saving.promise; } };
  const receiving = emit(message('paused'));
  await entered.promise;
  const selected = await createTuiConversationPort('/config', { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
  const opened = await input.open(selected, { deliver: async () => ({ kind: 'delivered' }) });
  await emit(message('next', '1700000000.000003'));
  expect(await input.submit({ attachmentId: opened.attachmentId, requestId: 'approve', speaker: selected.speaker,
    command: { kind: 'approve_summary', revision: 4 } })).toMatchObject({ kind: 'accepted' });
  expect((await input.snapshot(opened.attachmentId)).operationId).toBe(operationId);
  await input.submit({ attachmentId: opened.attachmentId, requestId: 'stop', speaker: selected.speaker,
    command: { kind: 'abort_turn', operationId, generation: 5 } });
  expect(ingress.control).toHaveBeenCalledExactlyOnceWith({ kind: 'interrupt', conversationId: id, operationId, generation: 5 });
  expect(events).toHaveLength(2);
  saving.resolve(); await receiving;
  expect(events).toHaveLength(3);
});
it('deduplicates a repeated Slack transport event using its stable request ID', async () => {
  const event = message('once');
  await emit(event); await emit(event);
  expect(ingress.accept).toHaveBeenCalledTimes(2);
  expect(events).toHaveLength(1);
  expect(vi.mocked(ingress.accept).mock.calls[0]![0].requestId).toBe(vi.mocked(ingress.accept).mock.calls[1]![0].requestId);
});
it('delivers each result once to the original thread and refuses another conversation or operation', async () => {
  await emit(message('reply here'));
  const event = events[0]!; const acceptedId = resultFor(event.requestId);
  sdk.post.mockClear();
  const output = { kind: 'result' as const, operationId: acceptedId, result: { kind: 'reply' as const, message: 'completed' } };
  await input.deliver(id, output, { ...version, operationId: 'wrong' });
  expect(sdk.post).not.toHaveBeenCalled();
  await input.deliver(id, output, { ...version, operationId: acceptedId });
  await input.deliver(id, output, { ...version, operationId: acceptedId });
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'C1', thread_ts: '1700000000.000001', text: 'completed' }));
  expect(input.connectedPorts(id)).toEqual([]);
});
it.each([{ user: 'unauthorized' }, { channel: 'other' }, { channel_type: 'im' }, { bot_id: 'bot' }])('ACKs but does not admit unauthorized input %j', async (extra) => {
  const ack = vi.fn(async () => {});
  await emit(message('ignored', undefined, extra), ack);
  expect(ack).toHaveBeenCalledOnce(); expect(ingress.accept).not.toHaveBeenCalled();
});
it('posts inquiry changes from delivery and routes a bound reply through a lazy snapshot', async () => {
  const question = createInquiry({ body: 'Width?' });
  const target = { goalId: randomUUID(), repositoryDirectory };
  items = [{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }];
  const output = { kind: 'inquiry' as const, target, question };
  await Promise.all([slack.delivery.deliver(id, output, version), slack.delivery.deliver(id, output, version)]);
  expect(sdk.post).toHaveBeenCalledOnce();
  const parentTs = 'posted-1';
  await emit(message('80', '1700000000.000004', { thread_ts: parentTs }));
  expect(events).toHaveLength(1);
  expect(events[0]!.event).toMatchObject({ kind: 'inquiry_answer', command: { kind: 'answer_question', target,
    questionId: question.id, answer: { text: '80' }, source: 'slack' } });
  expect(sdk.post).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: parentTs }));
});
it('keeps approval revision and conversation identity through a Slack button', async () => {
  await emit({ type: 'interactive', body: { type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C1' }, user: { id: 'U1' },
    container: { type: 'message', channel_id: 'C1', message_ts: 'proposal' }, message: { ts: 'proposal', thread_ts: 'origin' },
    actions: [{ type: 'button', action_id: 'takt_goal_approve', value: JSON.stringify({ conversationId: id, revision: 4 }) }] } });
  expect(events[0]!.event).toMatchObject({ kind: 'human_command', command: { kind: 'approve_summary', revision: 4, requirePending: true } });
  expect(sdk.post).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: 'origin' }));
});
it('does not admit a permission sentence from another modal user or team', async () => {
  const question = createInquiry({ kind: 'approval', body: 'Allow?', operation: { toolName: 'Bash', args: 'npm test', cwd: repositoryDirectory } });
  const target = { goalId: randomUUID(), repositoryDirectory };
  items = [{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }];
  await slack.delivery.deliver(id, { kind: 'inquiry', target, question }, version);
  await emit({ type: 'interactive', body: { type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C1' }, user: { id: 'U1' }, trigger_id: 'trigger',
    container: { type: 'message', channel_id: 'C1', message_ts: 'posted-1' }, message: { ts: 'posted-1' },
    actions: [{ type: 'button', action_id: 'takt_inquiry_answer_allow_project', value: 'allow_project' }] } });
  const metadata = sdk.open.mock.calls[0]![0].view.private_metadata as string;
  const modal = (teamId: string, userId: string): SlackEvent => ({ type: 'interactive', body: { type: 'view_submission', team: { id: teamId }, user: { id: userId },
    view: { callback_id: 'takt_inquiry_permission', private_metadata: metadata,
      state: { values: { permission: { sentence: { type: 'plain_text_input', value: 'Allow npm test.' } } } } } } });
  await emit(modal('T1', 'U2')); await emit(modal('other', 'U1'));
  expect(events).toEqual([]);
  await emit(modal('T1', 'U1'));
  expect(events[0]!.event).toMatchObject({ kind: 'inquiry_answer', command: { permission: {
    scope: { kind: 'project', projectDirectory: repositoryDirectory }, sentence: 'Allow npm test.' } } });
});
it('reports failed persistence without claiming business acceptance or retrying', async () => {
  vi.mocked(ingress.accept).mockResolvedValueOnce({ kind: 'rejected', reason: 'storage' });
  await emit(message('not saved'));
  expect(events).toEqual([]); expect(ingress.accept).toHaveBeenCalledOnce();
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: expect.stringContaining('storage') }));
});

it('routes workspace inquiries only through their repository channel and rejects cross-repository answers', async () => {
  const workspace = { kind: 'workspace' as const, workspaceId: randomUUID(), name: 'shared', repositoryDirectories: ['/a', '/b'] };
  const workspaceId = conversationId(workspace); const configDirectory = process.env.TAKT_CONFIG_DIR!;
  const client = createSlackClient({ appToken: 'fake-app', botToken: 'fake-bot' });
  const a = createSlackConversationPort({ repositoryDirectory: '/a', configDirectory, resolveAssignment: async () => workspace, channelId: 'CA', input, client, language: 'en' });
  const b = createSlackConversationPort({ repositoryDirectory: '/b', configDirectory, resolveAssignment: async () => workspace, channelId: 'CB', input, client, language: 'en' });
  try {
    const target = { repositoryDirectory: '/b', goalId: randomUUID() }; const question = createInquiry({ body: 'B only' });
    await a.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    await b.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'CB' }));
    await new SlackInquiryBindings(configDirectory, '/a').save({ channelId: 'CA', parentTs: 'forged', target, questionId: question.id });
    await a.receive({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'forged' }, 'answer');
    await a.receiveAction({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'forged' }, 'takt_inquiry_answer_allow_once', 'allow_once', 'trigger');
    expect(events).toEqual([]);
    expect(sdk.open).not.toHaveBeenCalled();
  } finally { await a.close(); await b.close(); await client.close(); }
});

it('checks the operation repository for standalone workspace inquiries on delivery and reply', async () => {
  const configDirectory = process.env.TAKT_CONFIG_DIR!;
  const a = join(configDirectory, 'standalone-a'); const b = join(configDirectory, 'standalone-b');
  await mkdir(join(b, 'nested'), { recursive: true }); await mkdir(a, { recursive: true });
  await promisify(execFile)('git', ['init', '--quiet', a]); await promisify(execFile)('git', ['init', '--quiet', b]);
  const repositories = await Promise.all([realpath(a), realpath(b)]);
  const workspace = { kind: 'workspace' as const, workspaceId: randomUUID(), name: 'shared', repositoryDirectories: repositories };
  const workspaceId = conversationId(workspace);
  const client = createSlackClient({ appToken: 'fake-app', botToken: 'fake-bot' });
  const portA = createSlackConversationPort({ repositoryDirectory: repositories[0]!, configDirectory, resolveAssignment: async () => workspace, channelId: 'CA', input, client, language: 'en' });
  const portB = createSlackConversationPort({ repositoryDirectory: repositories[1]!, configDirectory, resolveAssignment: async () => workspace, channelId: 'CB', input, client, language: 'en' });
  try {
    const target = { goalId: null, owner: { kind: 'workspace' as const, workspaceId: workspace.workspaceId } } as const;
    const question = createInquiry({ kind: 'approval', body: 'B operation', operation: { toolName: 'Bash', args: 'npm test', cwd: join(b, 'nested') } });
    await portA.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    await portB.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'CB' }));
    const base = await ingress.snapshot(id); items = [{ kind: 'inquiry', inquiry: { target, question } }];
    vi.mocked(ingress.snapshot).mockImplementation(async () => ({ ...base, conversationId: workspaceId, transferId: randomUUID(),
      turnState: { ...base.turnState, assignment: workspace }, items: (async function* () { yield* items; })() }));
    await new SlackInquiryBindings(configDirectory, repositories[0]!).save({ channelId: 'CA', parentTs: 'forged', target, questionId: question.id });
    await portA.receive({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'forged' }, 'answer');
    expect(events).toEqual([]);
    await portB.receiveAction({ teamId: 'T1', userId: 'U1', channelId: 'CB', parentTs: 'posted-1' }, 'takt_inquiry_answer_allow_once', 'allow_once', undefined);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ kind: 'inquiry_answer', command: { target, questionId: question.id } });
  } finally { await portA.close(); await portB.close(); await client.close(); }
});
