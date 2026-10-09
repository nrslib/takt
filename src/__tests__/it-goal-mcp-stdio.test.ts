import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { basename, join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { createTaktMcpServer, TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { TaskRunner } from '../infra/task/runner.js';
import { reconcileGoalTasks } from '../infra/goals/reconcile.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { recoverManagerEvents } from '../features/manager/completionTurn.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { confirmationKeys, confirmationPayload, goalId, goalInput, signedConfirmation } from './helpers/goal-fixtures.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

describe('Goal MCP stdio entrypoint', () => {
  it.each(['source', 'dist'] as const)('propagates the host public key from the %s stdio entrypoint to goal creation', async (entrypoint) => {
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    const cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'goal-mcp-stdio-')));
    const keys = confirmationKeys();
    const publicKeyPath = join(cwd, 'confirmation.pub');
    writeFileSync(publicKeyPath, keys.publicKey);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
    };
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, env, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Goal Test'], { cwd, env });
    execFileSync('git', ['config', 'user.email', 'goal@example.test'], { cwd, env });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, env, input: '', encoding: 'utf-8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'goal fixture'], { cwd, env, encoding: 'utf-8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd, env });
    const client = new Client({ name: 'goal-stdio-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...(entrypoint === 'source' ? [
          'node_modules/.bin/vite-node', '--config', 'src/__tests__/helpers/vite-node.config.ts',
          'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts',
        ] : ['dist/app/mcp/index.js']),
        '--goal-confirmation-public-key', publicKeyPath,
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR!,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM!,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_create_goal');
      const result = await client.callTool({ name: 'takt_create_goal', arguments: {
        cwd, ...goalInput(), confirmation: signedConfirmation(confirmationPayload(cwd), keys.privateKey),
      } });
      expect(result.isError).toBeUndefined();
      const created = (JSON.parse(firstTextContent(result.content)) as { goal: { id: string; branch: string } }).goal;
      expect(created.id).toBe(goalId);
      expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
      expect(execFileSync('git', ['rev-parse', `refs/heads/${created.branch}`], { cwd, env, encoding: 'utf-8' }).trim()).toBe(commit);
    } finally {
      await client.close();
      await transport.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

const questionSchema = z.object({
  id: z.string().min(1), body: z.string(), status: z.enum(['pending', 'answered', 'withdrawn']),
  options: z.array(z.string()).optional(), recommendation: z.string().optional(),
  dependentWorkKeys: z.array(z.string()).optional(),
  answer: z.object({ text: z.string(), source: z.literal('tui'), answeredAt: z.iso.datetime() }).optional(),
});
const askedQuestion = {
  body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV', dependentWorkKeys: ['export'],
};
const kinds = ['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom'] as const;
type NotificationKind = typeof kinds[number];

describe('manager questions, answers and notifications through production boundaries', () => {
  let cwd: string;
  let client: Client;
  let closeMcp: () => Promise<void>;
  let http: Server;
  let webhook: string;
  let requests: { method: string | undefined; contentType: string | undefined; text: string }[];
  let responseStatus: number;
  let session: ReturnType<typeof createManagerConversationSession> | undefined;
  let app: ReturnType<typeof render> | undefined;
  let connection: Awaited<ReturnType<typeof connectManagerMcp>> | undefined;

  function git(args: string[], input?: string): string {
    return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: 'pipe', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Manager Test', GIT_AUTHOR_EMAIL: 'manager@example.test',
      GIT_COMMITTER_NAME: 'Manager Test', GIT_COMMITTER_EMAIL: 'manager@example.test',
    } }).trim();
  }

  function configure(disabled?: NotificationKind, mode: 'auto' | 'approve' = 'approve'): void {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'provider: mock', 'language: en', 'branch_name_strategy: romaji', 'manager:',
      '  auto_run: false', `  main_merge: ${mode}`,
      ...(disabled === undefined ? [] : ['  notifications:', `    ${disabled}: false`]),
    ].join('\n'));
    invalidateResolvedConfigCache(cwd);
  }

  beforeEach(async () => {
    resetScenario();
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'manager-questions-')));
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'Manager Test']);
    git(['config', 'user.email', 'manager@example.test']);
    const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    const sha = git(['commit-tree', tree, '-m', 'manager questions fixture']);
    git(['update-ref', 'refs/heads/main', sha]);
    git(['symbolic-ref', 'HEAD', 'refs/heads/human/work']);
    git(['update-ref', 'refs/heads/human/work', sha]);
    git(['update-ref', `refs/heads/${goalRecord().branch}`, sha]);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), [
      'name: safe', 'description: question fixture', 'max_steps: 2', 'initial_step: work', 'steps:',
      '  - name: work', '    instruction: "{task}"', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    configure();
    await new GoalStore(cwd).create(goalRecord());
    responseStatus = 200;
    requests = [];
    http = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        let payload: { text: string };
        try { payload = z.object({ text: z.string() }).parse(JSON.parse(body)); }
        catch { response.writeHead(400); response.end('Expected JSON with a text field'); return; }
        requests.push({ method: request.method, contentType: request.headers['content-type'], text: payload.text });
        if (responseStatus === 0) { request.socket.destroy(); return; }
        response.writeHead(responseStatus);
        response.end(responseStatus === 200 ? 'ok' : 'unavailable');
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a local HTTP port');
    webhook = `http://127.0.0.1:${address.port}/services/test-webhook`;
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', webhook);
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    client = new Client({ name: 'manager-question-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeMcp = async () => { try { await client.close(); } finally { await server.close(); } };
  });

  afterEach(async () => {
    app?.unmount();
    app = undefined;
    cleanup();
    try { await session?.close(); }
    finally {
      session = undefined;
      try { await connection?.dispose(); }
      finally {
        connection = undefined;
        try { await closeMcp(); }
        finally {
          await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
          vi.unstubAllEnvs();
          vi.restoreAllMocks();
          vi.mocked(crypto.randomUUID).mockReset().mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomUUID);
          resetScenario();
          invalidateGlobalConfigCache();
          invalidateResolvedConfigCache(cwd);
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    }
  });

  async function invoke(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: { cwd, goalId, ...args } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
  }

  async function ask(input: Record<string, unknown> = askedQuestion) {
    const result = await invoke('takt_ask_goal_question', input);
    const questionId = z.string().min(1).parse(result.questionId);
    return questionSchema.parse((await invoke('takt_get_goal_question', { questionId })).question);
  }

  async function enqueue(workKey?: string) {
    return client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
      cwd, goalId, task: 'Implement output validation', purpose: '出力を検証する', workflow: 'safe',
      ...(workKey === undefined ? {} : { workKey }),
    } });
  }

  async function mountManager(): Promise<void> {
    const confirmation = createGoalConfirmation(cwd);
    connection = await connectManagerMcp(cwd, confirmation.publicKey);
    const plan = createManagerConversationPlan(cwd, {});
    session = createManagerConversationSession({ cwd, confirmation, mcpClient: connection.client,
      plan: { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } } });
    app = render(createElement(ManagerView, { cwd, lang: 'en', session, initialDiagnostics: [], onExit: vi.fn() }));
    await vi.waitFor(() => expect(app!.lastFrame()?.replaceAll('\n', '')).toContain(basename(cwd)));
  }

  async function send(text: string): Promise<void> {
    app!.stdin.write(text);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(text));
    app!.stdin.write('\r');
  }

  async function selectJsonAnswer(questionId: string): Promise<void> {
    await send(`/answer ${questionId}`);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('Free text'));
    app!.stdin.write('\x1b[B');
    app!.stdin.write('\r');
    await vi.waitFor(async () => {
      const saved = z.object({ questions: z.array(questionSchema) }).parse(await new GoalStore(cwd).get(goalId));
      const question = saved.questions.find((candidate) => candidate.id === questionId);
      expect(question).toMatchObject({ status: 'answered', answer: { text: 'JSON', source: 'tui' } });
    }, { timeout: 30_000 });
  }

  it('saves optional question fields and reads the same question using the returned ID', async () => {
    const question = await ask();
    expect(question).toMatchObject({ ...askedQuestion, status: 'pending' });
    const stored = await invoke('takt_get_goal');
    expect(stored.goal).toMatchObject({ questions: [question] });
    const minimal = await ask({ body: '保存先はどこですか' });
    expect(minimal).toMatchObject({ body: '保存先はどこですか', status: 'pending' });
    expect(minimal.id).not.toBe(question.id);
  });

  it('preserves an existing question when the next generated ID collides', async () => {
    const collision = '650e8400-e29b-41d4-a716-446655440001';
    vi.mocked(crypto.randomUUID).mockReturnValue(collision);
    const existing = await ask({ body: '保存先はどこですか' });
    expect(existing.id).toBe(collision);
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    vi.mocked(crypto.randomUUID).mockImplementation(actual.randomUUID);
    // ロック・一時ファイルもIDを生成するため、衝突を有限の列で与える。
    for (let index = 0; index < 32; index += 1) vi.mocked(crypto.randomUUID).mockReturnValueOnce(collision);

    const result = await client.callTool({ name: 'takt_ask_goal_question', arguments: { cwd, goalId, ...askedQuestion } });

    expect(questionSchema.parse((await invoke('takt_get_goal_question', { questionId: existing.id })).question)).toEqual(existing);
    if (result.isError !== true) {
      const created = z.object({ questionId: z.string() }).parse(JSON.parse(firstTextContent(result.content)));
      expect(created.questionId).not.toBe(existing.id);
      expect((await invoke('takt_get_goal_question', { questionId: created.questionId })).question).toMatchObject(askedQuestion);
    }
  });

  it('refuses dependent work before creating its instructions or queue and permits unrelated work', async () => {
    const question = await ask();
    const blocked = await enqueue('export');
    expect(blocked.isError).toBe(true);
    expect(firstTextContent(blocked.content)).toContain(question.id);
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
    expect(existsSync(join(cwd, '.takt', 'tasks.yaml'))).toBe(false);
    expect(existsSync(join(cwd, '.takt', 'tasks')) ? readdirSync(join(cwd, '.takt', 'tasks')) : []).toEqual([]);

    expect((await enqueue('documentation')).isError).not.toBe(true);
    expect((await enqueue()).isError).not.toBe(true);
    expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(2);
    expect((await invoke('takt_get_goal_question', { questionId: question.id })).question).toMatchObject({ status: 'pending' });
  });

  it('withdraws a question, retains it in the list and allows its dependent work', async () => {
    const question = await ask();
    await invoke('takt_withdraw_goal_question', { questionId: question.id });
    const list = z.object({ questions: z.array(questionSchema) }).parse(await invoke('takt_list_goal_questions'));
    expect(list.questions).toEqual([expect.objectContaining({ id: question.id, status: 'withdrawn' })]);
    expect((await enqueue('export')).isError).not.toBe(true);
  });

  it('exposes the manager question and notification tools while preserving the read-only tool set', async () => {
    const added = ['takt_ask_goal_question', 'takt_list_goal_questions', 'takt_get_goal_question', 'takt_withdraw_goal_question', 'takt_notify_goal'];
    const names = (await client.listTools()).tools.map(({ name }) => name).sort();
    expect(names).toEqual([...TAKT_MCP_MANAGER_TOOL_NAMES].sort());
    expect(names).toEqual(expect.arrayContaining(added));
    const server = createTaktMcpServer({}, { toolSet: 'read-only', allowedProjectRoot: cwd });
    const reader = new Client({ name: 'question-read-only-test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await reader.connect(a);
      expect((await reader.listTools()).tools.map(({ name }) => name).sort()).toEqual([
        'takt_list_tasks', 'takt_get_run', 'takt_list_goals', 'takt_get_goal',
      ].sort());
    } finally { try { await reader.close(); } finally { await server.close(); } }
  });

  it('sends a question as a Slack text POST and persists its goal event without exposing the webhook', async () => {
    const question = await ask();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', contentType: 'application/json' });
    for (const value of [goalId, question.id, askedQuestion.body, 'CSV', 'JSON']) expect(requests[0]!.text).toContain(value);
    const displayed = await readManagerDisplayEvents(cwd);
    expect(displayed.events).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(askedQuestion.body) })]));
    expect(JSON.stringify((await invoke('takt_get_goal')).goal)).not.toContain(webhook);
    expect(JSON.stringify(displayed)).not.toContain(webhook);
  });

  it('delivers Slack from the host-connected manager MCP child process', async () => {
    await mountManager();

    const result = await connection!.client.callTool({ name: 'takt_ask_goal_question', arguments: { cwd, goalId, ...askedQuestion } });

    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const created = z.object({ questionId: z.string().min(1) }).parse(JSON.parse(firstTextContent(result.content)));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', contentType: 'application/json' });
    expect(requests[0]!.text).toContain(created.questionId);
    expect(requests[0]!.text).toContain(askedQuestion.body);
  }, 30_000);

  it.each(['blocked', 'custom'] as const)('sends %s notifications from the MCP tool and persists them for the TUI', async (kind) => {
    const body = kind === 'blocked' ? '検証環境の利用待ちです' : '評価対象の範囲を変更しました';
    await invoke('takt_notify_goal', { kind, body, severity: 'warning' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain(body);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(body) })]));
  });

  it('persists question state and a TUI event without sending Slack when the webhook is unset', async () => {
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    const question = await ask();
    expect(question.status).toBe('pending');
    expect(requests).toEqual([]);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(question.body) })]));
  });

  it.each(['HTTP error', 'connection error'] as const)('keeps the question usable and records a diagnostic after a Slack %s', async (failure) => {
    responseStatus = failure === 'HTTP error' ? 503 : 0;
    const question = await ask();
    expect(question.status).toBe('pending');
    const display = await readManagerDisplayEvents(cwd);
    const diagnostics = [...display.events, ...display.diagnostics].filter(({ message }) => /slack|webhook/i.test(message));
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) expect(diagnostic.message).not.toContain(webhook);
    await invoke('takt_withdraw_goal_question', { questionId: question.id });
    expect((await enqueue('export')).isError).not.toBe(true);
  });

  it('disables question notifications while retaining questions, dependency checks and other notification kinds', async () => {
    configure('question');
    const question = await ask();
    expect(question.status).toBe('pending');
    expect(requests).toEqual([]);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual([]);
    const refused = await enqueue('export');
    expect(refused.isError).toBe(true);
    expect(firstTextContent(refused.content)).toContain(question.id);
    await invoke('takt_notify_goal', { kind: 'custom', body: '独立した通知', severity: 'info' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain('独立した通知');
  });

  async function produce(kind: NotificationKind): Promise<void> {
    if (kind === 'question') { await ask(); return; }
    if (kind === 'blocked' || kind === 'custom') {
      await invoke('takt_notify_goal', { kind, body: `${kind} fixture notice`, severity: 'info' });
      return;
    }
    const branch = goalRecord().branch;
    const sha = git(['commit-tree', `${branch}^{tree}`, '-p', branch, '-m', 'completed work fixture']);
    if (kind === 'progress') {
      const source = 'takt/question-fixture-work';
      git(['update-ref', `refs/heads/${source}`, sha]);
      const runner = new TaskRunner(cwd);
      const added = runner.addTask('validated work', { workflow: 'safe', worktree: false,
        goal_id: goalId, goal_purpose: '出力の検証', branch: source });
      const claimed = runner.claimNextTasks(1)[0]!;
      const task = runner.updateRunningTaskExecution(claimed.name, { runSlug: 'question-fixture-run', branch: source });
      const completion = { success: true, interrupted: false, branch: source, sha };
      runner.completeTask({ task, success: true, branch: source, completion, response: 'validated',
        executionLog: [], startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z' });
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal,
        workUnits: [{ taskName: added.name, purpose: '出力の検証' }],
        events: [{ id: 'question-fixture-event', kind: 'completion', taskName: added.name, runSlug: 'question-fixture-run', processed: true, result: completion }],
      }));
      await invoke('takt_merge_goal_task', { taskName: added.name, expectedSha: sha });
    } else {
      git(['update-ref', `refs/heads/${branch}`, sha]);
      await invoke('takt_complete_goal', { expectedSha: sha, summary: '出力の検証が完了しました' });
    }
  }

  it.each(['progress', 'awaiting_merge', 'completed'] as const)('notifies Slack and the persisted TUI event after actual %s work', async (kind) => {
    configure(undefined, kind === 'completed' ? 'auto' : 'approve');
    await produce(kind);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain(goalId);
    const saved = z.object({ notifications: z.array(z.object({ kind: z.string() })) }).parse((await invoke('takt_get_goal')).goal);
    expect(saved.notifications.map((notification) => notification.kind)).toEqual([kind]);
    expect((await readManagerDisplayEvents(cwd)).events).toHaveLength(1);
  });

  it('does not duplicate saved progress, TUI events or Slack delivery when task integration is repeated', async () => {
    await produce('progress');
    const saved = await new GoalStore(cwd).get(goalId);
    const unit = saved.workUnits![0]!;
    const notifications = saved.notifications;
    const displayed = (await readManagerDisplayEvents(cwd)).events;
    expect(notifications).toHaveLength(1);
    expect(displayed).toHaveLength(1);
    expect(requests).toHaveLength(1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await invoke('takt_merge_goal_task', {
        taskName: unit.taskName, expectedSha: unit.integration!.expectedSha,
      });
      expect(result).toMatchObject({ status: 'merged', sha: unit.integration!.goalSha, recorded: true });
      expect((await new GoalStore(cwd).get(goalId)).notifications).toEqual(notifications);
      expect((await readManagerDisplayEvents(cwd)).events).toEqual(displayed);
      expect(requests).toHaveLength(1);
    }
  });

  it.each(kinds)('disables only %s notification delivery while preserving the underlying operation', async (kind) => {
    configure(kind, kind === 'completed' ? 'auto' : 'approve');
    await produce(kind);
    expect(requests).toEqual([]);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual([]);
    const goal = (await invoke('takt_get_goal')).goal;
    if (kind === 'question') expect(goal).toMatchObject({ questions: [expect.objectContaining({ status: 'pending' })] });
    else if (kind === 'progress') expect(goal).toMatchObject({ workUnits: [expect.objectContaining({ integration: expect.objectContaining({ status: 'merged' }) })] });
    else if (kind === 'completed' || kind === 'awaiting_merge') expect(goal).toMatchObject({ status: kind });
    await invoke('takt_notify_goal', { kind: kind === 'custom' ? 'blocked' : 'custom', body: '別種類の通知', severity: 'info' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain('別種類の通知');
  });

  it('notifies awaiting merge and then completion only after the human merge is included', async () => {
    await produce('awaiting_merge');
    expect(requests).toHaveLength(1);
    const check = await invoke('takt_check_goal_completion');
    expect(check.included).toBe(false);
    expect(requests).toHaveLength(1);
    git(['update-ref', 'refs/heads/main', git(['rev-parse', goalRecord().branch])]);
    await invoke('takt_check_goal_completion');
    expect((await new GoalStore(cwd).get(goalId)).status).toBe('completed');
    expect(requests).toHaveLength(2);
    const saved = z.object({ notifications: z.array(z.object({ kind: z.string() })) }).parse((await invoke('takt_get_goal')).goal);
    expect(saved.notifications.map((notification) => notification.kind)).toEqual(['awaiting_merge', 'completed']);
  });

  it('does not send a success notification when the reviewed SHA changed', async () => {
    const oldSha = git(['rev-parse', goalRecord().branch]);
    const nextSha = git(['commit-tree', `${oldSha}^{tree}`, '-p', oldSha, '-m', 'changed goal']);
    git(['update-ref', `refs/heads/${goalRecord().branch}`, nextSha]);
    const result = await client.callTool({ name: 'takt_complete_goal', arguments: { cwd, goalId,
      expectedSha: oldSha, summary: 'obsolete review' } });
    expect(result.isError).toBe(true);
    expect((await new GoalStore(cwd).get(goalId)).status).toBe('created');
    expect(requests).toEqual([]);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual([]);
  });

  it('does not announce completion or human merge readiness after an actual merge conflict', async () => {
    configure(undefined, 'auto');
    const base = git(['rev-parse', 'main']);
    for (const branch of ['main', goalRecord().branch]) {
      const blob = git(['hash-object', '-w', '--stdin'], `content for ${branch}\n`);
      const tree = git(['mktree'], `100644 blob ${blob}\toutput.txt\n`);
      const sha = git(['commit-tree', tree, '-p', base, '-m', `conflicting ${branch}`]);
      git(['update-ref', `refs/heads/${branch}`, sha]);
    }

    const result = await invoke('takt_complete_goal', {
      expectedSha: git(['rev-parse', goalRecord().branch]), summary: 'reviewed conflicting work',
    });

    expect(result).toMatchObject({ status: 'conflict' });
    expect((await new GoalStore(cwd).get(goalId)).status).toBe('created');
    expect(requests).toEqual([]);
    expect((await readManagerDisplayEvents(cwd)).events).toEqual([]);
  });

  it.each([200, 503, 0])('runs mock manager question creation, Slack delivery, TUI choice and dependent enqueue in the same screen (HTTP status: %s)', async (status) => {
    responseStatus = status;
    const input = { ...askedQuestion, recommendation: 'CSV: 表計算で確認できます' };
    const observed: { prompt: string; sessionId?: string; allowedTools?: string[]; permissionMode?: string; mcpOnlySideEffects?: readonly string[] }[] = [];
    const setup = MockProvider.prototype.setup;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        observed.push({ prompt, sessionId: options.sessionId, allowedTools: options.allowedTools,
          permissionMode: options.permissionMode, mcpOnlySideEffects: options.mcpOnlySideEffects });
        return agent.call(prompt, options);
      } };
    });
    const legacyPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    delete legacy.executionStatus; delete legacy.acceptanceCriteriaVersion;
    legacy.sessions = [{ provider: 'mock', sessionId: 'saved-goal-session' }];
    writeFileSync(legacyPath, JSON.stringify(legacy));
    await new GoalStore(cwd).create({ ...goalRecord(), id: '450e8400-e29b-41d4-a716-446655440001' });
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '回答を待ちます', summary: null }),
      mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_ask_goal_question', arguments: { cwd, goalId, ...input } }] }]);
    await mountManager();
    await send('出力の開発を進めてください');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('回答を待ちます'), { timeout: 30_000 });
    const list = z.object({ questions: z.array(questionSchema) }).parse(await invoke('takt_list_goal_questions'));
    const question = list.questions[0]!;
    expect(question).toMatchObject({ ...input, status: 'pending' });
    expect(requests).toHaveLength(1);
    if (status !== 200) {
      const displayed = await readManagerDisplayEvents(cwd);
      expect([...displayed.events, ...displayed.diagnostics].some(({ message }) => /slack|webhook/i.test(message))).toBe(true);
    }
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '質問を確認してください', summary: null }) }]);
    await send('保存された質問を表示してください');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('質問を確認してください'), { timeout: 30_000 });
    await vi.waitFor(() => {
      for (const text of [goalId, question.id, question.body, 'CSV', 'JSON', input.recommendation]) expect(app!.lastFrame()).toContain(text);
      expect(app!.lastFrame()).toContain('Pending questions');
    });
    const blocked = await enqueue('export');
    expect(blocked.isError).toBe(true);
    expect(firstTextContent(blocked.content)).toContain(question.id);
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '回答に従って投入しました', summary: null }),
      mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_enqueue_goal_task', arguments: {
        cwd, goalId, operationName: 'work:export', workKey: 'export', purpose: '回答で選ばれた出力を実装する', task: 'Implement JSON output', workflow: 'safe',
      } }] }]);

    await selectJsonAnswer(question.id);

    await vi.waitFor(() => expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1), { timeout: 30_000 });
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('回答に従って投入しました'), { timeout: 30_000 });
    expect(observed).toHaveLength(3);
    expect(JSON.parse(observed[2]!.prompt)).toMatchObject({
      goal: { id: goalId, questions: [] },
      event: { questionId: question.id, answer: { text: 'JSON', source: 'tui', answeredAt: expect.any(String) } },
    });
    expect(observed[2]).toMatchObject({ sessionId: undefined, permissionMode: 'readonly' });
    for (const call of observed) expect(call.prompt).not.toContain(webhook);
    expect(observed[2]!.mcpOnlySideEffects).toEqual(observed[2]!.allowedTools);
    expect(observed[2]!.allowedTools?.every((tool) => tool === 'Read' || tool.startsWith(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__`))).toBe(true);
    const answered = questionSchema.parse((await invoke('takt_get_goal_question', { questionId: question.id })).question);
    expect(answered).toMatchObject({ status: 'answered', answer: { text: 'JSON', source: 'tui', answeredAt: expect.any(String) } });
    const saved = z.object({ events: z.array(z.object({ questionId: z.string(), processed: z.boolean() })) }).parse((await invoke('takt_get_goal')).goal);
    expect(saved.events).toEqual([expect.objectContaining({ questionId: question.id, processed: true })]);
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('Pending questions'));
    const queued = new TaskRunner(cwd).listTaskStateItems()[0]!;
    expect(queued).toMatchObject({ goalId, goalWorkKey: 'export' });
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, workUnits: [] }));
    await reconcileGoalTasks(cwd, goalId);
    expect((await new GoalStore(cwd).get(goalId)).workUnits).toEqual([expect.objectContaining({ taskName: queued.name, workKey: 'export' })]);
  });

  it('records a free-text TUI answer without treating an AI self-report as a human operation', async () => {
    const question = await ask({ body: '出力先のパスを教えてください' });
    const answer = '/tmp/customer export';
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: `回答済み: ${question.id} ${answer}`, summary: null }) }]);
    await mountManager();
    await send('質問の内容を確認してください');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('回答済み:'), { timeout: 30_000 });
    expect((await invoke('takt_get_goal_question', { questionId: question.id })).question).toMatchObject({ status: 'pending' });
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '自由記述を確認しました', summary: null }) }]);
    await send(`/answer ${question.id}`);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('Enter your answer'));
    await send(answer);
    await vi.waitFor(async () => {
      expect((await invoke('takt_get_goal_question', { questionId: question.id })).question)
        .toMatchObject({ status: 'answered', answer: { text: answer, source: 'tui' } });
    }, { timeout: 30_000 });
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('自由記述を確認しました'), { timeout: 30_000 });
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
    const pending = await ask({ body: '通知の宛先はどこですか' });
    const withdrawn = await ask({ body: '不要になった確認' });
    await invoke('takt_withdraw_goal_question', { questionId: withdrawn.id });
    const list = z.object({ questions: z.array(questionSchema) }).parse(await invoke('takt_list_goal_questions'));
    expect(list.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: question.id, status: 'answered', answer: { text: answer, source: 'tui', answeredAt: expect.any(String) } }),
      expect.objectContaining({ id: pending.id, status: 'pending' }),
      expect.objectContaining({ id: withdrawn.id, status: 'withdrawn' }),
    ]));
  });

  it('recovers the same saved answer event after a failed manager turn without recording the answer again', async () => {
    const question = await ask();
    setMockScenario([{ persona: 'manager', status: 'error', content: '', error: 'injected answer turn failure' }]);
    await mountManager();
    await selectJsonAnswer(question.id);
    await vi.waitFor(async () => {
      const saved = z.object({ events: z.array(z.object({ questionId: z.string(), processed: z.boolean() })) }).parse(await new GoalStore(cwd).get(goalId));
      expect(saved.events).toEqual([expect.objectContaining({ questionId: question.id, processed: false })]);
      expect(JSON.stringify(await readManagerDisplayEvents(cwd))).toContain('injected answer turn failure');
    }, { timeout: 10_000 });
    const savedQuestion = async () => z.object({ questions: z.array(questionSchema) }).parse(await new GoalStore(cwd).get(goalId))
      .questions.find((candidate) => candidate.id === question.id);
    const before = await savedQuestion();
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '回答ターンを復旧しました', summary: null }) }]);
    await recoverManagerEvents(cwd);
    expect(await savedQuestion()).toEqual(before);
    const after = z.object({ events: z.array(z.object({ questionId: z.string(), processed: z.boolean() })) }).parse(await new GoalStore(cwd).get(goalId));
    expect(after.events).toEqual([expect.objectContaining({ questionId: question.id, processed: true })]);
  }, 30_000);

  it('shows saved notifications on reopening and on the next message in the same mounted TUI', async () => {
    const first = '保存済みの進捗を確認してください';
    const second = '次の取り込みを待っています';
    await invoke('takt_notify_goal', { kind: 'custom', body: first, severity: 'info' });
    await mountManager();
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(first));
    await invoke('takt_notify_goal', { kind: 'blocked', body: second, severity: 'warning' });
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '状況を確認しました', summary: null }) }]);
    await send('状況を教えてください');
    await vi.waitFor(() => {
      expect(app!.lastFrame()).toContain(first);
      expect(app!.lastFrame()).toContain(second);
      expect(app!.lastFrame()).toContain('状況を確認しました');
    });
    app!.unmount();
    app = render(createElement(ManagerView, { cwd, lang: 'en', session: session!, initialDiagnostics: [], onExit: vi.fn() }));
    await vi.waitFor(() => {
      expect(app!.lastFrame()).toContain(first);
      expect(app!.lastFrame()).toContain(second);
    });
  }, 30_000);
});
