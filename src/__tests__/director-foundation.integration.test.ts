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
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { createDaemonConversationRuntime } from '../features/director/conversationRuntime.js';
import { createDirectorConversationPlan } from '../features/director/conversationPlan.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { resolveNonWorkflowProviderOptions } from '../infra/config/index.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_NAMES, DIRECTOR_TOOL_ALLOWLIST, type DirectorStateActions } from '../features/director/mcp.js';
import { listDirectorManagers } from '../features/director/managers.js';
import { createDirectorManagerPort } from '../features/director/managerPort.js';
import { changeDirectorGoalQuestionRoute } from '../features/director/goalQuestions.js';
import type { AcceptedEvent } from '../core/daemon/events.js';
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

const actions = { setQuestionRoute: vi.fn(async () => ({})), tellManager: vi.fn(async () => ({ kind: 'accepted' })), notifyHuman: vi.fn(async (message: string) => ({ id: randomUUID(), message })) };
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
async function connectMcp(stateActions: DirectorStateActions = actions) {
  const server = createDirectorMcpServer(directory, stateActions, signal());
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

function humanRouteEvent(): AcceptedEvent {
  return { eventId: randomUUID(), requestId: randomUUID(), conversationId: conversationId({ kind: 'daemon' }),
    source: 'tui', occurredAt: new Date().toISOString(), operationId: randomUUID(), acceptedSequence: 1, lane: 'human',
    event: { kind: 'human_command', command: { kind: 'message', text: 'Please change the question route' },
      speaker: { namespace: 'tui-user', id: 'human' } } };
}

it('changes the question route only in a real human turn and preserves existing questions and answers across both changes', async () => {
  const repository = await seedManager('routing');
  const saved = saveGoal(repository, 'created', 'active');
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const pending = saved.questions[0]!;
  const permission = createInquiry({ body: 'Permission?', questionType: 'permission' });
  const history = { ...createInquiry({ body: 'Previous?' }), status: 'answered' as const,
    answer: { text: 'Earlier', source: 'tui' as const, answeredBy: 'human' as const, answeredAt: new Date().toISOString() } };
  await new GoalStore(repository).update(saved.id, goal => ({ ...goal, questions: [pending, permission, history] }));
  const target = { managerId, cwd: repository, goalId: saved.id };
  let event = humanRouteEvent();
  const setQuestionRoute = vi.fn<DirectorStateActions['setQuestionRoute']>(
    async (value, route, origin) => changeDirectorGoalQuestionRoute(directory, value, route, origin, event, signal()));
  const { client } = await connectMcp({ ...actions, setQuestionRoute });
  const change = (questionRoute: 'human' | 'director', origin = 'human') => client.callTool({ name: 'takt_set_goal_question_route',
    arguments: { ...target, questionRoute, origin } });
  expect((await change('director')).isError).toBeUndefined();
  expect(await new GoalStore(repository).get(saved.id)).toMatchObject({ creationOrigin: 'manager', questionRoute: 'director',
    questions: [{ id: pending.id, recipient: 'director' }, { id: permission.id, recipient: 'human' }, history] });
  expect((await change('human')).isError).toBeUndefined();
  expect((await new GoalStore(repository).get(saved.id)).questions).toEqual([pending, permission, history]);
  const before = await new GoalStore(repository).get(saved.id);
  expect((await change('director', 'director')).isError).toBe(true);
  event = { ...event, source: 'watcher', event: { kind: 'patrol', goalIds: [saved.id] } };
  expect((await change('director')).isError).toBe(true);
  event = { ...humanRouteEvent(), event: { kind: 'human_command', command: { kind: 'message', text: 'Fake human' },
    speaker: { namespace: 'agent', id: 'director' } } };
  expect((await change('director')).isError).toBe(true);
  expect(await new GoalStore(repository).get(saved.id)).toEqual(before);
});

it('answers only director inquiries through the dedicated tools and hands an unsure question to the human', async () => {
  const repository = await seedManager('answers');
  const saved = saveGoal(repository, 'created', 'active');
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const direct = createInquiry({ body: 'Use an array?', recipient: 'director' });
  const unclear = createInquiry({ body: 'Unclear requirement', recipient: 'director' });
  await new GoalStore(repository).update(saved.id, goal => ({ ...goal, creationOrigin: 'director', questionRoute: 'director',
    questions: [direct, unclear, ...saved.questions] }));
  const { client } = await connectMcp();
  const target = { managerId, cwd: repository, goalId: saved.id };
  const answer = (questionId: string, extra = {}) => client.callTool({ name: 'takt_answer_goal_question',
    arguments: { ...target, questionId, answer: { text: 'Use the existing array', ...extra } } });
  expect((await answer(saved.questions[0]!.id)).isError).toBe(true);
  expect((await answer(direct.id, { answeredBy: 'human' })).isError).toBe(true);
  expect((await client.callTool({ name: 'takt_answer_goal_question', arguments: { ...target, managerId: `manager-${'0'.repeat(64)}`,
    questionId: direct.id, answer: { text: 'Wrong owner' } } })).isError).toBe(true);
  expect((await answer(direct.id)).isError).toBeUndefined();
  expect((await new GoalStore(repository).get(saved.id)).questions?.[0]).toMatchObject({ status: 'answered',
    answer: { text: 'Use the existing array', answeredBy: 'director', source: 'mcp' } });
  expect(readManagerEvents(repository).find(({ event }) => event.kind === 'answer' && event.questionId === direct.id)).toMatchObject({
    event: { kind: 'answer', answer: { answeredBy: 'director', source: 'mcp' } } });
  expect((await client.callTool({ name: 'takt_escalate_goal_question', arguments: { ...target, questionId: unclear.id } })).isError).toBeUndefined();
  expect((await new GoalStore(repository).get(saved.id))).toMatchObject({ questionRoute: 'director',
    questions: expect.arrayContaining([expect.objectContaining({ id: direct.id, status: 'answered' }),
      expect.objectContaining({ id: unclear.id, recipient: 'human', questionType: 'unsure' })]) });
  expect((await answer(unclear.id)).isError).toBe(true);
  const listed = decoded(await client.callTool({ name: 'takt_list_goal_questions', arguments: { ...target, offset: 0, limit: 20 } }));
  expect(JSON.stringify(listed)).toContain('director');
  expect(decoded(await client.callTool({ name: 'takt_get_goal_question', arguments: { ...target, questionId: direct.id } }))).toMatchObject({
    question: { answer: { answeredBy: 'director', source: 'mcp' } } });
});
it('rejects retired approval answers after a human promotes a legacy goal', async () => {
  const repository = await seedManager('legacy-approval');
  const saved = saveGoal(repository, 'created', 'active');
  const approval = createInquiry({ body: 'Legacy tool approval', kind: 'approval',
    operation: { toolName: 'Bash', args: '{}', cwd: repository } });
  const file = join(repository, '.takt', 'goals', saved.id, 'goal.json');
  writeFileSync(file, JSON.stringify({ ...saved, creationOrigin: undefined, questionRoute: undefined,
    questions: [{ ...approval, questionType: undefined }] }));
  const target = { managerId: conversationId({ kind: 'repository', repositoryDirectory: repository }), cwd: repository, goalId: saved.id };
  const setQuestionRoute: DirectorStateActions['setQuestionRoute'] = (value, route, origin) =>
    changeDirectorGoalQuestionRoute(directory, value, route, origin, humanRouteEvent(), signal());
  const { client } = await connectMcp({ ...actions, setQuestionRoute });
  expect((await client.callTool({ name: 'takt_set_goal_question_route', arguments: { ...target,
    questionRoute: 'director', origin: 'human' } })).isError).toBeUndefined();
  expect((await new GoalStore(repository).get(saved.id)).questions?.[0]).toMatchObject({
    id: approval.id, recipient: 'director', kind: 'approval', questionType: 'routine', status: 'pending' });
  const before = readFileSync(file, 'utf8');
  const events = readManagerEvents(repository);
  for (const answer of [{ text: 'Allow the operation' }, { report: 'completed' }, { decision: 'allow' }]) {
    const result = await client.callTool({ name: 'takt_answer_goal_question', arguments: { ...target,
      questionId: approval.id, answer } });
    expect(result.isError).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readManagerEvents(repository)).toEqual(events);
  }
  expect(decoded(await client.callTool({ name: 'takt_get_goal_question', arguments: { ...target, questionId: approval.id } })))
    .toMatchObject({ question: { kind: 'approval', status: 'pending' } });
});
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
  const approval = await new StandaloneInquiryStore(directory, { kind: 'workspace', workspaceId: workspace.id }).create({ body: 'Approve a decision' });
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

it('filters an assigned manager repository goal list by state', async () => {
  const repository = await seedManager('repository-state');
  const open = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-000000000001' };
  const completed = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-000000000002', status: 'completed' as const, completion: {
    goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40), summary: 'Done',
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [],
  } };
  const aborted = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-000000000003', executionStatus: 'aborted' as const };
  for (const goal of [open, completed, aborted]) await new GoalStore(repository).create(goal);
  const { client } = await connectMcp();
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const list = async (args: Record<string, unknown>) => {
    const page = decoded(await client.callTool({ name: 'takt_list_goals', arguments: { managerId, cwd: repository, ...args } }));
    return { ids: (page.goals as { id: string }[]).map(({ id }) => id), totalCount: page.totalCount, nextOffset: page.nextOffset };
  };
  expect(await list({})).toEqual({ ids: [open.id, completed.id, aborted.id], totalCount: 3, nextOffset: null });
  expect(await list({ state: 'all' })).toEqual({ ids: [open.id, completed.id, aborted.id], totalCount: 3, nextOffset: null });
  expect(await list({ state: 'open' })).toEqual({ ids: [open.id], totalCount: 1, nextOffset: null });
  expect(await list({ state: 'finished', limit: 1 })).toEqual({ ids: [completed.id], totalCount: 2, nextOffset: 1 });
  expect(await list({ state: 'finished', limit: 1, offset: 1 })).toEqual({ ids: [aborted.id], totalCount: 2, nextOffset: null });
});

it('reads human answered history through director tools with question paging and answer text continuation', async () => {
  const repository = await seedManager('human-answer-history');
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const goal = saveGoal(repository, 'created', 'active');
  const questionId = goal.questions[0]!.id;
  const answerText = '日本語の回答'.repeat(20);
  const file = join(repository, '.takt', 'goals', goal.id, 'goal.json');
  const saved = JSON.stringify({ ...goal, questions: [{ ...goal.questions[0], status: 'answered',
    answer: { answeredBy: 'human' as const, text: answerText, source: 'mcp', answeredAt: '2026-11-18T00:00:00.000Z' } }] });
  writeFileSync(file, saved);
  const { client } = await connectMcp();
  const args = { managerId, cwd: repository, goalId: goal.id };

  const history = await client.callTool({ name: 'takt_get_goal', arguments: { ...args, path: 'questions', limit: 1 } });
  expect(history.isError).toBeUndefined();
  expect(decoded(history)).toMatchObject({ totalCount: 1, items: [{ id: questionId, status: 'answered',
    answer: { text: answerText, source: 'mcp', answeredBy: 'human' } }] });
  const detail = await client.callTool({ name: 'takt_get_goal', arguments: { ...args, path: 'questions.answer', recordId: questionId } });
  expect(detail.isError).toBeUndefined();
  expect(decoded(detail)).toMatchObject({ value: { source: 'mcp', answeredBy: 'human', text: answerText } });
  const textArgs = { ...args, path: 'questions.answer.text', recordId: questionId, maxBytes: 9 };
  const first = decoded(await client.callTool({ name: 'takt_get_goal', arguments: textArgs }));
  expect(first).toMatchObject({ content: '日本語', nextOffset: 9, truncated: true });
  expect(decoded(await client.callTool({ name: 'takt_get_goal', arguments: { ...textArgs, textOffset: first.nextOffset } })))
    .toMatchObject({ content: 'の回答', offset: 9 });
  expect((await client.callTool({ name: 'takt_get_goal', arguments: { ...args, cwd: join(directory, 'unassigned'), path: 'questions' } })).isError).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(saved);
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
  await prepared.executor.execute({ prompt: 'task', sessionId: undefined, assignment: undefined, abortSignal: signal() });
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
