import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
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
import type { ConversationSnapshot, InquiryNotice } from '../core/daemon/messages.js';
import type { SnapshotItem } from '../features/manager/conversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod/v4';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { createWorkspace, removeWorkspaceRepository } from '../infra/config/global/workspaceRegistry.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { answerConversationInquiry } from '../features/manager/conversationAnswers.js';
import { buildSlackInquiry } from '../features/manager/slackInquiryBlocks.js';
import * as autoRun from '../features/manager/autoRun.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting, projectKey } from '../features/daemon/routing.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWatchSource } from './helpers/daemon-watch-source.js';

const sdk = vi.hoisted(() => ({ on: vi.fn(), start: vi.fn(), disconnect: vi.fn(), post: vi.fn() }));
vi.mock('@slack/socket-mode', () => ({ LogLevel: { ERROR: 'error' }, SocketModeClient: class {
  on = sdk.on; start = sdk.start; disconnect = sdk.disconnect;
} }));
vi.mock('@slack/web-api', () => ({ WebClient: class { chat = { postMessage: sdk.post }; } }));
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

it.each([
  { kind: 'repository' as const, body: 'Which goal?' },
  { kind: 'repository' as const, body: 'Q'.repeat(128 * 1024) },
  { kind: 'workspace' as const, body: 'どのゴールですか' },
  { kind: 'workspace' as const, body: '問'.repeat(128 * 1024) },
])('delivers an MCP question through the inquiry watcher to Slack ($kind, $body.length characters)', async ({ kind, body }) => {
  const configDirectory = process.env.TAKT_CONFIG_DIR!;
  const path = join(configDirectory, 'watched-question');
  await mkdir(path, { recursive: true });
  await promisify(execFile)('git', ['init', '--quiet', path]);
  const repository = await realpath(path);
  await registerProject({ globalConfigDirectory: configDirectory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const workspace = kind === 'workspace'
    ? await createWorkspace({ globalConfigDirectory: configDirectory, name: '担当', repositoryDirectories: [repository] }) : undefined;
  const owner = workspace === undefined ? { kind: 'repository' as const, repositoryDirectory: repository }
    : { kind: 'workspace' as const, workspaceId: workspace.id };
  const errors = vi.fn();
  const conversations = new DaemonConversations(new ConversationStateStore(configDirectory), new DaemonRouting(configDirectory),
    new DaemonNotifications(configDirectory), async () => {}, errors);
  const client = createSlackClient({ appToken: 'fake-app', botToken: 'fake-bot' });
  const port = createSlackConversationPort({ repositoryDirectory: repository, configDirectory,
    resolveAssignment: async () => workspace === undefined
      ? { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] }
      : { kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: [repository] },
    channelId: 'CW', input, client, language: 'en' });
  const publish = vi.fn(async (notice: InquiryNotice) => {
    await port.delivery.deliver(notice.conversationId, { kind: 'inquiry', target: notice.target, question: notice.question }, version);
  });
  const source = createWatchSource(conversations, publish, errors);
  const server = createTaktMcpServer({}, { toolSet: 'manager', managerAssignment: owner, allowedProjectRoot: repository });
  const mcp = new Client({ name: 'watched-question', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await source.inquiries();
    await server.connect(b); await mcp.connect(a);
    const result = await mcp.callTool({ name: 'takt_ask_standalone_question', arguments: {
      cwd: repository, body, options: ['Export', 'Import'], recommendation: 'Export',
    } });
    expect(result.isError).not.toBe(true);
    const { questionId } = z.object({ questionId: z.uuid() }).parse(JSON.parse(firstTextContent(result.content)));
    const directory = workspace === undefined ? join(configDirectory, 'projects', projectKey(repository))
      : join(configDirectory, 'workspaces', workspace.id);
    const stored = await readFile(join(directory, 'inquiries', `${questionId}.json`));
    if (body.length === 128 * 1024) expect(stored.byteLength).toBeGreaterThan(256 * 1024);
    await source.inquiries();
    expect(errors).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: conversationId(owner),
      target: expect.objectContaining({ goalId: null, owner: expect.objectContaining(owner) }),
      question: expect.objectContaining({ id: questionId, body, options: ['Export', 'Import'], recommendation: 'Export',
        operation: expect.objectContaining({ cwd: repository }) }) }));
    const question = await new StandaloneInquiryStore(configDirectory, owner).get(questionId);
    const expected = buildSlackInquiry({ goalId: null, owner, question }, 'en', 'expected');
    expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'CW', text: expected.text }));
  } finally {
    await mcp.close(); await server.close(); await port.close(); await client.close(); await conversations.close();
  }
});

it.each(['unchanged', 'removed', 'empty'] as const)('posts an MCP-created standalone question and preserves its Slack binding owner when %s', async (condition) => {
  vi.spyOn(autoRun, 'ensureManagerRun').mockResolvedValue(undefined);
  const configDirectory = process.env.TAKT_CONFIG_DIR!;
  const paths = [join(configDirectory, 'question-a'), join(configDirectory, 'question-b')];
  for (const path of paths) {
    await mkdir(path, { recursive: true });
    await promisify(execFile)('git', ['init', '--quiet', path]);
  }
  const repositories = await Promise.all(paths.map((path) => realpath(path)));
  const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: '担当', repositoryDirectories: repositories });
  const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
  let selected = { ...owner, name: workspace.name, repositoryDirectories: repositories };
  let channelAssignment: ManagerAssignment = selected;
  const workspaceId = conversationId(owner);
  const client = createSlackClient({ appToken: 'fake-app', botToken: 'fake-bot' });
  const portA = createSlackConversationPort({ repositoryDirectory: repositories[0]!, configDirectory,
    resolveAssignment: async () => selected, channelId: 'CA', input, client, language: 'en' });
  const portB = createSlackConversationPort({ repositoryDirectory: repositories[1]!, configDirectory,
    resolveAssignment: async () => channelAssignment, channelId: 'CB', input, client, language: 'en' });
  const server = createTaktMcpServer({}, { toolSet: 'manager', managerAssignment: owner, allowedProjectRoot: repositories[0]! });
  const mcp = new Client({ name: 'standalone-slack-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await mcp.connect(a);
    const result = await mcp.callTool({ name: 'takt_ask_standalone_question', arguments: {
      cwd: repositories[1]!, body: 'Which goal?', options: ['Export', 'Import'], recommendation: 'Export',
    } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const { questionId } = z.object({ questionId: z.uuid() }).parse(JSON.parse(firstTextContent(result.content)));
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const question = await store.get(questionId);
    const target = { goalId: null, owner };
    const output = { kind: 'inquiry' as const, target, question };
    await portA.delivery.deliver(workspaceId, output, version);
    await portB.delivery.deliver(workspaceId, output, version);
    const expected = buildSlackInquiry({ ...target, question }, 'en', 'expected');
    expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'CB', text: expected.text }));
    const posted = sdk.post.mock.calls[0]![0] as { blocks: unknown[] };
    expect(posted.blocks.slice(0, -1)).toEqual(expected.blocks.slice(0, -1));
    const base = await ingress.snapshot(id);
    if (condition !== 'unchanged') {
      let current = await removeWorkspaceRepository(configDirectory, workspace.id, repositories[1]!);
      if (condition === 'empty') current = await removeWorkspaceRepository(configDirectory, workspace.id, repositories[0]!);
      selected = { ...owner, name: current.name, repositoryDirectories: [...current.repositoryDirectories] };
      channelAssignment = { kind: 'repository', repositoryDirectory: repositories[1]!, repositoryDirectories: [repositories[1]!] };
    }
    vi.mocked(ingress.snapshot).mockImplementation(async (conversation) => ({ ...base, conversationId: conversation,
      turnState: { ...base.turnState, assignment: selected }, transferId: randomUUID(),
      items: (async function* () { if (conversation === workspaceId) yield { kind: 'inquiry' as const, inquiry: { target, question } }; })() }));
    beforeSave = async (event) => {
      if (event.event.kind !== 'inquiry_answer') throw new Error('Expected a question answer');
      expect(await answerConversationInquiry(event.event.command, selected, configDirectory, { signal: new AbortController().signal,
        request: async (request) => {
          expect(request).toEqual({ kind: 'publish_workspace_inquiry_answer', questionId });
          return { kind: 'event_accepted', admission: { kind: 'accepted', eventId: 'answer', operationId: 'answer', acceptedSequence: 1 } };
        } }, 'en'))
        .toMatchObject({ kind: 'answer_saved', answerSaved: true });
    };
    await portB.receive({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'posted-1' }, 'Export');
    expect(events).toHaveLength(0);
    await portB.receive({ teamId: 'T1', userId: 'U1', channelId: 'CB', parentTs: 'posted-1' }, 'Export');
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe(workspaceId);
    expect(events[0]!.event).toMatchObject({ kind: 'inquiry_answer', command: {
      target, questionId, answer: { text: 'Export' }, source: 'slack',
    } });
    expect(await store.get(questionId)).toMatchObject({ status: 'answered', answer: { text: 'Export', source: 'slack' } });
  } finally {
    try { await mcp.close(); } finally { await server.close(); }
    await portA.close(); await portB.close(); await client.close();
    vi.restoreAllMocks();
  }
});
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
    await a.receiveAction({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'forged' }, 'takt_inquiry_answer_report_completed', 'report_completed');
    expect(events).toEqual([]);
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
    const question = createInquiry({ kind: 'operation_request', body: 'B operation', operation: { toolName: 'Bash', args: 'npm test', cwd: join(b, 'nested') } });
    await portA.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    await portB.delivery.deliver(workspaceId, { kind: 'inquiry', target, question }, version);
    expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'CB' }));
    const base = await ingress.snapshot(id); items = [{ kind: 'inquiry', inquiry: { target, question } }];
    vi.mocked(ingress.snapshot).mockImplementation(async () => ({ ...base, conversationId: workspaceId, transferId: randomUUID(),
      turnState: { ...base.turnState, assignment: workspace }, items: (async function* () { yield* items; })() }));
    await new SlackInquiryBindings(configDirectory, repositories[0]!).save({ channelId: 'CA', parentTs: 'forged', target, questionId: question.id });
    await portA.receive({ teamId: 'T1', userId: 'U1', channelId: 'CA', parentTs: 'forged' }, 'answer');
    expect(events).toEqual([]);
    await portB.receiveAction({ teamId: 'T1', userId: 'U1', channelId: 'CB', parentTs: 'posted-1' }, 'takt_inquiry_answer_report_completed', 'report_completed');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ kind: 'inquiry_answer', command: { target, questionId: question.id } });
  } finally { await portA.close(); await portB.close(); await client.close(); }
});
