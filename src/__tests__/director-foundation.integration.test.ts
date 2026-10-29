import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { ConversationSpeakerStore } from '../infra/conversations/speakerStore.js';
import { DirectorNotificationStore } from '../infra/conversations/directorNotifications.js';
import { conversationId } from '../infra/conversations/identity.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { directorConversationRecord } from './helpers/conversation-fixtures.js';
import { GoalStore } from '../infra/goals/store.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { createConversationService } from '../features/manager/conversationService.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { createDaemonConversationRuntime } from '../features/director/conversationRuntime.js';
import { createDirectorConversationPlan } from '../features/director/conversationPlan.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { resolveNonWorkflowProviderOptions } from '../infra/config/index.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_NAMES, DIRECTOR_TOOL_ALLOWLIST } from '../features/director/mcp.js';
import { listDirectorManagers } from '../features/director/managers.js';
import { tellDirectorManager } from '../features/director/tellManager.js';
import { createDirectorManagerPort } from '../features/director/managerPort.js';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { startLocalMcpConnection } from '../features/mcp/localConnection.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { Goal } from '../infra/goals/schema.js';
import type { PreparedConversationRuntime, ConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { makeProvider } from './test-helpers.js';
import * as providers from '../infra/providers/index.js';
import * as readers from '../features/mcp/operations.js';
import * as slackWebhook from '../shared/utils/slackWebhook.js';
import type { ProviderAgent, Provider } from '../infra/providers/types.js';

const ids = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => ids.next() ?? actual.randomUUID() };
});

vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(), resolveGitRepositoryDirectory: async (value: string) => value,
}));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));
vi.mock('../infra/daemon/owner.js', async (original) => ({
  ...await original<typeof import('../infra/daemon/owner.js')>(), isDaemonOwnerRunning: () => true, readDaemonOwner: () => owner,
}));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: () => ({ ctx: { providerType: 'mock', model: undefined } }) }));

const owner = { pid: process.pid, identity: { startTime: 'director-test-owner' }, version: 'test', cliPath: '/test/cli.js' };
let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  ids.next.mockReset();
  directory = getGlobalConfigDir();
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
});
const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
const signal = () => new AbortController().signal;
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
function decoded(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === 'text')!.text!) as Record<string, unknown>;
}
async function connectMcp(notify = vi.fn(async () => {})) {
  const connection = await startLocalMcpConnection(() => createDirectorMcpServer(directory, { notify }, signal()));
  cleanups.push(connection.dispose);
  const client = new Client({ name: 'director-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
  await client.connect(transport);
  cleanups.push(async () => { await client.close(); await transport.close(); });
  return { client, notify, config: connection.config };
}
async function seedManager(name: string) {
  const repository = join(directory, name);
  mkdirSync(repository);
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  return repository;
}
function saveGoal(repository: string, status: 'created' | 'awaiting_merge', executionStatus: 'active' | 'paused') {
  const goal = { ...goalRecord(), status, executionStatus, questions: [createInquiry({ body: 'Choose the specification', recipient: 'human' })],
    notifications: [{ id: randomUUID(), kind: 'blocked', body: 'Human decision pending', recordedAt: new Date().toISOString() }],
    ...(status === 'awaiting_merge' ? { completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [],
    } } : {}) };
  const location = join(repository, '.takt', 'goals', goal.id);
  mkdirSync(location, { recursive: true });
  writeFileSync(join(location, 'goal.json'), JSON.stringify(goal));
  return goal;
}

it('lists all repository and workspace managers and reuses the existing paged goal and inquiry readers', async () => {
  const a = await seedManager('repository-a');
  const b = await seedManager('repository-b');
  const c = await seedManager('repository-c');
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'two repositories', repositoryDirectories: [b, c] });
  const empty = await createWorkspace({ globalConfigDirectory: directory, name: 'empty', repositoryDirectories: [] });
  const goalA = saveGoal(a, 'awaiting_merge', 'active');
  saveGoal(b, 'created', 'paused');
  const goalC = saveGoal(c, 'created', 'active');
  await new GoalStore(c).update(goalC.id, (goal) => ({ ...goal, questions: [createInquiry({ body: 'Earlier question', options: ['A', 'B'] })]
    .map((question) => ({ ...question, createdAt: '2026-01-01T00:00:00.000Z' })) }));
  const standaloneStore = new StandaloneInquiryStore(directory, { kind: 'workspace', workspaceId: workspace.id });
  const approval = await saveManagerToolPermissionInquiry({ configDirectory: directory, owner: { kind: 'workspace', workspaceId: workspace.id },
    request: { toolName: 'Write', toolInput: { file_path: join(b, 'result.txt'), content: 'hello' }, cwd: b }, reason: 'Approve a decision' });
  const list = vi.spyOn(readers, 'listTaktGoals');
  const detail = vi.spyOn(readers, 'getTaktGoal');
  const run = vi.spyOn(readers, 'getTaktRun');
  const { client } = await connectMcp();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  expect(tools.sort()).toEqual([...DIRECTOR_TOOL_NAMES].sort());
  for (const tool of ['Bash', 'Write', 'Edit', 'takt_get_run', 'takt_merge_goal_pr', 'takt_enqueue_task', 'takt_complete_goal', 'takt_abort_goal']) {
    expect((await client.callTool({ name: tool, arguments: {} })).isError).toBe(true);
  }
  const managers = await listDirectorManagers(directory);
  expect(managers).toHaveLength(3);
  expect(managers.map((assignment) => conversationId(assignment))).toEqual(expect.arrayContaining([
    conversationId({ kind: 'repository', repositoryDirectory: a }), conversationId({ kind: 'workspace', workspaceId: workspace.id }),
    conversationId({ kind: 'workspace', workspaceId: empty.id }),
  ]));
  const first = decoded(await client.callTool({ name: 'takt_list_managers', arguments: { limit: 1 } }));
  expect(first).toMatchObject({ totalCount: 3, returnedCount: 1, nextOffset: 1 });
  for (let offset = 0; offset <= managers.length; offset++) {
    const page = decoded(await client.callTool({ name: 'takt_list_managers', arguments: { offset, limit: 1 } }));
    expect(page).toMatchObject({ totalCount: 3, managers: managers.slice(offset, offset + 1).map((assignment) => ({ id: conversationId(assignment), assignment })),
      returnedCount: offset < 3 ? 1 : 0, nextOffset: offset < 2 ? offset + 1 : null });
  }
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: a });
  expect(decoded(await client.callTool({ name: 'takt_list_goals', arguments: { managerId, cwd: a } }))).toMatchObject({
    goals: [expect.objectContaining({ id: goalA.id, status: 'awaiting_merge' })],
  });
  expect(list).toHaveBeenCalledOnce();
  expect(decoded(await client.callTool({ name: 'takt_get_goal', arguments: { managerId, cwd: a, goalId: goalA.id, path: 'objective', maxBytes: 4 } })))
    .toMatchObject({ goalId: goalA.id, path: 'objective', truncated: true });
  expect(detail).toHaveBeenCalledOnce();
  expect(decoded(await client.callTool({ name: 'takt_get_goal', arguments: { managerId, cwd: a, goalId: goalA.id, path: 'notifications' } })))
    .toMatchObject({ items: [expect.objectContaining({ kind: 'blocked', body: 'Human decision pending' })] });
  const workspaceId = conversationId({ kind: 'workspace', workspaceId: workspace.id });
  expect(decoded(await client.callTool({ name: 'takt_list_goals', arguments: { managerId: workspaceId, cwd: b } })))
    .toMatchObject({ goals: [expect.objectContaining({ executionStatus: 'paused' })] });
  expect(decoded(await client.callTool({ name: 'takt_list_manager_inquiries', arguments: { managerId: workspaceId } })))
    .toMatchObject({ totalCount: 3, inquiries: expect.arrayContaining([expect.objectContaining({ goalId: null, question: approval })]) });
  const expected = await listPendingInquiries(directory, { kind: 'workspace', workspaceId: workspace.id, repositoryDirectories: [b, c] });
  for (let offset = 0; offset <= expected.inquiries.length; offset++) {
    const page = decoded(await client.callTool({ name: 'takt_list_manager_inquiries', arguments: { managerId: workspaceId, offset, limit: 1 } }));
    expect(page).toMatchObject({ totalCount: 3, inquiries: expected.inquiries.slice(offset, offset + 1),
      nextOffset: offset < 2 ? offset + 1 : null });
  }
  await standaloneStore.withdraw(approval.id, 'No longer needed');
  expect(decoded(await client.callTool({ name: 'takt_list_manager_inquiries', arguments: { managerId: workspaceId, limit: 1 } })))
    .toMatchObject({ totalCount: 2, inquiries: [expect.objectContaining({ repositoryDirectory: c })] });
  writeFileSync(join(b, '.takt', 'goals', goalC.id, 'goal.json'), '{invalid');
  const partial = await client.callTool({ name: 'takt_list_manager_inquiries', arguments: { managerId: workspaceId, limit: 1 } });
  expect(partial.isError).toBe(true);
  expect(decoded(partial)).toMatchObject({ totalCount: 1, inquiries: [expect.objectContaining({ repositoryDirectory: c })],
    errors: [{ repositoryDirectory: b, goalId: goalC.id }] });
  expect((await client.callTool({ name: 'takt_list_goals', arguments: { managerId, cwd: b } })).isError).toBe(true);
  expect((await client.callTool({ name: 'takt_list_goals', arguments: { managerId: `manager-${'0'.repeat(64)}`, cwd: a } })).isError).toBe(true);
  writeFileSync(join(a, '.takt', 'goals', goalA.id, 'goal.json'), '{invalid');
  const broken = await client.callTool({ name: 'takt_list_goals', arguments: { managerId, cwd: a } });
  expect(broken.isError).toBe(true);
  expect(decoded(broken)).toMatchObject({ errors: [expect.objectContaining({ goalId: goalA.id })] });
  expect(run).not.toHaveBeenCalled();
});

it('restores the director conversation after speaker storage rejects a TUI message', async () => {
  const original = directorConversationRecord();
  original.lastSpeaker = original.counterpart;
  const store = new ConversationStore(directory);
  store.write(original);
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({
    message: 'director reply', summary: null, sessionId: 'director-session', assignment: undefined,
  }));
  const resolve = vi.fn<ConversationRuntime['resolve']>(async () => ({ provider: 'mock', model: null, contextKey: 'director', language: 'en', executor: { execute } }));
  const service = createConversationService({ configDirectory: directory, owner,
    runtime: { resolve, close: async () => {} }, onDomainChange: vi.fn() });
  cleanups.push(service.close);
  const opened = await service.open({ conversationId: original.id, assignment: original.assignment,
    binding: original.bindings[0]!, speaker: original.counterpart }, delivery);
  opened.read.cancel();
  vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('speaker storage failed'); });
  const request = { attachmentId: opened.attachmentId, requestId: 'director-message', speaker: original.counterpart,
    command: { kind: 'message' as const, text: 'status' } };
  expect(await service.submit(request)).toMatchObject({ kind: 'error', code: 'storage_error' });
  expect(store.read(original.id, original.assignment)).toEqual(original);
  const snapshot = await service.snapshot(opened.attachmentId);
  expect((await snapshot.items[Symbol.asyncIterator]().next()).value).toMatchObject({ kind: 'state', state: { revision: 0, pending: null, running: null } });
  snapshot.cancel();
  expect(resolve).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(await service.submit(request)).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(execute).toHaveBeenCalledOnce();
  expect(store.read(original.id, original.assignment)).toMatchObject({ revision: 1, lastSpeaker: original.counterpart });
});

it.each(['ja', 'en'] as const)('loads four director facets through provider setup and saves notifications before live and reconnect delivery in %s', async (lang) => {
  const slack = vi.spyOn(slackWebhook, 'sendSlackNotification').mockResolvedValue(undefined);
  writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ${lang}\nmodel: global-model\n`);
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  const setup = vi.fn();
  const preflight = vi.fn<NonNullable<Provider['preflight']>>(async () => {});
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP MCP required');
    const client = new Client({ name: 'fake-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const notification = decoded(await client.callTool({ name: 'takt_notify_human', arguments: { message: 'Human decision required' } }));
      expect(await collect(new DirectorNotificationStore(directory).iterate())).toContainEqual(notification);
    } finally { await client.close(); await transport.close(); }
    return { persona: 'director', status: 'done', content: 'reply', timestamp: new Date(), sessionId: 'director-session' };
  });
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']), preflight, setup: (value) => { setup(value); return { call }; } }));
  const outputs: PortOutput[] = [];
  const runtime = createDaemonConversationRuntime(directory, { notify: (notification) => service.notifyDirector(notification) });
  const service = createConversationService({ configDirectory: directory, owner, runtime, onDomainChange: vi.fn() });
  const server = await createConversationIpcServer(directory, owner, service);
  cleanups.push(server.close, service.close);
  const selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'daemon' });
  const client = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => client.close());
  client.onOutput((output) => outputs.push(output));
  await client.connect();
  const accepted = await client.submit({ kind: 'message', text: 'Check managers' });
  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(call).toHaveBeenCalledOnce();
  const prompt = setup.mock.calls[0]![0].systemPrompt as string;
  for (const category of ['personas', 'policies', 'knowledge', 'instructions']) {
    expect(prompt).toContain(readFileSync(join(process.cwd(), 'builtins', lang, 'facets', category, 'director.md'), 'utf8').trim());
  }
  for (const options of [preflight.mock.calls[0]![0], call.mock.calls[0]![1]]) {
    expect(options).toMatchObject({ permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST, model: 'global-model', cwd: directory });
    expect(Object.keys(options.mcpServers!)).toEqual([DIRECTOR_MCP_SERVER_NAME]);
  }
  await vi.waitFor(() => expect(outputs.some((output) => output.kind === 'notice' && output.message === 'Human decision required')).toBe(true));
  const notice = outputs.find((output) => output.kind === 'notice' && output.message === 'Human decision required');
  expect(notice).toBeDefined();
  client.close();
  const reopened = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => reopened.close());
  await reopened.connect();
  await vi.waitFor(() => expect(reopened.getSnapshot().readStatus).toBe('complete'));
  expect(reopened.getSnapshot().items).toContainEqual({ kind: 'display_event', event: { id: notice!.kind === 'notice' ? notice!.id : '', message: 'Human decision required' } });
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toMatchObject({ agent: 'director', sessionId: 'director-session' });
  expect(slack).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('supplies the saved goal fields and existing tools for merge forwarding in the %s director prompt', (lang) => {
  writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ${lang}\n`);
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']) }));

  const { systemPrompt } = createDirectorConversationPlan(directory, {});

  // 判断精度ではなく、実行時入力に必要な道具と保存値の参照が含まれることを確認する。
  for (const reference of ['takt_get_goal', 'awaiting_merge', 'pullRequest', 'takt_tell_manager', 'takt_merge_goal_pr']) {
    expect(systemPrompt, reference).toContain(reference);
  }
});

it.each(['ja', 'en'] as const)('relays a human merge request through director MCP and IPC with the saved PR and speaker in %s', async (lang) => {
  writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ${lang}\n`);
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  const repository = await seedManager('merge-repository');
  const otherRepository = await seedManager('other-repository');
  const goal = saveGoal(repository, 'awaiting_merge', 'active');
  const pullRequest = { number: 1950, url: 'https://github.invalid/example/project/pull/1950' };
  await new GoalStore(repository).update(goal.id, (saved) => ({ ...saved, pullRequest }));
  const otherGoal = saveGoal(otherRepository, 'awaiting_merge', 'active');
  await new GoalStore(otherRepository).update(otherGoal.id, (saved) => ({ ...saved,
    pullRequest: { number: 1949, url: 'https://github.invalid/example/other/pull/1949' } }));
  const assignment = { kind: 'repository' as const, repositoryDirectory: repository };
  const managerId = conversationId(assignment);
  const humanMessage = lang === 'ja' ? `${repository} のゴール ${goal.id} をマージして`
    : `Merge goal ${goal.id} in ${repository}`;
  const managerReply = lang === 'ja' ? 'マージ指示を受け取りました。' : 'Merge instruction received.';
  const slack = vi.spyOn(slackWebhook, 'sendSlackNotification').mockResolvedValue(undefined);
  const toolCalls = vi.spyOn(Client.prototype, 'callTool');
  let managerOperationId: string | undefined;
  const managerCall = vi.fn<ProviderAgent['call']>(async () => {
    const conversation = new ConversationStore(directory).read(managerId, assignment);
    expect(conversation).toBeDefined();
    managerOperationId = conversation!.running?.operationId;
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { message: managerReply, summary: null }, sessionId: 'manager-merge-session' };
  });
  const managerExecutor = createManagerTurnExecutor(repository, {
    ctx: { provider: makeProvider({ setup: () => ({ call: managerCall }) }), providerType: 'mock', model: undefined, lang },
    strategy: { systemPrompt: 'manager provider test double' },
  });
  const directorCall = vi.fn<ProviderAgent['call']>(async (prompt, options) => {
    expect(prompt).toBe(humanMessage);
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP MCP required');
    const client = new Client({ name: 'merge-director-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect([...tools].sort()).toEqual([...DIRECTOR_TOOL_NAMES].sort());
      expect(options.permissionMode).toBe('readonly');
      expect([...options.strictToolAllowlist!].sort()).toEqual(tools.map((name) => `mcp__${DIRECTOR_MCP_SERVER_NAME}__${name}`).sort());
      expect(Object.keys(options.mcpServers!)).toEqual([DIRECTOR_MCP_SERVER_NAME]);
      for (const forbidden of ['Bash', 'Write', 'Edit', 'takt_merge_goal_pr']) {
        expect(tools).not.toContain(forbidden);
        expect(options.strictToolAllowlist).not.toContain(`mcp__${DIRECTOR_MCP_SERVER_NAME}__${forbidden}`);
      }
      const managers = decoded(await client.callTool({ name: 'takt_list_managers', arguments: {} })).managers as
        Array<{ id: string; assignment: { repositoryDirectories: string[] } }>;
      const selected = managers.find((manager) => manager.assignment.repositoryDirectories.includes(repository));
      expect(selected?.id).toBe(managerId);
      const goals = decoded(await client.callTool({ name: 'takt_list_goals',
        arguments: { managerId: selected!.id, cwd: repository } })).goals as Array<Pick<Goal, 'id' | 'pullRequest'>>;
      const selectedGoal = goals.find((candidate) => candidate.id === goal.id);
      expect(selectedGoal).toMatchObject({ id: goal.id, pullRequest });
      const detail = decoded(await client.callTool({ name: 'takt_get_goal',
        arguments: { managerId: selected!.id, cwd: repository, goalId: selectedGoal!.id } })).goal as
        Pick<Goal, 'id' | 'status' | 'pullRequest'>;
      expect(detail).toMatchObject({ id: goal.id, status: 'awaiting_merge', pullRequest });
      const text = lang === 'ja'
        ? `人の明示の指示により、${repository} のゴール ${detail.id} の PR #${detail.pullRequest!.number} を takt_merge_goal_pr でマージしてください。`
        : `On the human's explicit instruction, merge PR #${detail.pullRequest!.number} for goal ${detail.id} in ${repository} using takt_merge_goal_pr.`;
      const reply = decoded(await client.callTool({ name: 'takt_tell_manager', arguments: { managerId: selected!.id, text } }));
      expect(reply).toEqual({ kind: 'reply', message: managerReply });
      return { persona: 'director', status: 'done', content: reply.message as string, timestamp: new Date() };
    } finally { await client.close(); await transport.close(); }
  });
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']), setup: () => ({ call: directorCall }) }));
  const directorRuntime = createDaemonConversationRuntime(directory, { notify: async () => {} });
  const runtime: ConversationRuntime = {
    resolve: async (selected, abortSignal, overrides) => {
      if (selected.kind === 'daemon') return directorRuntime.resolve(selected, abortSignal, overrides);
      expect(selected).toMatchObject(assignment);
      return { provider: 'mock', model: null, language: lang, contextKey: 'merge-test', executor: managerExecutor };
    },
    close: () => directorRuntime.close(),
  };
  const service = createConversationService({ configDirectory: directory, owner, runtime, onDomainChange: vi.fn() });
  cleanups.push(service.close);
  const submissions = vi.spyOn(service, 'submit');
  const server = await createConversationIpcServer(directory, owner, service);
  cleanups.push(server.close);
  const human = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => human.close());
  const outputs: PortOutput[] = [];
  human.onOutput((output) => outputs.push(output));
  await human.connect();

  const accepted = await human.submit({ kind: 'message', text: humanMessage });

  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result',
    operationId: accepted.kind === 'accepted' ? accepted.operationId : '', result: { kind: 'reply', message: managerReply } })));
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(directorCall).toHaveBeenCalledOnce();
  expect(managerCall).toHaveBeenCalledOnce();
  const forwarded = submissions.mock.calls.map(([request]) => request)
    .find((request) => request.speaker.namespace === 'agent' && request.speaker.id === 'director');
  expect(forwarded).toMatchObject({ command: { kind: 'message', text: expect.stringContaining('PR #1950') } });
  const command = forwarded!.command;
  if (command.kind !== 'message') throw new Error('Manager message required');
  expect(command.text).toContain(repository);
  expect(command.text).toContain(goal.id);
  expect(command.text).toContain('takt_merge_goal_pr');
  expect(command.text).toContain(lang === 'ja' ? '人の明示の指示' : "human's explicit instruction");
  expect(managerCall.mock.calls[0]![0]).toContain(command.text);
  expect(managerCall.mock.calls[0]![0]).toContain('Speaker: {"namespace":"agent","id":"director"}');
  expect(managerCall.mock.calls[0]![1].cwd).toBe(repository);
  expect(managerOperationId).toBeTypeOf('string');
  expect(await collect(new ConversationSpeakerStore(directory).iterate(managerId))).toEqual([
    { conversationId: managerId, operationId: managerOperationId, actor: { namespace: 'agent', id: 'director' } },
  ]);
  expect(await collect(new ConversationSpeakerStore(directory).iterate(conversationId({ kind: 'repository', repositoryDirectory: otherRepository })))).toEqual([]);
  expect(toolCalls.mock.calls.map(([request]) => request.name)).toEqual([
    'takt_list_managers', 'takt_list_goals', 'takt_get_goal', 'takt_tell_manager',
  ]);
  expect(slack).not.toHaveBeenCalled();
});

it('never overwrites an existing notification when the generated identity collides', async () => {
  const store = new DirectorNotificationStore(directory);
  const first = store.create('first');
  ids.next.mockReturnValueOnce(first.id);
  const second = store.create('second');
  expect(second.id).not.toBe(first.id);
  expect(await collect(store.iterate())).toEqual(expect.arrayContaining([first, second]));
});

it('closes the director MCP listener after failed preflight and permits a new preparation', async () => {
  const preflight = vi.fn<NonNullable<Provider['preflight']>>().mockRejectedValueOnce(new Error('preflight failed')).mockResolvedValue(undefined);
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({
    supportsStrictToolAllowlist: true, supportedMcpTransports: new Set(['http']), preflight,
  }));
  const runtime = createDaemonConversationRuntime(directory, { notify: async () => {} });
  cleanups.push(runtime.close);
  await expect(runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal())).rejects.toThrow();
  const closed = preflight.mock.calls[0]![0].mcpServers![DIRECTOR_MCP_SERVER_NAME]!;
  if (closed.type !== 'http') throw new Error('HTTP MCP required');
  await expect(fetch(closed.url, { method: 'POST', headers: closed.headers })).rejects.toThrow();
  expect(await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal())).toMatchObject({ provider: 'mock' });
  expect(preflight).toHaveBeenCalledTimes(2);
});

it('uses global assistant settings and runtime profiles and rejects providers without strict tool support', () => {
  const project = join(directory, 'launching-repository', '.takt');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'config.yaml'), 'provider: codex\nmodel: project-model\n');
  expect(createDirectorConversationPlan(directory, { model: 'cli-model' }).ctx).toMatchObject({ providerType: 'mock', model: 'cli-model' });
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nmodel: global-default\ntakt_providers:\n  assistant:\n    provider: mock\n    model: global-assistant\n');
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  expect(createDirectorConversationPlan(directory, {}).ctx).toMatchObject({ providerType: 'mock', model: 'global-assistant' });
  writeFileSync(join(directory, 'config.yaml'), 'language: en\n');
  writeFileSync(join(directory, 'runtime.yaml'), [
    'version: 1', 'provider:', '  profiles:', '    chosen:', '      provider: mock', '      model: runtime-model',
    '  defaults:', '    profile: chosen', '  targets:', '    internal_agents:', '      assistant:', '        profile: chosen',
  ].join('\n'));
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  expect(createDirectorConversationPlan(directory, {}).ctx).toMatchObject({ providerType: 'mock', model: 'runtime-model' });
  expect(createDirectorConversationPlan(directory, { model: 'override' }).ctx.model).toBe('override');
  expect(() => createDirectorConversationPlan(directory, { provider: 'codex' })).toThrow();
});

it.each(['legacy', 'runtime'] as const)('disables director skills after resolving %s options without changing other settings', async (source) => {
  const configured = { network_access: false, variant: 'high', guards: { profile: 'minimal' }, skills: { enabled: true } };
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify({ language: 'en',
    ...(source === 'legacy' ? { provider: 'opencode', model: 'probe/probe', provider_options: { opencode: configured } } : {}) }));
  if (source === 'runtime') {
    writeFileSync(join(directory, 'runtime.yaml'), JSON.stringify({ version: 1, provider: {
      profiles: { chosen: { provider: 'opencode', model: 'probe/probe', options: configured } },
      defaults: { profile: 'chosen' }, targets: { internal_agents: { assistant: { profile: 'chosen' } } },
    } }));
  }
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  const original = source === 'legacy' ? resolveNonWorkflowProviderOptions(directory, undefined, undefined, 'opencode')
    : resolveAssistantProviderModel(directory, {}).providerOptions;
  const preflight = vi.fn<NonNullable<Provider['preflight']>>(async () => {});
  const call = vi.fn<ProviderAgent['call']>(async () => ({ persona: 'director', status: 'done', content: 'reply', timestamp: new Date() }));
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']), preflight, setup: () => ({ call }) }));
  const plan = createDirectorConversationPlan(directory, {});
  const expected = { opencode: { networkAccess: false, variant: 'high', guards: { profile: 'minimal' }, skills: { enabled: false } } };
  expect(plan.ctx).toMatchObject({ providerType: 'opencode', model: 'probe/probe', providerOptions: expected });
  const runtime = createDaemonConversationRuntime(directory, { notify: async () => {} });
  cleanups.push(runtime.close);
  const prepared = await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  await prepared.executor.execute({ prompt: 'task', instruction: 'task', sessionId: undefined, assignment: undefined,
    configDirectory: directory, abortSignal: signal() });
  for (const options of [preflight.mock.calls[0]![0], call.mock.calls[0]![1]]) {
    expect(options).toMatchObject({ providerOptions: expected, permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST });
  }
  expect(original?.opencode?.skills?.enabled).toBe(true);
  expect(source === 'legacy' ? resolveNonWorkflowProviderOptions(directory, undefined, undefined, 'opencode')
    : resolveAssistantProviderModel(directory, {}).providerOptions).toEqual(original);
});

it.each([
  { source: 'legacy', enabled: undefined }, { source: 'legacy', enabled: false },
  { source: 'runtime', enabled: undefined }, { source: 'runtime', enabled: false },
])('explicitly disables director skills for $source with enabled=$enabled', ({ source, enabled }) => {
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify(source === 'legacy'
    ? { provider: 'opencode', model: 'probe/probe',
      ...(enabled === undefined ? {} : { provider_options: { opencode: { skills: { enabled } } } }) }
    : { language: 'en' }));
  if (source === 'runtime') {
    writeFileSync(join(directory, 'runtime.yaml'), JSON.stringify({ version: 1, provider: {
      profiles: { chosen: { provider: 'opencode', model: 'probe/probe',
        ...(enabled === undefined ? {} : { options: { skills: { enabled } } }) } },
      defaults: { profile: 'chosen' }, targets: { internal_agents: { assistant: { profile: 'chosen' } } },
    } }));
  }
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  expect(createDirectorConversationPlan(directory, {}).ctx.providerOptions).toMatchObject({ opencode: { skills: { enabled: false } } });
});

it('preserves skill settings for a non-OpenCode director provider', () => {
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify({ provider: 'claude-sdk', model: 'sonnet',
    provider_options: { claude: { skills: { enabled: true } } } }));
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  expect(createDirectorConversationPlan(directory, {}).ctx).toMatchObject({ providerType: 'claude-sdk', model: 'sonnet',
    providerOptions: { claude: { skills: { enabled: true } } } });
});

it('rejects transcript fields and corrupt speaker and notification records instead of returning empty data', async () => {
  const id = conversationId({ kind: 'repository', repositoryDirectory: '/repository' });
  const record = { conversationId: id, operationId: randomUUID(), actor: { namespace: 'local', id: 'operator' } };
  const speakers = new ConversationSpeakerStore(directory);
  expect(() => speakers.write({ ...record, ...{ text: 'must not be stored' } })).toThrow();
  speakers.write(record);
  writeFileSync(join(directory, 'conversation-speakers', id, `${record.operationId}.json`), JSON.stringify({ ...record, conversationId: conversationId({ kind: 'daemon' }) }));
  await expect(collect(speakers.iterate(id))).rejects.toThrow();
  const notifications = new DirectorNotificationStore(directory);
  const notification = notifications.create('preserved notice');
  writeFileSync(join(directory, 'director-notifications', `${notification.id}.json`), '{invalid');
  await expect(collect(notifications.iterate())).rejects.toThrow();
});

it('sends director messages over real IPC, correlates replies, records each actor and never queues busy messages', async () => {
  const repository = await seedManager('manager-repository');
  const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: `reply:${input.instruction}`, summary: null,
    sessionId: 'manager-session', assignment: input.assignment }));
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  const server = await createConversationIpcServer(directory, owner, service);
  cleanups.push(server.close, service.close);
  const selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const human = await service.open(selected, delivery);
  const submit = async (text: string) => service.submit({ attachmentId: human.attachmentId, requestId: randomUUID(), speaker: selected.speaker, command: { kind: 'message', text } });
  await submit('human');
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  const { client: mcp } = await connectMcp();
  expect(decoded(await mcp.callTool({ name: 'takt_tell_manager', arguments: { managerId: selected.conversationId, text: 'director' } })))
    .toEqual({ kind: 'reply', message: 'reply:director' });
  const slackActor = { namespace: 'slack-user', id: 'T1:U1' };
  const slack = await service.open({ ...selected, speaker: slackActor, binding: { port: 'slack', key: 'thread', counterpart: selected.speaker } }, delivery);
  await service.submit({ attachmentId: slack.attachmentId, requestId: 'slack', speaker: slackActor, command: { kind: 'message', text: 'slack' } });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  const speakers = await collect(new ConversationSpeakerStore(directory).iterate(selected.conversationId));
  expect(speakers.map((record) => record.actor)).toEqual(expect.arrayContaining([selected.speaker, { namespace: 'agent', id: 'director' }, slackActor]));
  expect(speakers).toHaveLength(3);
  for (const record of speakers) expect(Object.keys(record).sort()).toEqual(['actor', 'conversationId', 'operationId']);
  let release!: () => void;
  execute.mockImplementationOnce(async (input) => { await new Promise<void>((resolve) => { release = resolve; });
    return { message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment }; });
  try {
    await submit('running human');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(decoded(await mcp.callTool({ name: 'takt_tell_manager', arguments: { managerId: selected.conversationId, text: 'rejected' } })))
      .toMatchObject({ kind: 'busy' });
  } finally { release?.(); }
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['human', 'director', 'slack', 'running human']);
  expect(await collect(new ConversationSpeakerStore(directory).iterate(selected.conversationId))).toHaveLength(4);
  const spy = vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('metadata unavailable'); });
  expect(await submit('not accepted')).toMatchObject({ kind: 'error', code: 'storage_error' });
  expect(execute).toHaveBeenCalledTimes(4);
  spy.mockRestore();
  expect(await submit('explicit retry')).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  const restricted = new ConversationIpcClient(selected.assignment, undefined, {
    port: createDirectorManagerPort(directory, delivery), reconnect: false,
  });
  try {
    await restricted.connect();
    await expect(restricted.submit({ kind: 'pause_goal', goalId: randomUUID() })).rejects.toMatchObject({ cause: 'invalid_input' });
    expect(execute).toHaveBeenCalledTimes(5);
  } finally { restricted.close(); }
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'promoted manager', repositoryDirectories: [repository] });
  const workspaceId = conversationId({ kind: 'workspace', workspaceId: workspace.id });
  expect(await tellDirectorManager(directory, workspaceId, 'workspace request', signal())).toEqual({ kind: 'reply', message: 'reply:workspace request' });
});

it('does not resend an accepted manager message after losing its IPC connection', async () => {
  const repository = await seedManager('disconnect-repository');
  let release!: () => void;
  const execute = vi.fn(async (input: ManagerTurnInput) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { message: 'finished after disconnect', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  const server = await createConversationIpcServer(directory, owner, service);
  cleanups.push(service.close);
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const pending = tellDirectorManager(directory, managerId, 'one message', signal());
  const rejected = expect(pending).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await server.close();
    await rejected;
    expect(service.activeOperationCount).toBe(1);
  } finally { release?.(); }
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('one message');
});
