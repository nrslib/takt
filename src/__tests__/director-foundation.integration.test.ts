import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { conversationId } from '../infra/conversations/identity.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { directorConversationRecord } from './helpers/conversation-fixtures.js';
import { GoalStore } from '../infra/goals/store.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { createDaemonConversationRuntime } from '../features/director/conversationRuntime.js';
import { createDirectorConversationPlan } from '../features/director/conversationPlan.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { resolveNonWorkflowProviderOptions } from '../infra/config/index.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_NAMES, DIRECTOR_TOOL_ALLOWLIST } from '../features/director/mcp.js';
import { listDirectorManagers } from '../features/director/managers.js';
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
import * as managerPlans from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { TaskStore } from '../infra/task/store.js';
import * as localMcp from '../features/mcp/localConnection.js';
import type { RunMeta } from '../core/workflow/run/run-meta.js';
import { packageVersion } from '../shared/package-info.js';
import * as privateFiles from '../shared/utils/private-file.js';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(), resolveGitRepositoryDirectory: async (value: string) => value,
}));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

const actions = { tellManager: vi.fn(async () => ({ kind: 'accepted' })), notifyHuman: vi.fn(async (message: string) => ({ id: randomUUID(), message })) };
let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  directory = getGlobalConfigDir();
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
});
const signal = () => new AbortController().signal;
function decoded(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === 'text')!.text!) as Record<string, unknown>;
}
async function connectMcp() {
  const server = createDirectorMcpServer(directory, actions, signal());
  const client = new Client({ name: 'director-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client };
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
  const { managers, errors } = await listDirectorManagers(directory);
  expect(errors).toEqual([]);
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
  const runtime = createDaemonConversationRuntime(directory, actions);
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

it('roundtrips director Slack configuration and traces both keys to the global file', () => {
  const configPath = join(directory, 'config.yaml');
  const slack = { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'] };
  writeFileSync(configPath, JSON.stringify({ provider: 'mock', language: 'en', director: { slack },
    manager: { auto_run: false } }));
  invalidateGlobalConfigCache();
  const loaded = loadGlobalConfig();
  expect(loaded).toMatchObject({ director: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] } } });
  saveGlobalConfig(loaded);
  expect(parseYaml(readFileSync(configPath, 'utf8'))).toMatchObject({ director: { slack },
    manager: { auto_run: false } });
  invalidateGlobalConfigCache();
  expect(loadGlobalConfig()).toEqual(loaded);
  const traced = loadGlobalConfigTrace(configPath, (value) => value, []);
  expect(traced.rawConfig).toMatchObject({ director: { slack } });
  for (const key of ['director.slack.channel_id', 'director.slack.allowed_user_ids']) {
    expect(traced.trace.getOrigin(key), key).toBe('global');
  }
});
