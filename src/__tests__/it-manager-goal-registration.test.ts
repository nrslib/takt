import * as goalPr from '../infra/goals/pull-request.js';
import { readManagerTestDisplay } from './helpers/manager-display-items.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import * as conversationPlans from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { ManagerServiceClient, submitAndWait } from './helpers/manager-service-client.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import * as runExecution from '../features/tasks/execute/runTaskExecution.js';
import { resolveTaskOrderContent } from '../features/tasks/orderRevision.js';
import { ManagerEventSchema,deleteManagerEvent,readManagerEvents,saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { TaskRunner } from '../infra/task/runner.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { readProjectRegistry } from '../infra/config/global/projectRegistry.js';

vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

let root: string;
let cwd: string;
let client: Client;
let server: ReturnType<typeof createTaktMcpServer>;
function git(...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function tool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { cwd, ...args } });
  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
}
function reply(message: string, summary: ReturnType<typeof goalInput> | null = null) {
  return { persona: 'manager', status: 'done' as const, timestamp: new Date(), sessionId: 'shared-conversation', content: JSON.stringify({ message, summary }), structuredOutput: { message, summary } };
}
function session(call: ProviderAgent['call']) {
  const provider = new MockProvider();
  const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
  const plan = { ctx: { provider, providerType: 'mock' as const, model: undefined, lang: 'ja' as const }, strategy: { systemPrompt: 'manager fixture' } };
  vi.spyOn(conversationPlans, 'createManagerConversationPlan').mockReturnValue(plan);
  vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({ client, servers: {}, dispose: async () => {} });
  return { setup, session: new ManagerServiceClient({ cwd, plan }) };
}
beforeEach(async () => {
  vi.spyOn(goalPr, 'prepareGoalPullRequest').mockResolvedValue({ number: 1950, url: 'https://github.com/example/project/pull/1950' });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-manager-events-'))); cwd = join(root, 'project'); mkdirSync(cwd);
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global')); vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  git('remote', 'add', 'origin', cwd);
  writeFileSync(join(cwd, '.gitignore'), '.takt/\n'); git('add', '.gitignore'); git('commit', '-m', 'fixture');
  mkdirSync(join(cwd, '.takt')); writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\nmanager:\n  auto_run: false\n');
  mkdirSync(join(cwd, '.takt', 'workflows')); writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), 'name: safe\ninitial_step: implement\nsteps:\n  - name: implement\n    persona: coder\n    rules:\n      - condition: completed\n        next: COMPLETE\n');
  server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet: 'manager' });
  client = new Client({ name: 'manager-event-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
});
afterEach(async () => { await client?.close(); await server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each(['reply', 'provider_error', 'summary'] as const)('preserves the same human conversation at revision four through an independent event %s and then approves that proposal', async (outcome) => {
  const saved = conversationRecord(cwd);
  const conversations = new ConversationStore(getGlobalConfigDir());
  conversations.write(saved);
  const existing = await new GoalStore(cwd).create(goalRecord());
  saveManagerEvent(cwd, { kind: 'registered', goalId: existing.id });
  const eventResponse = reply('Independent event result', outcome === 'summary' ? goalInput() : null);
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue(outcome === 'provider_error'
    ? { ...eventResponse, status: 'error', error: 'Event provider failed' } : eventResponse);
  const context = session(call);
  const manager = createRunEventManager(cwd);
  try {
    await context.session.ready;
    const before = context.session.getSnapshot().state!;
    expect(before).toMatchObject({ conversationId: saved.id, revision: 4, pending: saved.pending });
    expect(await manager.processPending(new AbortController().signal, 1)).toBe(outcome === 'reply');
    const workLog = (await new GoalStore(cwd).get(existing.id)).workLog;
    if (outcome === 'reply') expect(workLog).toContainEqual(expect.objectContaining({ summary: 'Independent event result' }));
    else expect(workLog).toEqual([]);
    await context.session.refresh();
    expect(context.session.getSnapshot().state).toMatchObject({ conversationId: saved.id, revision: 4, pending: saved.pending });
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![1].sessionId).toBeUndefined();
    expect(await submitAndWait(context.session, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'goal_registered' });
    expect(conversations.read(saved.id, saved.assignment)).toMatchObject({ revision: 5, approval: { revision: 4, state: 'registered' }, pending: null });
    expect(call).toHaveBeenCalledOnce();
  } finally { await manager.close(); await context.session.dispose(); }
});

it('processes events separately from run and restores their saved records in the TUI', async () => {
  let goalId = '';
  let results = 0;
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async (prompt) => {
    if (!prompt.startsWith('{')) {
      const [turnContext, ...paragraphs] = prompt.split('\n\n');
      expect(turnContext).toMatch(/^Conversation operation ID: [a-f0-9-]{36}\n/u);
      if (paragraphs.join('\n\n') === '取り込みました') {
        await tool('takt_check_goal_completion', { goalId });
        return reply('ゴールが完成しました');
      }
      return reply('要約を確認してください', goalInput());
    }
    const event = ManagerEventSchema.parse((JSON.parse(prompt.split('\n\nGoal memory')[0]!) as { event: unknown }).event);
    if (event.kind === 'registered') {
      goalId = event.goalId;
      await tool('takt_enqueue_goal_task', { goalId, purpose: '入力を実装する', workKey: 'input', task: '入力を実装する', workflow: 'safe' });
      return reply('最初のタスクを投入しました');
    }
    expect(event.kind).toBe('completion');
    if (event.kind !== 'completion') throw new Error('Unexpected event');
    const run = await tool('takt_list_tasks', {});
    expect(JSON.stringify(run)).toContain(event.taskName);
    const diff = await tool('takt_get_goal_diff', { goalId, taskName: event.taskName });
    expect(diff.sourceSha).toBe(event.result.sha);
    await tool('takt_merge_goal_task', { goalId, taskName: event.taskName, expectedSha: event.result.sha });
    results++;
    if (results === 1) await tool('takt_enqueue_goal_task', { goalId, purpose: '出力を実装する', workKey: 'output', task: '出力を実装する', workflow: 'safe' });
    else {
      const goal = await new GoalStore(cwd).get(goalId);
      await tool('takt_complete_goal', { goalId, expectedSha: git('rev-parse', goal.branch), summary: '入力と出力の成果を確認しました' });
    }
    return reply('結果を取り込みました');
  });
  const context = session(call);
  const submit = vi.spyOn(context.session, 'submit');
  const manager = createRunEventManager(cwd);
  const signal = new AbortController().signal;
  try {
    await submitAndWait(context.session, { kind: 'message', text: 'ゴールを相談します' });
    const registered = await submitAndWait(context.session, { kind: 'approve_summary', revision: context.session.getSnapshot().state!.pending!.revision });
    expect(registered.kind).toBe('goal_registered'); expect(call).toHaveBeenCalledOnce();
    expect((await readProjectRegistry(process.env.TAKT_CONFIG_DIR!)).projects).toContainEqual(expect.objectContaining({
      canonicalDirectory: cwd, managerUsed: true,
    }));
    expect(readManagerEvents(cwd).map(({ event }) => event.kind)).toEqual(['registered']);
    vi.spyOn(runExecution, 'executeRunTaskAndCompleteWithDetails').mockImplementation(async (task, runner) => {
      const resultBranch = `result-${results}`;
      git('switch', '-c', resultBranch, task.data!.base_branch!);
      writeFileSync(join(cwd, `result-${results}.txt`), resolveTaskOrderContent(cwd, task.taskDir, task.content));
      git('add', `result-${results}.txt`); git('commit', '-m', `result ${results}`);
      const sha = git('rev-parse', 'HEAD'); git('switch', 'main');
      const runSlug = `run-${results}`;
      const completion = { success: true, interrupted: false, branch: resultBranch, sha };
      runner.updateRunningTaskExecution(task.name, { runSlug, branch: resultBranch });
      runner.completeTask({ task: { ...task, runSlug }, success: true, response: 'done', startedAt: task.createdAt, completedAt: new Date().toISOString(), executionLog: [], branch: resultBranch, completion });
      return { success: true, runSlug, completion };
    });
    const runner = new TaskRunner(cwd);
    const empty = await runWithWorkerPool(runner, [], 1, cwd, { provider: 'mock' }, undefined, 10);
    expect(empty).toEqual({ success: 0, fail: 0, executedTaskNames: [] });
    expect(readManagerEvents(cwd).map(({ event }) => event.kind)).toEqual(['registered']);
    expect(call).toHaveBeenCalledOnce();
    await manager.processPending(signal, 10);
    for (let index = 0; index < 2; index++) {
      const result = await runWithWorkerPool(runner, [], 1, cwd, { provider: 'mock' }, undefined, 10);
      expect(result).toMatchObject({ success: 1, fail: 0 });
      expect(readManagerEvents(cwd).map(({ event }) => event.kind)).toEqual(['completion']);
      expect(call).toHaveBeenCalledTimes(index + 2);
      await manager.processPending(signal, 10);
    }
    expect(call).toHaveBeenCalledTimes(4);
    expect(readManagerEvents(cwd)).toEqual([]);
    expect((await new GoalStore(cwd).get(goalId)).workLog.map((record) => record.summary)).toContain('最初のタスクを投入しました');
    const display = await readManagerTestDisplay(cwd, 'ja');
    expect(display.events.map(({ message }) => message)).toContain(`${goalId}: 最初のタスクを投入しました`);
    const waiting = await new GoalStore(cwd).get(goalId);
    expect(waiting.status).toBe('awaiting_merge'); expect(waiting.completion?.targetSha).toBeUndefined();
    git('merge', '--no-ff', '--no-edit', waiting.completion!.goalSha);
    expect((await submitAndWait(context.session, { kind: 'message', text: '取り込みました' })).kind).toBe('reply');
    expect((await new GoalStore(cwd).get(goalId)).status).toBe('completed');
    expect(git('show', 'main:result-0.txt')).toContain('入力'); expect(git('show', 'main:result-1.txt')).toContain('出力');
    expect(context.setup).toHaveBeenCalledTimes(2);
    // Daemon events (calls 1-3) each start a fresh session; the TUI conversation (calls 0 and 4) keeps its own.
    expect(call.mock.calls.slice(1, 4).map(([, options]) => options.sessionId)).toEqual([undefined, undefined, undefined]);
    expect(call.mock.calls[4]![1].sessionId).toBe('shared-conversation');
    // Resumed provider sessions receive the request; current saved work is projected independently to the TUI.
    const latestWorkLog = (await new GoalStore(cwd).get(goalId)).workLog.filter((record) => record.kind !== 'patrol').at(-2)!.summary;
    const submission = await submit.mock.results.at(-1)!.value;
    if (submission.kind !== 'accepted') throw new Error('Expected an accepted conversation turn');
    const [turnContext, ...paragraphs] = call.mock.calls.at(-1)![0].split('\n\n');
    expect(turnContext!.split('\n')[0]).toBe(`Conversation operation ID: ${submission.operationId}`);
    expect(paragraphs.join('\n\n')).toBe('取り込みました');
    await context.session.refresh();
    expect(context.session.getSnapshot().items).toContainEqual(expect.objectContaining({
      kind: 'display_event', event: expect.objectContaining({ message: expect.stringContaining(latestWorkLog) }),
    }));
  } finally { await manager.close(); await context.session.dispose(); }
});
it('keeps events while paused, handles the saved answer after resume, and discards them after abort', async () => {
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue(reply('処理しました'));
  const context = session(call);
  const manager = createRunEventManager(cwd);
  const signal = new AbortController().signal;
  const { registerFixtureGoal } = await import('./helpers/registered-goal.js');
  const goal = await registerFixtureGoal(cwd);
  deleteManagerEvent(readManagerEvents(cwd)[0]!);
  const asked = await tool('takt_ask_goal_question', { goalId: goal.id, body: '形式はどれですか', options: ['CSV', 'JSON'] });
  try {
    await submitAndWait(context.session, { kind: 'pause_goal', goalId: goal.id });
    saveManagerEvent(cwd, { kind: 'completion', goalId: goal.id, taskName: 'ended', runSlug: 'run-ended', result: { success: false, interrupted: true } });
    await submitAndWait(context.session, { kind: 'answer_question', target: { goalId: goal.id, repositoryDirectory: cwd }, questionId: asked.questionId as string, answer: { text: 'CSV' } });
    await manager.processPending(signal, 10); expect(call).not.toHaveBeenCalled(); expect(readManagerEvents(cwd)).toHaveLength(2);
    await submitAndWait(context.session, { kind: 'resume_goal', goalId: goal.id });
    expect(readManagerEvents(cwd)).toHaveLength(3);
    await manager.processPending(signal, 10);
    expect(readManagerEvents(cwd)).toEqual([]); expect(call).toHaveBeenCalledTimes(3);
    saveManagerEvent(cwd, { kind: 'completion', goalId: goal.id, taskName: 'later', runSlug: 'run-later', result: { success: false, interrupted: false } });
    await submitAndWait(context.session, { kind: 'abort_goal', goalId: goal.id }); expect(readManagerEvents(cwd)).toEqual([]);
    saveManagerEvent(cwd, { kind: 'completion', goalId: goal.id, taskName: 'stopped', runSlug: 'run-stopped', result: { success: false, interrupted: true } });
    expect(readManagerEvents(cwd)).toEqual([]); expect((await submitAndWait(context.session, { kind: 'resume_goal', goalId: goal.id })).kind).toBe('error');
  } finally { await manager.close(); await context.session.dispose(); }
});
