import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { getLabel } from '../shared/i18n/index.js';
import { invalidateGlobalConfigCache, loadGlobalConfig, saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { ConversationSpeakerStore } from '../infra/conversations/speakerStore.js';
import { DirectorNotificationStore } from '../infra/conversations/directorNotifications.js';
import { DirectorMessageResultStore } from '../infra/conversations/directorMessageResults.js';
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
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import * as goalPrMerge from '../features/manager/mergeGoalPr.js';
import * as goalIntegration from '../features/mcp/goalIntegrationOperations.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { Goal } from '../infra/goals/schema.js';
import type { PreparedConversationRuntime, ConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { makeProvider } from './test-helpers.js';
import * as providers from '../infra/providers/index.js';
import * as readers from '../features/mcp/operations.js';
import * as slackWebhook from '../shared/utils/slackWebhook.js';
import type { ProviderAgent, Provider } from '../infra/providers/types.js';
import * as timerPromises from 'node:timers/promises';
import type { TimerOptions } from 'node:timers';
import { parse as parseYaml } from 'yaml';
import { runDaemon } from '../features/daemon/runDaemon.js';
import * as daemonOwners from '../infra/daemon/owner.js';
import * as processIdentity from '../infra/task/process.js';
import * as cliInvocation from '../shared/utils/cli-invocation.js';
import * as slackPorts from '../features/daemon/slackPorts.js';
import * as slackClient from '../infra/slack/client.js';
import type { SlackClient, SlackEvent } from '../infra/slack/client.js';
import { loadGlobalConfigTrace } from '../infra/config/traced/tracedConfigLoader.js';
import type { ConversationInput } from '../features/manager/conversationPort.js';
import * as taskRecovery from '../features/tasks/execute/claimTasks.js';
import * as autoRun from '../features/manager/autoRun.js';
import * as eventManagers from '../features/manager/runEventManager.js';
import * as managerPlans from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { enqueueDueGoalPatrols } from '../features/manager/patrol.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { TaskStore } from '../infra/task/store.js';
import * as localMcp from '../features/mcp/localConnection.js';
import type { RunMeta } from '../core/workflow/run/run-meta.js';
import { packageVersion } from '../shared/package-info.js';
import * as privateFiles from '../shared/utils/private-file.js';

const ids = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('node:timers/promises', async (original) => ({ ...await original<typeof import('node:timers/promises')>() }));
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
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  }
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
async function connectMcp(notify = vi.fn(async () => {}), patrol = false) {
  const connection = await startLocalMcpConnection(() => createDirectorMcpServer(directory, { notify }, signal(), patrol));
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
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
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
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 30_000 });
  expect(call).toHaveBeenCalledOnce();
  const prompt = setup.mock.calls[0]![0].systemPrompt as string;
  for (const category of ['personas', 'policies', 'knowledge', 'instructions']) {
    expect(prompt).toContain(readFileSync(join(process.cwd(), 'builtins', lang, 'facets', category, 'director.md'), 'utf8').trim());
  }
  for (const options of [preflight.mock.calls[0]![0], call.mock.calls[0]![1]]) {
    expect(options).toMatchObject({ permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST, model: 'global-model', cwd: directory });
    expect(Object.keys(options.mcpServers!)).toEqual([DIRECTOR_MCP_SERVER_NAME]);
  }
  await vi.waitFor(() => expect(outputs.some((output) => output.kind === 'notice' && output.message === 'Human decision required')).toBe(true), { timeout: 5000 });
  const notice = outputs.find((output) => output.kind === 'notice' && output.message === 'Human decision required');
  expect(notice).toBeDefined();
  client.close();
  const reopened = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => reopened.close());
  await reopened.connect();
  await vi.waitFor(() => expect(reopened.getSnapshot().readStatus).toBe('complete'), { timeout: 5000 });
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
  const managerConnection = await startManagerMcpConnection(repository, assignment);
  cleanups.push(managerConnection.dispose);
  const merging = vi.spyOn(goalPrMerge, 'mergeGoalPr').mockResolvedValue({ success: true, prNumber: 1950, exitCode: 0, output: 'merged', truncated: false });
  let managerOperationId: string | undefined;
  const additionalHuman = new ConversationIpcClient(assignment);
  cleanups.push(async () => additionalHuman.close());
  const managerCall = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const conversation = new ConversationStore(directory).read(managerId, assignment);
    expect(conversation).toBeDefined();
    managerOperationId = conversation!.running?.operationId;
    expect(await additionalHuman.submit({ kind: 'message', text: 'additional human message' }))
      .toEqual({ kind: 'busy', operationId: managerOperationId });
    expect(new ConversationStore(directory).read(managerId, assignment)).toMatchObject({
      lastSpeaker: { namespace: 'agent', id: 'director' }, running: { operationId: managerOperationId },
    });
    const config = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME];
    if (config?.type !== 'http') throw new Error('HTTP MCP required');
    const client = new Client({ name: 'merge-manager-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const operationId = _prompt.match(/Conversation operation ID: ([a-f0-9-]{36})/)?.[1];
      expect(operationId).toBe(managerOperationId);
      const result = await client.callTool({ name: 'takt_merge_goal_pr', arguments: {
        cwd: repository, goalId: goal.id, prNumber: 1950, conversationOperationId: operationId,
      } });
      expect(result.isError).toBeUndefined();
    } finally { await client.close(); await transport.close(); }
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { message: managerReply, summary: null }, sessionId: 'manager-merge-session' };
  });
  const managerExecutor = createManagerTurnExecutor(repository, {
    ctx: { provider: makeProvider({ setup: () => ({ call: managerCall }) }), providerType: 'mock', model: undefined, lang,
      mcpServers: { [TAKT_MANAGER_MCP_SERVER_NAME]: managerConnection.config } },
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
  await additionalHuman.connect();

  const accepted = await human.submit({ kind: 'message', text: humanMessage });

  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result',
    operationId: accepted.kind === 'accepted' ? accepted.operationId : '', result: { kind: 'reply', message: managerReply } })), { timeout: 30_000 });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 30_000 });
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
    'takt_list_managers', 'takt_list_goals', 'takt_get_goal', 'takt_tell_manager', 'takt_merge_goal_pr',
  ]);
  expect(merging).toHaveBeenCalledExactlyOnceWith(repository, 1950, goal.branch, goal.completion!.goalSha, expect.any(AbortSignal));
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

it('releases prepared MCP before reporting a settings save failure and succeeds on the next turn in the same runtime', async () => {
  const preflight = vi.fn<NonNullable<Provider['preflight']>>(async (options) => {
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME]!;
    if (config.type !== 'http') throw new Error('HTTP MCP required');
    await fetch(config.url, { method: 'POST', headers: config.headers });
  });
  const call = vi.fn<ProviderAgent['call']>(async () => ({ persona: 'director', status: 'done', content: 'recovered',
    timestamp: new Date(), sessionId: 'recovered-session' }));
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']), preflight, setup: () => ({ call }) }));
  const original = directorConversationRecord();
  new ConversationStore(directory).write(original);
  const runtime = createDaemonConversationRuntime(directory, { notify: async () => {} });
  const service = createConversationService({ configDirectory: directory, owner, runtime, onDomainChange: vi.fn() });
  cleanups.push(service.close);
  const outputs: PortOutput[] = [];
  const opened = await service.open({ conversationId: original.id, assignment: original.assignment,
    binding: original.bindings[0]!, speaker: original.counterpart, agentOverrides: { model: 'new-model' } }, {
    deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; },
  });
  opened.read.cancel();
  const write = ConversationStore.prototype.write;
  let failSave = true;
  const writes = vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, record) {
    if (failSave && record.model === 'new-model') {
      failSave = false;
      throw new Error('settings save failed');
    }
    return write.call(this, record);
  });
  const submit = () => service.submit({ attachmentId: opened.attachmentId, requestId: randomUUID(),
    speaker: original.counterpart, command: { kind: 'message', text: 'status' } });
  expect(await submit()).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(outputs.filter((output) => output.kind === 'result')).toHaveLength(1), { timeout: 5000 });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({ kind: 'error', code: 'storage_error' }) }));
  expect(call).not.toHaveBeenCalled();
  const first = preflight.mock.calls[0]![0].mcpServers![DIRECTOR_MCP_SERVER_NAME]!;
  if (first.type !== 'http') throw new Error('HTTP MCP required');
  await expect(fetch(first.url, { method: 'POST', headers: first.headers })).rejects.toThrow();
  const snapshot = await service.snapshot(opened.attachmentId);
  snapshot.cancel();
  expect(await submit()).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(outputs.filter((output) => output.kind === 'result')).toHaveLength(2), { timeout: 5000 });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'recovered' } }));
  expect(call).toHaveBeenCalledOnce();
  expect(preflight).toHaveBeenCalledTimes(2);
  const second = preflight.mock.calls[1]![0].mcpServers![DIRECTOR_MCP_SERVER_NAME]!;
  if (second.type !== 'http') throw new Error('HTTP MCP required');
  await expect(fetch(second.url, { method: 'POST', headers: second.headers })).rejects.toThrow();
  expect(new ConversationStore(directory).read(original.id, original.assignment)).toMatchObject({ model: 'new-model', sessionId: 'recovered-session', running: null });
  writes.mockRestore();
});

it.each([false, true])('awaits release before reporting storage_error even when cleanup fails=%s', async (cleanupFails) => {
  const original = directorConversationRecord();
  new ConversationStore(directory).write(original);
  let finish!: () => void;
  const release = vi.fn(() => new Promise<void>((resolve, reject) => {
    finish = () => cleanupFails ? reject(new Error('cleanup failed')) : resolve();
  }));
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>();
  const runtime: ConversationRuntime = { resolve: async () => ({ provider: 'mock', model: 'new-model', language: 'en',
    contextKey: 'director', executor: { execute }, release }), close: async () => {} };
  const outputs: PortOutput[] = [];
  const service = createConversationService({ configDirectory: directory, owner, runtime, onDomainChange: vi.fn() });
  cleanups.push(service.close);
  const opened = await service.open({ conversationId: original.id, assignment: original.assignment,
    binding: original.bindings[0]!, speaker: original.counterpart }, {
    deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; },
  });
  opened.read.cancel();
  const write = ConversationStore.prototype.write;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, record) {
    if (record.model === 'new-model') throw new Error('settings save failed');
    return write.call(this, record);
  });
  expect(await service.submit({ attachmentId: opened.attachmentId, requestId: randomUUID(), speaker: original.counterpart,
    command: { kind: 'message', text: 'status' } })).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce(), { timeout: 5000 });
  expect(execute).not.toHaveBeenCalled();
  expect(service.activeOperationCount).toBe(1);
  expect(outputs.some((output) => output.kind === 'result')).toBe(false);
  finish();
  await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result',
    result: expect.objectContaining({ kind: 'error', code: 'storage_error' }) })), { timeout: 5000 });
  expect(service.activeOperationCount).toBe(0);
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

it('sends director messages over real IPC, correlates replies and queues them while preserving human busy rejection', async () => {
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
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
  const { client: mcp } = await connectMcp();
  expect(decoded(await mcp.callTool({ name: 'takt_tell_manager', arguments: { managerId: selected.conversationId, text: 'director' } })))
    .toEqual({ kind: 'reply', message: 'reply:director' });
  const slackActor = { namespace: 'slack-user', id: 'T1:U1' };
  const slack = await service.open({ ...selected, speaker: slackActor, binding: { port: 'slack', key: 'thread', counterpart: selected.speaker } }, delivery);
  await service.submit({ attachmentId: slack.attachmentId, requestId: 'slack', speaker: slackActor, command: { kind: 'message', text: 'slack' } });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
  const speakers = await collect(new ConversationSpeakerStore(directory).iterate(selected.conversationId));
  expect(speakers.map((record) => record.actor)).toEqual(expect.arrayContaining([selected.speaker, { namespace: 'agent', id: 'director' }, slackActor]));
  expect(speakers).toHaveLength(3);
  for (const record of speakers) expect(Object.keys(record).sort()).toEqual(['actor', 'conversationId', 'operationId']);
  let release!: () => void;
  execute.mockImplementationOnce(async (input) => { await new Promise<void>((resolve) => { release = resolve; });
    return { message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment }; });
  try {
    await submit('running human');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 5000 });
    const queued = mcp.callTool({ name: 'takt_tell_manager', arguments: { managerId: selected.conversationId, text: 'queued director' } });
    await vi.waitFor(() => expect(JSON.stringify(new ConversationStore(directory).read(selected.conversationId, selected.assignment)))
      .toContain('queued director'), { timeout: 5000 });
    expect(await submit('rejected human')).toMatchObject({ kind: 'busy' });
    expect(execute).toHaveBeenCalledTimes(4);
    release();
    expect(decoded(await queued)).toEqual({ kind: 'reply', message: 'reply:queued director' });
  } finally { release?.(); }
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
  expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['human', 'director', 'slack', 'running human', 'queued director']);
  expect(await collect(new ConversationSpeakerStore(directory).iterate(selected.conversationId))).toHaveLength(5);
  const spy = vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('metadata unavailable'); });
  expect(await submit('not accepted')).toMatchObject({ kind: 'error', code: 'storage_error' });
  expect(execute).toHaveBeenCalledTimes(5);
  spy.mockRestore();
  expect(await submit('explicit retry')).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
  const restricted = new ConversationIpcClient(selected.assignment, undefined, {
    port: createDirectorManagerPort(directory, delivery), reconnect: false,
  });
  try {
    await restricted.connect();
    await expect(restricted.submit({ kind: 'pause_goal', goalId: randomUUID() })).rejects.toMatchObject({ cause: 'invalid_input' });
    expect(execute).toHaveBeenCalledTimes(6);
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
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 5000 });
    await server.close();
    await rejected;
    expect(service.activeOperationCount).toBe(1);
  } finally { release?.(); }
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('one message');
});

it('opens the first director binding over IPC while the manager is running and waits for the queued reply', async () => {
  const repository = await seedManager('first-director-repository');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = vi.fn(async (input: ManagerTurnInput) => {
    if (input.instruction === 'held human') await gate;
    return { message: `reply:${input.instruction}`, summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  cleanups.push(service.close);
  const server = await createConversationIpcServer(directory, owner, service); cleanups.push(server.close);
  const selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const human = await service.open(selected, delivery); human.read.cancel();
  try {
    await service.submit({ attachmentId: human.attachmentId, requestId: randomUUID(), speaker: selected.speaker,
      command: { kind: 'message', text: 'held human' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)!.bindings.some((binding) => binding.port === 'director')).toBe(false);
    const pending = tellDirectorManager(directory, selected.conversationId, 'first director input', signal());
    void pending.catch(() => {});
    await vi.waitFor(() => expect(JSON.stringify(new ConversationStore(directory).read(selected.conversationId, selected.assignment)))
      .toContain('first director input'), { timeout: 5000 });
    expect(execute).toHaveBeenCalledOnce();
    release();
    expect(await pending).toEqual({ kind: 'reply', message: 'reply:first director input' });
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['held human', 'first director input']);
  } finally { release(); }
});

it('retains a saved director input when IPC disconnects before its acceptance response is delivered', async () => {
  const repository = await seedManager('disconnect-before-acceptance');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = vi.fn(async (input: ManagerTurnInput) => {
    if (input.instruction === 'held human') await gate;
    return { message: 'reply', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  cleanups.push(service.close);
  const server = await createConversationIpcServer(directory, owner, service); cleanups.push(server.close);
  const assignment = { kind: 'repository' as const, repositoryDirectory: repository };
  const client = new ConversationIpcClient(assignment, undefined, { port: createDirectorManagerPort(directory, delivery), reconnect: false });
  cleanups.push(async () => client.close()); await client.connect();
  const selected = await createTuiConversationPort(directory, delivery).resolve(assignment);
  const human = await service.open(selected, delivery); human.read.cancel();
  const submit = service.submit;
  const admissions = vi.spyOn(service, 'submit').mockImplementation(async (request) => {
    const result = await submit(request);
    if (request.speaker.id === 'director' && result.kind === 'accepted') client.close();
    return result;
  });
  try {
    await service.submit({ attachmentId: human.attachmentId, requestId: randomUUID(), speaker: selected.speaker,
      command: { kind: 'message', text: 'held human' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 5000 });
    await expect(client.submit({ kind: 'message', text: 'saved before disconnect' })).rejects.toThrow();
    expect(JSON.stringify(new ConversationStore(directory).read(selected.conversationId, assignment))).toContain('saved before disconnect');
    expect(execute).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(service.activeOperationCount).toBe(0), { timeout: 5000 });
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['held human', 'saved before disconnect']);
    expect(admissions.mock.calls.filter(([request]) => request.speaker.id === 'director')).toHaveLength(1);
  } finally { release(); }
});

it.each([false, true])('persists the director result with its operation and source conversation after reply failure=%s', async (fails) => {
  const repository = await seedManager('durable-result');
  const execute = vi.fn(async (input: ManagerTurnInput) => {
    if (fails) throw new Error('fixture provider failed');
    return { message: 'durable manager reply', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const outputs: PortOutput[] = [];
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  cleanups.push(service.close);
  const selected = await createDirectorManagerPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const opened = await service.open(selected, { deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; } });
  opened.read.cancel();
  const accepted = await service.submit({ attachmentId: opened.attachmentId, requestId: 'durable-result', speaker: selected.speaker,
    command: { kind: 'message', text: 'director result request' } });
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
  await vi.waitFor(() => expect(outputs.some((output) => output.kind === 'result' && output.operationId === accepted.operationId)).toBe(true), { timeout: 5000 });
  const terminal = outputs.find((output) => output.kind === 'result' && output.operationId === accepted.operationId);
  if (terminal?.kind !== 'result') throw new Error('Terminal result must exist');
  if (terminal.result.kind !== 'reply' && terminal.result.kind !== 'error') throw new Error('Director reply or failure required');
  expect(terminal.result.kind).toBe(fails ? 'error' : 'reply');
  service.detach(opened.attachmentId);
  await service.close();
  expect(new DirectorMessageResultStore(directory).read(accepted.operationId)).toEqual({
    operationId: accepted.operationId, conversationId: selected.conversationId,
    directorConversationId: conversationId({ kind: 'daemon' }), result: terminal.result,
  });
});

it('never overwrites a saved director result when the next operation ID candidate collides', async () => {
  const repository = await seedManager('operation-collision');
  const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: `reply:${input.instruction}`, summary: null,
    sessionId: 'session', assignment: input.assignment }));
  const outputs: PortOutput[] = [];
  const service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(),
    runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  cleanups.push(service.close);
  const selected = await createDirectorManagerPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const opened = await service.open(selected, { deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; } });
  opened.read.cancel();
  const submit = (text: string) => service.submit({ attachmentId: opened.attachmentId, requestId: 'collision-request',
    speaker: selected.speaker, command: { kind: 'message', text } });
  const first = await submit('original director result');
  expect(first.kind).toBe('accepted');
  if (first.kind !== 'accepted') throw new Error('First director message must be accepted');
  await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: first.operationId,
    result: { kind: 'reply', message: 'reply:original director result' } }), { timeout: 5000 });
  const resultFiles = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, content: readFileSync(join(directory, name), 'utf8') }))
    .filter(({ content }) => content.includes(first.operationId) && content.includes('reply:original director result'));
  expect(resultFiles).toHaveLength(1);
  ids.next.mockReturnValueOnce(first.operationId);
  const second = await submit('new director result');
  expect(['accepted', 'error']).toContain(second.kind);
  if (second.kind === 'accepted') {
    expect(second.operationId).not.toBe(first.operationId);
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: second.operationId,
      result: { kind: 'reply', message: 'reply:new director result' } }), { timeout: 5000 });
  }
  for (const file of resultFiles) expect(readFileSync(join(directory, file.name), 'utf8')).toBe(file.content);
});

it('loads and saves the director patrol interval without changing manager settings', () => {
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\ndirector:\n  patrol_interval: 600\nmanager:\n  patrol_interval: 1800\n  auto_run: false\n');
  invalidateGlobalConfigCache();
  const loaded = loadGlobalConfig();
  expect(loaded).toMatchObject({ director: { patrolInterval: 600 }, manager: { patrolInterval: 1800, autoRun: false } });
  saveGlobalConfig(loaded);
  expect(parseYaml(readFileSync(join(directory, 'config.yaml'), 'utf8'))).toMatchObject({
    director: { patrol_interval: 600 }, manager: { patrol_interval: 1800, auto_run: false },
  });
  invalidateGlobalConfigCache();
  expect(loadGlobalConfig()).toMatchObject({ director: { patrolInterval: 600 }, manager: { patrolInterval: 1800, autoRun: false } });
});

interface PatrolTarget {
  managerId: string;
  cwd: string;
  goalId: string;
  inquiryId?: string;
}

async function savedDirectorNotices() {
  return collect(new DirectorNotificationStore(directory).iterate());
}

async function seedPatrolGoal(repository: string, changes: Partial<Goal>) {
  const goal: Goal = { ...goalRecord(), id: randomUUID(), notifications: [], createdAt: '2026-10-29T01:00:00.000Z', ...changes };
  await new GoalStore(repository).create(goal);
  return goal;
}

function mergeEvidence() {
  return { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready',
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [] };
}

async function readMcpPage<T>(client: Client, name: string, collection: string, arguments_: Record<string, unknown> = {}): Promise<T[]> {
  const entries: T[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await client.callTool({ name, arguments: { ...arguments_, offset, limit: 1 } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const page = decoded(result);
    entries.push(...page[collection] as T[]);
    offset = page.nextOffset as number | null;
  }
  return entries;
}

// 偽 provider は判断精度を検証せず、保存値の読み取りから通知までの接続を実行する。
function patrolProvider(language: 'ja' | 'en' = 'en') {
  let wording = 0;
  let disposedConnections = 0;
  const failures: unknown[] = [];
  const start = localMcp.startLocalMcpConnection;
  vi.spyOn(localMcp, 'startLocalMcpConnection').mockImplementation(async (...args) => {
    const connection = await start(...args);
    return { ...connection, async dispose() { await connection.dispose(); disposedConnections++; } };
  });
  const setup = vi.fn<Provider['setup']>();
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP director MCP required');
    const client = new Client({ name: 'patrol-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(toolNames.sort()).toEqual([...DIRECTOR_TOOL_NAMES].sort());
      expect(options).toMatchObject({ permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST });
      expect(options.sessionId).toBeUndefined();
      const notify = async (target: PatrolTarget, reason: string) => {
        const message = `${target.cwd} goal ${target.goalId}: ${reason} (${++wording})`;
        const result = await client.callTool({ name: 'takt_notify_human', arguments: { message, target } });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      };
      const managers = await readMcpPage<{ id: string; assignment: { repositoryDirectories: string[] } }>(client, 'takt_list_managers', 'managers');
      for (const manager of managers) {
        for (const cwd of manager.assignment.repositoryDirectories) {
          const goals = await readMcpPage<Pick<Goal, 'id' | 'status' | 'executionStatus'>>(client, 'takt_list_goals', 'goals', { managerId: manager.id, cwd });
          for (const goal of goals) {
            const target = { managerId: manager.id, cwd, goalId: goal.id };
            if (goal.status === 'awaiting_merge') await notify(target, 'awaiting_merge');
            else if (goal.executionStatus === 'paused') await notify(target, 'paused');
            else {
              const notifications = await readMcpPage<{ kind: string }>(client, 'takt_get_goal', 'items', { ...target, path: 'notifications' });
              if (notifications.some((notification) => notification.kind === 'blocked')) await notify(target, 'blocked');
            }
          }
        }
        const inquiries = await readMcpPage<{ goalId: string; repositoryDirectory: string; question: { id: string; body: string } }>(
          client, 'takt_list_manager_inquiries', 'inquiries', { managerId: manager.id });
        for (const inquiry of inquiries) {
          await notify({ managerId: manager.id, cwd: inquiry.repositoryDirectory, goalId: inquiry.goalId, inquiryId: inquiry.question.id }, inquiry.question.body);
        }
      }
      return { persona: 'director', status: 'done', content: 'Patrol finished', timestamp: new Date(), sessionId: 'patrol-session' };
    } catch (error) { failures.push(error); throw error; }
    finally { await client.close(); await transport.close(); }
  });
  setup.mockImplementation((input) => {
    for (const category of ['policies', 'instructions']) {
      expect(input.systemPrompt).toContain(readFileSync(join(process.cwd(), `builtins/${language}/facets`, category, 'director.md'), 'utf8').trim());
    }
    return { call };
  });
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http', 'stdio']), supportsStructuredOutput: true, setup }));
  return { call, setup, failures, get disposedConnections() { return disposedConnections; } };
}

async function startPatrolDaemon(useSlack = false) {
  const priorListeners = process.rawListeners('SIGTERM');
  const polls: Array<() => void> = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-29T01:05:00.000Z');
  vi.spyOn(timerPromises, 'setTimeout').mockImplementation(async <T = void>(_ms?: number, value?: T, options?: TimerOptions) => {
    await new Promise<void>((resolve) => { polls.push(resolve); });
    options?.signal?.throwIfAborted();
    return value as T;
  });
  vi.spyOn(daemonOwners, 'registerDaemonOwner').mockReturnValue(true);
  vi.spyOn(daemonOwners, 'readDaemonOwner').mockReturnValue({ ...owner, version: packageVersion });
  const removeOwner = vi.spyOn(daemonOwners, 'removeDaemonOwner').mockImplementation(() => {});
  vi.spyOn(processIdentity, 'getSelfProcessIdentity').mockReturnValue(owner.identity);
  vi.spyOn(cliInvocation, 'resolveCliInvocation').mockReturnValue({ args: [], cliPath: owner.cliPath });
  if (!useSlack) {
    vi.spyOn(slackPorts, 'createDaemonSlackPorts').mockResolvedValue({ listening: false, notifications: { deliver: async () => {} },
      pollInquiries: async () => {}, stopAccepting: () => {}, close: async () => {} });
  }
  vi.spyOn(taskRecovery, 'failInterruptedTasksWithGoalEvents').mockReturnValue(0);
  vi.spyOn(autoRun, 'ensureManagerRun').mockResolvedValue(undefined);
  const processPending = vi.fn(async () => false);
  const createManager = eventManagers.createRunEventManager;
  vi.spyOn(eventManagers, 'createRunEventManager').mockReturnValue({ processPending, close: async () => {} });
  const run = runDaemon();
  let failure: unknown;
  void run.catch((error: unknown) => { failure = error; });
  const waitForPoll = async () => {
    await vi.waitFor(() => {
      if (failure !== undefined) throw failure;
      expect(polls.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
  };
  const stop = async () => {
    const listener = process.rawListeners('SIGTERM').find((candidate) => !priorListeners.includes(candidate));
    listener?.call(process, 'SIGTERM');
    polls.splice(0).forEach((resolve) => resolve());
    await run;
  };
  cleanups.push(stop);
  await waitForPoll();
  return { processPending, createManager, removeOwner, stop,
    async poll(elapsedSeconds = 0) {
      await waitForPoll();
      vi.setSystemTime(Date.now() + elapsedSeconds * 1000);
      polls.shift()!();
      await waitForPoll();
    },
  };
}

async function expectCompletedPatrol(provider: ReturnType<typeof patrolProvider>, count: number) {
  await vi.waitFor(() => {
    if (provider.failures.length > 0) throw provider.failures[0];
    expect(provider.call).toHaveBeenCalledTimes(count);
    const settled = provider.call.mock.settledResults[count - 1];
    if (settled?.type === 'rejected') throw settled.value;
    expect(provider.call.mock.settledResults[count - 1]?.type).toBe('fulfilled');
    expect(provider.disposedConnections).toBeGreaterThanOrEqual(count);
  }, { timeout: 30_000 });
  await new Promise(setImmediate);
}

it('patrols repository and workspace managers and notifies each stopped goal and pending approval', async () => {
  const a = await seedManager('patrol-a');
  const b = await seedManager('patrol-b');
  await createWorkspace({ globalConfigDirectory: directory, name: 'workspace manager', repositoryDirectories: [b] });
  const merge = await seedPatrolGoal(a, { status: 'awaiting_merge', completion: mergeEvidence() });
  const paused = await seedPatrolGoal(a, { executionStatus: 'paused' });
  const blocked = await seedPatrolGoal(b, { notifications: [{ id: randomUUID(), kind: 'blocked', body: 'Cannot proceed', recordedAt: '2026-10-29T01:01:00.000Z' }] });
  const approval = createInquiry({ kind: 'approval', body: 'Approve the proposed change', operation: { toolName: 'Write', args: '{}', cwd: b } });
  const waiting = await seedPatrolGoal(b, { questions: [approval] });
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  const notices = await savedDirectorNotices();
  expect(notices).toHaveLength(4);
  for (const [cwd, goal, reason] of [[a, merge, 'awaiting_merge'], [a, paused, 'paused'], [b, blocked, 'blocked'], [b, waiting, approval.body]] as const) {
    expect(notices).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`${cwd} goal ${goal.id}: ${reason}`) }));
  }
  expect((await new GoalStore(b).get(waiting.id)).questions).toEqual([approval]);
});

it('suppresses unchanged patrol notifications on the same daemon and notifies a changed goal state', async () => {
  const repository = await seedManager('deduplicated-patrol');
  const goal = await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence() });
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  const human = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => human.close());
  const outputs: PortOutput[] = [];
  human.onOutput((output) => outputs.push(output));
  await human.connect();
  await vi.waitFor(() => expect(human.getSnapshot().readStatus).toBe('complete'), { timeout: 5000 });
  const first = await savedDirectorNotices();
  expect(first).toHaveLength(1);
  expect(human.getSnapshot().items).toContainEqual({ kind: 'display_event', event: { id: first[0]!.id, message: first[0]!.message } });
  outputs.length = 0;
  await new GoalStore(repository).update(goal.id, (saved) => ({ ...saved, lastPatrolCompletedAt: new Date().toISOString(),
    workLog: [{ id: randomUUID(), kind: 'patrol', recordedAt: new Date().toISOString(), summary: 'Manager patrol only' }] }));
  await daemon.poll(900);
  await expectCompletedPatrol(provider, 2);
  expect(await savedDirectorNotices()).toEqual(first);
  expect(outputs.filter((output) => output.kind === 'notice')).toEqual([]);
  await new GoalStore(repository).update(goal.id, (saved) => ({ ...saved, status: 'created', executionStatus: 'paused' }));
  await daemon.poll(900);
  await expectCompletedPatrol(provider, 3);
  const notices = await savedDirectorNotices();
  expect(notices).toHaveLength(2);
  expect(notices).toContainEqual(first[0]);
  expect(notices).toContainEqual(expect.objectContaining({ message: expect.stringContaining('paused') }));
  await vi.waitFor(() => expect(outputs.filter((output) => output.kind === 'notice')).toHaveLength(1), { timeout: 5000 });
});

it('keeps identical goal identities in different repositories separate during patrol notification', async () => {
  const a = await seedManager('identity-a');
  const b = await seedManager('identity-b');
  await createWorkspace({ globalConfigDirectory: directory, name: 'shared manager', repositoryDirectories: [a, b] });
  const goal = await seedPatrolGoal(a, { status: 'awaiting_merge', completion: mergeEvidence() });
  await seedPatrolGoal(b, { id: goal.id, status: 'awaiting_merge', completion: mergeEvidence() });
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  const notices = await savedDirectorNotices();
  expect(notices).toHaveLength(2);
  for (const cwd of [a, b]) expect(notices).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`${cwd} goal ${goal.id}`) }));
});

it('does not read run internals or notify about a running task during director patrol', async () => {
  const repository = await seedManager('running-task-patrol');
  const goal = await seedPatrolGoal(repository, {});
  new TaskStore(repository).update(() => ({ tasks: [{ name: 'repeated-review', status: 'running', goal_id: goal.id,
    run_slug: 'repeated-review-run', content: 'Implement the goal', created_at: '2026-10-29T01:00:00.000Z',
    started_at: '2026-10-29T01:01:00.000Z', completed_at: null }] }));
  const runRoot = join(repository, '.takt', 'runs', 'repeated-review-run');
  mkdirSync(runRoot, { recursive: true });
  const meta: RunMeta = { task: 'Implement the goal', workflow: 'default', runSlug: 'repeated-review-run', runRoot,
    reportDirectory: join(runRoot, 'reports'), contextDirectory: join(runRoot, 'context'), logsDirectory: join(runRoot, 'logs'),
    status: 'running', startTime: '2026-10-29T01:01:00.000Z', currentStep: 'review', currentIteration: 100, iterations: 100, phase: 1 };
  writeFileSync(join(runRoot, 'meta.json'), JSON.stringify(meta));
  const run = vi.spyOn(readers, 'getTaktRun');
  const tasks = vi.spyOn(readers, 'listTaktTasks');
  const toolCalls = vi.spyOn(Client.prototype, 'callTool');
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect(run).not.toHaveBeenCalled();
  expect(tasks).not.toHaveBeenCalled();
  expect(await savedDirectorNotices()).toEqual([]);
  for (const [request] of toolCalls.mock.calls) {
    expect(['takt_get_run', 'takt_list_tasks', 'takt_tell_manager', 'takt_notify_human']).not.toContain(request.name);
  }
});

it.each([undefined, 600])('schedules director patrols at the resolved global interval %s', async (configured) => {
  const repository = await seedManager('interval-patrol');
  await seedPatrolGoal(repository, {});
  if (configured !== undefined) {
    writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: en\ndirector:\n  patrol_interval: ${configured}\n`);
    invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  }
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  await daemon.poll((configured ?? 900) - 1);
  expect(provider.call).toHaveBeenCalledTimes(1);
  await daemon.poll(1);
  await expectCompletedPatrol(provider, 2);
});

it('leaves a specification inquiry unanswered and notifies the human during director patrol', async () => {
  const repository = await seedManager('specification-patrol');
  const inquiry = createInquiry({ body: 'Should the export include deleted records?' });
  const goal = await seedPatrolGoal(repository, { questions: [inquiry] });
  const toolCalls = vi.spyOn(Client.prototype, 'callTool');
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect((await new GoalStore(repository).get(goal.id)).questions).toEqual([inquiry]);
  expect(await savedDirectorNotices()).toEqual([expect.objectContaining({ message: expect.stringContaining(inquiry.body) })]);
  expect(toolCalls.mock.calls.some(([request]) => request.name === 'takt_tell_manager')).toBe(false);
});

it('does not merge a saved PR without human instructions in director and manager patrol turns', async () => {
  const repository = await seedManager('merge-patrol');
  const goal = await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence(),
    pullRequest: { number: 1950, url: 'https://github.invalid/project/pull/1950' }, createdAt: '2026-10-29T00:00:00.000Z' });
  const merge = vi.spyOn(goalPrMerge, 'mergeGoalPr').mockResolvedValue({ success: true, prNumber: 1950, exitCode: 0, output: 'merged', truncated: false });
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon();
  const actualPlans = await vi.importActual<typeof import('../features/manager/conversationPlan.js')>('../features/manager/conversationPlan.js');
  vi.spyOn(managerPlans, 'createManagerConversationPlan').mockImplementation(actualPlans.createManagerConversationPlan);
  const connection = await startManagerMcpConnection(repository);
  cleanups.push(connection.dispose);
  vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({
    client: new Client({ name: 'manager-patrol-double', version: '1' }),
    servers: { [TAKT_MANAGER_MCP_SERVER_NAME]: connection.config }, dispose: connection.dispose,
  });
  const managerCall = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const config = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME];
    if (config?.type !== 'http') throw new Error('HTTP MCP required');
    const client = new Client({ name: 'autonomous-manager-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'takt_merge_goal_pr', arguments: { cwd: repository, goalId: goal.id, prNumber: 1950 } });
      expect(result.isError).toBe(true);
    } finally { await client.close(); await transport.close(); }
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { message: 'Waiting for a human merge instruction', summary: null } };
  });
  provider.setup.mockReturnValueOnce({ call: managerCall });
  const manager = daemon.createManager(repository);
  cleanups.push(manager.close);
  await enqueueDueGoalPatrols(repository, 900);
  expect(readManagerEvents(repository)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'patrol', goalId: goal.id }) }));
  await manager.processPending(signal(), 10);
  expect(managerCall).toHaveBeenCalledOnce();
  const managerSetup = provider.setup.mock.calls.find(([input]) => input.name === 'manager')?.[0];
  expect(managerSetup?.systemPrompt).toContain(readFileSync(join(process.cwd(), 'builtins/en/facets/policies/manager.md'), 'utf8').trim());
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect(merge).not.toHaveBeenCalled();
  expect((await new GoalStore(repository).get(goal.id)).status).toBe('awaiting_merge');
  expect(await savedDirectorNotices()).toEqual([expect.objectContaining({ message: expect.stringContaining('awaiting_merge') })]);
});

it('retains notification suppression after reopening the director MCP server', async () => {
  const repository = await seedManager('persisted-patrol-notice');
  const goal = await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence() });
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: goal.id };
  const first = await connectMcp();
  const result = await first.client.callTool({ name: 'takt_notify_human', arguments: { message: 'Ready for merge', target } });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const saved = await savedDirectorNotices();
  expect(saved).toHaveLength(1);
  expect(first.notify).toHaveBeenCalledOnce();
  const reopened = await connectMcp();
  expect((await reopened.client.callTool({ name: 'takt_notify_human', arguments: { message: 'The same PR is waiting', target } })).isError).not.toBe(true);
  expect(await savedDirectorNotices()).toEqual(saved);
  expect(reopened.notify).not.toHaveBeenCalled();
});

it('requires a patrol target and rejects a repository outside its manager assignment', async () => {
  const repository = await seedManager('patrol-target-validation');
  const goal = await seedPatrolGoal(repository, {});
  const { client, notify } = await connectMcp(vi.fn(async () => {}), true);
  expect((await client.callTool({ name: 'takt_notify_human', arguments: { message: 'No identity' } })).isError).toBe(true);
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: directory, goalId: goal.id };
  expect((await client.callTool({ name: 'takt_notify_human', arguments: { message: 'Wrong repository', target } })).isError).toBe(true);
  expect(await savedDirectorNotices()).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

it('retries notification after storage failure without recording a delivered state', async () => {
  const repository = await seedManager('patrol-storage-failure');
  const goal = await seedPatrolGoal(repository, {});
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: goal.id };
  const { client, notify } = await connectMcp();
  vi.spyOn(privateFiles, 'writeNewPrivateFileWithMode').mockImplementationOnce(() => { throw new Error('notification save failed'); });
  const args = { name: 'takt_notify_human', arguments: { message: 'Waiting for a decision', target } };
  expect((await client.callTool(args)).isError).toBe(true);
  expect(await savedDirectorNotices()).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  expect((await client.callTool(args)).isError).not.toBe(true);
  expect(await savedDirectorNotices()).toHaveLength(1);
  expect(notify).toHaveBeenCalledOnce();
});

it('suppresses concurrent notifications from separate MCP connections for the same saved state', async () => {
  const repository = await seedManager('concurrent-patrol-notice');
  const goal = await seedPatrolGoal(repository, {});
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: goal.id };
  const notify = vi.fn(async () => {});
  const first = await connectMcp(notify);
  const second = await connectMcp(notify);
  const results = await Promise.all([first, second].map(({ client }) => client.callTool({ name: 'takt_notify_human', arguments: { message: 'Waiting', target } })));
  expect(results.every((result) => result.isError !== true)).toBe(true);
  expect(await savedDirectorNotices()).toHaveLength(1);
  expect(notify).toHaveBeenCalledOnce();
});

it('reports corrupt saved notification state rather than treating it as not yet notified', async () => {
  const repository = await seedManager('corrupt-patrol-notice');
  const goal = await seedPatrolGoal(repository, {});
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: goal.id };
  const { client, notify } = await connectMcp();
  const args = { name: 'takt_notify_human', arguments: { message: 'Waiting', target } };
  expect((await client.callTool(args)).isError).not.toBe(true);
  const saved = (await savedDirectorNotices())[0]!;
  writeFileSync(join(directory, 'director-notifications', `${saved.id}.json`), '{invalid');
  expect((await client.callTool(args)).isError).toBe(true);
  expect(notify).toHaveBeenCalledOnce();
});

it.each(['ja', 'en'] as const)('provides saved progress and inquiry timestamps for patrol decisions in %s', async (language) => {
  writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ${language}\n`);
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  const repository = await seedManager('old-patrol-progress');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  const question = createInquiry({ body: 'Long unanswered specification', recipient: 'human' });
  question.createdAt = '2026-10-27T00:00:00.000Z';
  const goal = await seedPatrolGoal(repository, { createdAt: '2026-10-26T00:00:00.000Z', questions: [question], workLog: [
    { id: randomUUID(), summary: 'Actual progress', recordedAt: '2026-10-27T01:00:00.000Z' },
    { id: randomUUID(), summary: 'Patrol only', kind: 'patrol', recordedAt: '2026-10-29T01:00:00.000Z' },
  ] });
  const assignment = { kind: 'repository' as const, repositoryDirectory: repository, repositoryDirectories: [repository] };
  const inquiryStore = new StandaloneInquiryStore(directory, assignment);
  const standalone = await inquiryStore.create({ body: question.body, recipient: 'human' });
  const provider = patrolProvider(language);
  provider.call.mockImplementationOnce(async (prompt, options) => {
    const event = JSON.parse(prompt);
    expect(event).toMatchObject({ event: 'director_patrol', patrolIntervalSeconds: 900 });
    expect(Date.parse(event.observedAt)).toBeGreaterThanOrEqual(Date.parse('2026-10-29T01:05:00.000Z'));
    expect(Date.parse(event.observedAt)).toBeLessThanOrEqual(Date.now());
    const server = options.mcpServers![DIRECTOR_MCP_SERVER_NAME]!;
    if (server.type !== 'http') throw new Error('HTTP MCP required');
    const client = new Client({ name: 'patrol-time-inputs', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    await client.connect(transport);
    try {
      const target = { managerId: conversationId(assignment), cwd: repository, goalId: goal.id };
      const createdResult = await client.callTool({ name: 'takt_get_goal', arguments: { ...target, path: 'createdAt' } });
      expect(createdResult.isError, JSON.stringify(createdResult.content)).not.toBe(true);
      expect(decoded(createdResult).content).toBe(goal.createdAt);
      const work = await readMcpPage<{ kind?: string; recordedAt: string }>(client, 'takt_get_goal', 'items', { ...target, path: 'workLog' });
      expect(work.filter((entry) => entry.kind !== 'patrol').at(-1)?.recordedAt).toBe('2026-10-27T01:00:00.000Z');
      const inquiries = await readMcpPage<{ question: { id: string; createdAt: string } }>(client, 'takt_list_manager_inquiries', 'inquiries', { managerId: target.managerId });
      expect(inquiries.find((entry) => entry.question.id === standalone.id)?.question.createdAt).toBe('2026-10-27T00:00:00.000Z');
      const result = await client.callTool({ name: 'takt_notify_human', arguments: { message: question.body, target: { managerId: target.managerId, inquiryId: standalone.id } } });
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); await transport.close(); }
    return { persona: 'director', status: 'done', content: 'Inspected progress', timestamp: new Date() };
  });
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect(await savedDirectorNotices()).toHaveLength(1);
  expect((await inquiryStore.get(standalone.id)).status).toBe('pending');
});

it('keeps manager polling active without overlapping a director patrol and waits for it on stop', async () => {
  const repository = await seedManager('pending-patrol');
  await seedPatrolGoal(repository, {});
  const provider = patrolProvider();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  provider.call.mockImplementationOnce(async (_prompt, options) => {
    await pending;
    options.abortSignal?.throwIfAborted();
    return { persona: 'director', status: 'done', content: '', timestamp: new Date() };
  });
  const daemon = await startPatrolDaemon();
  try {
    await daemon.poll();
    await vi.waitFor(() => expect(provider.call).toHaveBeenCalledOnce(), { timeout: 5000 });
    await daemon.poll(1800);
    await daemon.poll(1800);
    expect(provider.call).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(daemon.processPending.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
    const stopped = daemon.stop();
    await vi.waitFor(() => expect(provider.call.mock.calls[0]![1].abortSignal?.aborted).toBe(true), { timeout: 5000 });
    expect(daemon.removeOwner).not.toHaveBeenCalled();
    release();
    await stopped;
    expect(daemon.removeOwner).toHaveBeenCalledOnce();
  } finally { release(); }
});

it('waits the patrol interval after a director provider failure before retrying', async () => {
  const repository = await seedManager('failed-patrol');
  await seedPatrolGoal(repository, {});
  const provider = patrolProvider();
  provider.call.mockRejectedValueOnce(new Error('Director provider unavailable'));
  const daemon = await startPatrolDaemon();
  await daemon.poll();
  await vi.waitFor(() => expect(provider.call.mock.settledResults[0]?.type).toBe('rejected'), { timeout: 5000 });
  await vi.waitFor(() => expect(provider.disposedConnections).toBe(1), { timeout: 5000 });
  await daemon.poll(899);
  expect(provider.call).toHaveBeenCalledOnce();
  await daemon.poll(1);
  await expectCompletedPatrol(provider, 2);
});

it('preserves the human director session across an autonomous patrol', async () => {
  await seedManager('conversation-patrol');
  const provider = patrolProvider();
  provider.call.mockImplementationOnce(async () => ({ persona: 'director', status: 'done', content: 'Human reply',
    timestamp: new Date(), sessionId: 'human-session' }));
  const daemon = await startPatrolDaemon();
  const human = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => human.close());
  await human.connect();
  const conversation = new ConversationStore(directory);
  const id = conversationId({ kind: 'daemon' });
  await human.submit({ kind: 'message', text: 'Status please' });
  await vi.waitFor(() => expect(conversation.read(id, { kind: 'daemon' })?.sessionId).toBe('human-session'), { timeout: 5000 });
  await daemon.poll();
  await expectCompletedPatrol(provider, 2);
  expect(conversation.read(id, { kind: 'daemon' })?.sessionId).toBe('human-session');
  provider.call.mockImplementationOnce(async (_prompt, options) => {
    expect(options.sessionId).toBe('human-session');
    return { persona: 'director', status: 'done', content: 'Continued reply', timestamp: new Date(), sessionId: 'human-session' };
  });
  expect((await human.submit({ kind: 'message', text: 'Continue' })).kind).toBe('accepted');
  await vi.waitFor(() => expect(provider.call).toHaveBeenCalledTimes(3), { timeout: 5000 });
  await vi.waitFor(() => expect(provider.call.mock.settledResults[2]?.type).toBe('fulfilled'), { timeout: 5000 });
});

it('keeps a human conversation MCP connection usable while an autonomous patrol finishes', async () => {
  await seedManager('concurrent-conversation-patrol');
  const provider = patrolProvider();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let humanMcp: Client | undefined;
  provider.call.mockImplementationOnce(async (_prompt, options) => {
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP director MCP required');
    const client = new Client({ name: 'human-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      humanMcp = client;
      await pending;
      return { persona: 'director', status: 'done', content: 'Human conversation finished', timestamp: new Date(), sessionId: 'human-session' };
    } finally { await client.close(); await transport.close(); }
  });
  const daemon = await startPatrolDaemon();
  const human = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => human.close());
  try {
    await human.connect();
    expect((await human.submit({ kind: 'message', text: 'Check the current goals' })).kind).toBe('accepted');
    await vi.waitFor(() => expect(humanMcp).toBeDefined(), { timeout: 5000 });
    const initialTools = (await humanMcp!.listTools()).tools.map((tool) => tool.name).sort();
    await daemon.poll();
    await vi.waitFor(() => {
      if (provider.failures.length > 0) throw provider.failures[0];
      expect(provider.call).toHaveBeenCalledTimes(2);
      expect(provider.call.mock.settledResults[1]?.type).toBe('fulfilled');
      expect(provider.disposedConnections).toBe(1);
    }, { timeout: 5000 });
    expect((await humanMcp!.listTools()).tools.map((tool) => tool.name).sort()).toEqual(initialTools);
    release();
    await expectCompletedPatrol(provider, 2);
  } finally { release(); }
});

it('roundtrips director Slack configuration and traces both keys to the global file', () => {
  const configPath = join(directory, 'config.yaml');
  const slack = { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'] };
  writeFileSync(configPath, JSON.stringify({ provider: 'mock', language: 'en', director: { patrol_interval: 600, slack },
    manager: { patrol_interval: 1800, auto_run: false } }));
  invalidateGlobalConfigCache();
  const loaded = loadGlobalConfig();
  expect(loaded).toMatchObject({ director: { patrolInterval: 600, slack: { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] } } });
  saveGlobalConfig(loaded);
  expect(parseYaml(readFileSync(configPath, 'utf8'))).toMatchObject({ director: { patrol_interval: 600, slack },
    manager: { patrol_interval: 1800, auto_run: false } });
  invalidateGlobalConfigCache();
  expect(loadGlobalConfig()).toEqual(loaded);
  const traced = loadGlobalConfigTrace(configPath, (value) => value, []);
  expect(traced.rawConfig).toMatchObject({ director: { patrol_interval: 600, slack } });
  for (const key of ['director.slack.channel_id', 'director.slack.allowed_user_ids']) {
    expect(traced.trace.getOrigin(key), key).toBe('global');
  }
});

function directorSlackMessage(overrides: Record<string, unknown> = {}): SlackEvent {
  return { type: 'events_api', body: { team_id: 'T0TEAM', event: {
    type: 'message', channel: 'C0DIR', user: 'U0AAA', ts: '1700000000.000001', text: 'マージ待ちは？', ...overrides,
  } } };
}

function fakeDirectorSlack() {
  const client = {
    start: vi.fn<SlackClient['start']>(async () => {}),
    postMessage: vi.fn<SlackClient['postMessage']>(async () => ({ kind: 'delivered', parentTs: '1700000000.000100' })),
    postThreadMessage: vi.fn<SlackClient['postThreadMessage']>(async () => ({ kind: 'delivered' })),
    openModal: vi.fn<SlackClient['openModal']>(async () => ({ kind: 'delivered' })),
    stopAccepting: vi.fn(), close: vi.fn<SlackClient['close']>(async () => {}),
  } satisfies SlackClient;
  const factory = vi.spyOn(slackClient, 'createSlackClient').mockReturnValue(client);
  let input: ConversationInput | undefined;
  const createPorts = slackPorts.createDaemonSlackPorts;
  vi.spyOn(slackPorts, 'createDaemonSlackPorts').mockImplementation(async (options) => {
    input = options.input;
    return createPorts(options);
  });
  process.env.TAKT_SLACK_APP_TOKEN = 'xapp-test-director';
  process.env.TAKT_SLACK_BOT_TOKEN = 'xoxb-test-director';
  return { client, factory,
    input() {
      if (input === undefined) throw new Error('Daemon Slack input has not been initialized');
      return input;
    },
    async receive(event: SlackEvent) {
      expect(client.start).toHaveBeenCalledOnce();
      await client.start.mock.calls[0]![0](event);
    },
  };
}

function configureDirectorSlack(language: 'ja' | 'en') {
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify({ provider: 'mock', language,
    director: { slack: { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'] } } }));
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
}

it.each(['ja', 'en'] as const)('posts merge and inquiry notices together once per patrol and suppresses unchanged notices in %s', async (language) => {
  const repository = await seedManager('slack-patrol');
  const merge = await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence() });
  const question = createInquiry({ body: 'Which specification should be used?', recipient: 'human' });
  const waiting = await seedPatrolGoal(repository, { questions: [question] });
  configureDirectorSlack(language);
  const slack = fakeDirectorSlack();
  const provider = patrolProvider(language);
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect(slack.factory).toHaveBeenCalledExactlyOnceWith({ appToken: 'xapp-test-director', botToken: 'xoxb-test-director' });
  await vi.waitFor(() => expect(slack.client.postMessage).toHaveBeenCalledOnce(), { timeout: 5000 });
  const [channel, text] = slack.client.postMessage.mock.calls[0]!;
  expect(channel).toBe('C0DIR');
  expect(text).toContain(getLabel('director.slackNotifications', language));
  expect(text).toContain(merge.id);
  expect(text).toContain('awaiting_merge');
  expect(text).toContain(waiting.id);
  expect(text).toContain(question.body);
  expect(await savedDirectorNotices()).toHaveLength(2);
  expect(slack.client.postThreadMessage).not.toHaveBeenCalled();

  const human = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => human.close());
  await human.connect();
  await vi.waitFor(() => expect(human.getSnapshot().readStatus).toBe('complete'), { timeout: 5000 });
  for (const notice of await savedDirectorNotices()) {
    expect(human.getSnapshot().items).toContainEqual({ kind: 'display_event', event: notice });
  }
  await daemon.poll(900);
  await expectCompletedPatrol(provider, 2);
  expect(slack.client.postMessage).toHaveBeenCalledOnce();
  expect(await savedDirectorNotices()).toHaveLength(2);
  expect((await new GoalStore(repository).get(waiting.id)).questions).toEqual([question]);
});

it('routes allowed Slack speech to the director and replies to each originating thread', async () => {
  const repository = await seedManager('slack-conversation');
  configureDirectorSlack('en');
  const slack = fakeDirectorSlack();
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  provider.call.mockClear();
  provider.call.mockImplementation(async (_prompt, options) => {
    expect(options).toMatchObject({ permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST });
    expect(Object.keys(options.mcpServers!)).toEqual([DIRECTOR_MCP_SERVER_NAME]);
    return { persona: 'director', status: 'done', content: `Director reply ${provider.call.mock.calls.length}`, timestamp: new Date(), sessionId: 'slack-director-session' };
  });
  const open = vi.spyOn(slack.input(), 'open');
  const submit = vi.spyOn(slack.input(), 'submit');
  const managerPlan = vi.spyOn(managerPlans, 'createManagerConversationPlan');
  for (const [index, [ts, text]] of [['1700000000.000001', 'マージ待ちは？'], ['1700000000.000002', '/make-goal\n```text\nそのまま渡す\n```']].entries()) {
    await slack.receive(directorSlackMessage({ ts, text }));
    await vi.waitFor(() => expect(slack.client.postThreadMessage).toHaveBeenCalledTimes(index + 1), { timeout: 5000 });
  }
  expect(provider.call).toHaveBeenCalledTimes(2);
  expect(provider.call.mock.calls.map(([prompt]) => prompt)).toEqual(['マージ待ちは？', '/make-goal\n```text\nそのまま渡す\n```']);
  expect(submit.mock.calls.map(([value]) => value.command)).toEqual([
    { kind: 'message', text: 'マージ待ちは？' }, { kind: 'message', text: '/make-goal\n```text\nそのまま渡す\n```' },
  ]);
  for (const [opened] of open.mock.calls) {
    expect(opened).toMatchObject({ conversationId: conversationId({ kind: 'daemon' }), assignment: { kind: 'daemon' },
      speaker: { namespace: 'slack-user', id: JSON.stringify(['T0TEAM', 'U0AAA']) } });
  }
  expect(slack.client.postThreadMessage.mock.calls.map(([thread, text]) => [thread, text])).toEqual([
    [{ channelId: 'C0DIR', parentTs: '1700000000.000001' }, 'Director reply 1'],
    [{ channelId: 'C0DIR', parentTs: '1700000000.000002' }, 'Director reply 2'],
  ]);
  const store = new ConversationStore(directory);
  expect(store.read(conversationId({ kind: 'daemon' }), { kind: 'daemon' })).toMatchObject({ agent: 'director', sessionId: 'slack-director-session' });
  expect(store.read(conversationId({ kind: 'repository', repositoryDirectory: repository }), { kind: 'repository', repositoryDirectory: repository })).toBeUndefined();
  expect(managerPlan).not.toHaveBeenCalled();
  expect(slack.client.postMessage).not.toHaveBeenCalled();
});

it('ignores a user allowed only by the manager before opening or submitting a director conversation', async () => {
  const repository = await seedManager('slack-authorization');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  slack:\n    channel_id: C0MGR\n    allowed_user_ids: [U0BBB]\n');
  const goal = await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence() });
  configureDirectorSlack('en');
  const slack = fakeDirectorSlack();
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  provider.call.mockClear();
  const open = vi.spyOn(slack.input(), 'open');
  const submit = vi.spyOn(slack.input(), 'submit');
  const merge = vi.spyOn(goalIntegration, 'mergeTaktGoalPr');
  const tools = vi.spyOn(Client.prototype, 'callTool');
  const saved = await new GoalStore(repository).get(goal.id);
  slack.client.postMessage.mockClear();
  await slack.receive(directorSlackMessage({ user: 'U0BBB', text: 'G をマージして' }));
  expect(open).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(provider.call).not.toHaveBeenCalled();
  expect(tools).not.toHaveBeenCalled();
  expect(merge).not.toHaveBeenCalled();
  expect(slack.client.postMessage).not.toHaveBeenCalled();
  expect(slack.client.postThreadMessage).not.toHaveBeenCalled();
  expect(await new GoalStore(repository).get(goal.id)).toEqual(saved);
  expect(slack.factory).toHaveBeenCalledOnce();
});

it('ignores edited, deleted, bot and interactive director events without treating nested text as speech', async () => {
  await seedManager('slack-filtering');
  configureDirectorSlack('en');
  const slack = fakeDirectorSlack();
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  provider.call.mockClear();
  const open = vi.spyOn(slack.input(), 'open');
  const submit = vi.spyOn(slack.input(), 'submit');
  for (const changes of [
    { subtype: 'message_changed', message: { text: 'マージ待ちは？', user: 'U0AAA' } },
    { subtype: 'message_deleted', previous_message: { text: 'マージ待ちは？' } },
    { bot_id: 'B0BOT' },
  ]) await slack.receive(directorSlackMessage(changes));
  await slack.receive({ type: 'interactive', body: { type: 'block_actions', team: { id: 'T0TEAM' },
    channel: { id: 'C0DIR' }, user: { id: 'U0AAA' }, container: { type: 'message', channel_id: 'C0DIR', message_ts: '1700000000.000001' },
    message: { ts: '1700000000.000001', text: 'マージ待ちは？' },
    actions: [{ type: 'button', action_id: 'takt_goal_approve', value: 'マージ待ちは？' }] } });
  expect(open).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(provider.call).not.toHaveBeenCalled();
  expect(slack.client.postThreadMessage).not.toHaveBeenCalled();
  expect(slack.client.openModal).not.toHaveBeenCalled();
});

it('keeps director notifications local without director Slack even when manager Slack is connected', async () => {
  const repository = await seedManager('manager-slack-only');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  slack:\n    channel_id: C0MGR\n    allowed_user_ids: [U0BBB]\n');
  await seedPatrolGoal(repository, { status: 'awaiting_merge', completion: mergeEvidence() });
  const slack = fakeDirectorSlack();
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  expect(slack.client.start).toHaveBeenCalledOnce();
  const open = vi.spyOn(slack.input(), 'open');
  await slack.receive(directorSlackMessage());
  expect(open).not.toHaveBeenCalled();
  expect(await savedDirectorNotices()).toHaveLength(1);
  expect(slack.client.postMessage).not.toHaveBeenCalled();
  expect(slack.client.postThreadMessage).not.toHaveBeenCalled();
});

it.each([false, true])('delivers saved completion notices from a human turn and preserves TUI delivery when the provider fails=%s', async (fails) => {
  const repository = await seedManager('slack-completion');
  configureDirectorSlack('en');
  const slack = fakeDirectorSlack();
  const provider = patrolProvider();
  const daemon = await startPatrolDaemon(true);
  await daemon.poll();
  await expectCompletedPatrol(provider, 1);
  const goal = await seedPatrolGoal(repository, { status: 'completed', completion: { ...mergeEvidence(), targetSha: 'b'.repeat(40) } });
  provider.call.mockImplementationOnce(async (_prompt, options) => {
    const config = options.mcpServers![DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP director MCP required');
    const client = new Client({ name: 'completion-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'takt_notify_human', arguments: { message: 'Completed goal ready for the human',
        target: { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: goal.id } } });
      expect(result.isError).not.toBe(true);
      expect(await savedDirectorNotices()).toHaveLength(1);
    } finally { await client.close(); await transport.close(); }
    if (fails) throw new Error('Provider failed after saving the notice');
    return { persona: 'director', status: 'done', content: 'Human turn finished', timestamp: new Date() };
  });
  const human = new ConversationIpcClient({ kind: 'daemon' });
  const outputs: PortOutput[] = [];
  human.onOutput((output) => outputs.push(output));
  cleanups.push(async () => human.close());
  await human.connect();
  expect((await human.submit({ kind: 'message', text: 'Report the completed goal' })).kind).toBe('accepted');
  await vi.waitFor(() => expect(provider.disposedConnections).toBe(2), { timeout: 30_000 });
  await vi.waitFor(() => expect(slack.client.postMessage).toHaveBeenCalledOnce(), { timeout: 5000 });
  expect(slack.client.postMessage.mock.calls[0]).toEqual([
    'C0DIR', expect.stringContaining('Completed goal ready for the human'), expect.any(Array),
  ]);
  const [notice] = await savedDirectorNotices();
  await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'notice', ...notice }), { timeout: 5000 });
  expect(slack.client.postThreadMessage).not.toHaveBeenCalled();
  human.close();
  const reopened = new ConversationIpcClient({ kind: 'daemon' });
  cleanups.push(async () => reopened.close());
  await reopened.connect();
  await vi.waitFor(() => expect(reopened.getSnapshot().readStatus).toBe('complete'), { timeout: 5000 });
  expect(reopened.getSnapshot().items).toContainEqual({ kind: 'display_event', event: notice });
  expect(slack.client.postMessage).toHaveBeenCalledOnce();
});
