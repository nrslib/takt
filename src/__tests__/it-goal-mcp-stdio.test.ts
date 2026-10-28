import { readManagerTestDisplay } from './helpers/manager-display-items.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cleanup,render } from 'ink-testing-library';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { createServer,type Server } from 'node:http';
import { basename,join } from 'node:path';
import { createElement } from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { z } from 'zod/v4';
import { connectTaktMcpServerToStdio } from '../app/mcp/index.js';
import { MANAGER_ASSIGNMENT_ENV } from '../features/manager/assignment.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { ensureDaemon } from '../features/daemon/lifecycle.js';
import * as autoRun from '../features/manager/autoRun.js';
import { ManagerServiceClient } from './helpers/manager-service-client.js';
import { connectManagerMcp } from '../features/manager/managerMcp.js';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createTaktMcpServer,TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../infra/goals/store.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalAbortMonitor, GoalAbortedError } from '../features/tasks/execute/goalAbortMonitor.js';
import { resetScenario,setMockScenario } from '../infra/mock/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { getLabel } from '../shared/i18n/index.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId,goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';

const stdioTransport = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: stdioTransport }));

vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

const standaloneItemSchema = z.object({
  id: z.uuid(), kind: z.enum(['question', 'approval', 'operation_request']),
  body: z.string(), createdAt: z.iso.datetime().nullable(),
});

describe('standalone inquiries through manager MCP tools', () => {
  let root: string;
  let cwd: string;
  let outside: string;
  let configDirectory: string;
  let owner: InquiryOwner;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;

  beforeEach(() => {
    vi.spyOn(autoRun, 'ensureManagerRun').mockResolvedValue(undefined);
    configDirectory = process.env.TAKT_CONFIG_DIR!;
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    root = realpathSync(mkdtempSync(join(temporaryRoot, 'standalone-mcp-')));
    cwd = join(root, 'assigned');
    outside = join(root, 'outside');
    for (const directory of [cwd, outside]) {
      mkdirSync(directory);
      initializeGitFixture(directory, []);
    }
    owner = { kind: 'repository', repositoryDirectory: cwd };
  });

  afterEach(async () => {
    try { await client?.close(); }
    finally {
      try { await server?.close(); }
      finally {
        vi.restoreAllMocks();
        invalidateResolvedConfigCache(cwd);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  async function connect(toolSet: 'manager' | 'all') {
    server = createTaktMcpServer({}, { toolSet, allowedProjectRoot: cwd, managerAssignment: owner });
    client = new Client({ name: 'standalone-inquiry-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  }

  async function list(extra: Record<string, unknown> = {}) {
    const result = await client.callTool({ name: 'takt_list_standalone_inquiries', arguments: { cwd, ...extra } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    const value: Record<string, unknown> = JSON.parse(firstTextContent(result.content));
    const page = z.object({
      collection: z.string(), totalCount: z.number().int(), returnedCount: z.number().int(),
      offset: z.number().int(), nextOffset: z.number().int().nullable(),
    }).parse(value);
    const inquiries = z.array(standaloneItemSchema).parse(value[page.collection]);
    expect(page.returnedCount).toBe(inquiries.length);
    return { ...page, inquiries };
  }

  async function withdraw(id: string, reason: string) {
    const result = await client.callTool({ name: 'takt_withdraw_standalone_inquiry', arguments: { cwd, id, reason } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    return firstTextContent(result.content);
  }

  it('reads only pending standalone inquiries with approval identity, kind, body and creation time without saving', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const approval = await store.create({ kind: 'approval', body: '終了した操作の承認を確認してください',
      operation: { toolName: 'Write', args: '{}', cwd } });
    const answered = await store.create({ body: '回答済みの相談' });
    await store.answer(answered.id, 'JSON');
    const withdrawn = await store.create({ body: '取り下げ済みの相談' });
    await store.withdraw(withdrawn.id, '解決済みです');
    const goalQuestion = { ...approval, id: crypto.webcrypto.randomUUID() };
    await new GoalStore(cwd).create({ ...goalRecord(), questions: [goalQuestion] });
    const before = await store.list();
    await connect('manager');

    const page = await list();

    expect(page.inquiries).toEqual([{ id: approval.id, kind: 'approval', body: approval.body, createdAt: approval.createdAt }]);
    expect(page.totalCount).toBe(1);
    expect(await new StandaloneInquiryStore(configDirectory, owner).list()).toEqual(before);
    expect(autoRun.ensureManagerRun).not.toHaveBeenCalled();
  });

  it('withdraws an obsolete approval with its original reason and timestamp and reduces pending data in the same session', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const approval = await store.create({ kind: 'approval', body: '終了した操作の承認',
      operation: { toolName: 'Write', args: '{}', cwd } });
    await connect('manager');
    expect((await list()).inquiries.map(({ id }) => id)).toEqual([approval.id]);
    const reason = '  対象の操作は終了しました\n' + '理由'.repeat(12000);
    const before = Date.now();

    expect(await withdraw(approval.id, reason)).toMatch(/withdrawn/u);

    const restored = new StandaloneInquiryStore(configDirectory, owner);
    const [saved] = await restored.list();
    expect(saved).toMatchObject({ ...approval, status: 'withdrawn', withdrawalReason: reason });
    expect(Date.parse(saved!.withdrawnAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved!.withdrawnAt!)).toBeLessThanOrEqual(Date.now());
    expect(await restored.listPending()).toEqual([]);
    expect(await list()).toMatchObject({ inquiries: [], totalCount: 0, nextOffset: null });
    expect(autoRun.ensureManagerRun).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'question' as const, answer: { text: 'JSON' } },
    { kind: 'operation_request' as const, answer: { report: 'completed' as const, text: '実施しました' } },
    { kind: 'approval' as const, answer: { decision: 'allow' as const, scope: 'project' as const } },
  ])('returns answered status without replacing a saved $kind answer', async ({ kind, answer }) => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const pending = await store.create({ kind, body: '確認してください',
      ...(kind === 'approval' ? { operation: { toolName: 'Write', args: '{}', cwd } } : {}) });
    const answered = await store.answer(pending.id, answer);
    await connect('manager');

    expect(await withdraw(pending.id, 'もう不要です')).toMatch(/answered/u);

    expect(await new StandaloneInquiryStore(configDirectory, owner).list()).toEqual([answered]);
    expect((await list()).inquiries).toEqual([]);
  });

  it('keeps the first withdrawal reason and time when the tool is called again', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const pending = await store.create({ body: '確認してください' });
    const original = await store.withdraw(pending.id, '最初の理由');
    await connect('manager');

    expect(await withdraw(pending.id, '別の理由')).toMatch(/withdrawn/u);

    expect(await new StandaloneInquiryStore(configDirectory, owner).list()).toEqual([original]);
  });

  it.each(['manager', 'all'] as const)('reads and withdraws only the assigned repository with %s tools', async (toolSet) => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const local = await store.create({ body: '現在の担当先の相談' });
    const otherStore = new StandaloneInquiryStore(configDirectory, { kind: 'repository', repositoryDirectory: outside });
    const other = await otherStore.create({ body: '別の担当先の相談' });
    await connect(toolSet);

    expect((await list()).inquiries.map(({ id }) => id)).toEqual([local.id]);
    for (const args of [{ cwd, id: other.id }, { cwd: outside, id: other.id }]) {
      const result = await client.callTool({ name: 'takt_withdraw_standalone_inquiry', arguments: { ...args, reason: '不要です' } });
      expect(result.isError).toBe(true);
    }
    const denied = await client.callTool({ name: 'takt_list_standalone_inquiries', arguments: { cwd: outside } });
    expect(denied.isError).toBe(true);
    expect(await otherStore.list()).toEqual([other]);
    await withdraw(local.id, '現在の担当先で解決しました');
    expect(await otherStore.list()).toEqual([other]);
  });

  it.each(['manager', 'all'] as const)('uses workspace ownership without reading project inquiries with %s tools', async (toolSet) => {
    const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: '担当 workspace', repositoryDirectories: [cwd, outside] });
    owner = { kind: 'workspace', workspaceId: workspace.id };
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const shared = await store.create({ body: 'workspace の相談' });
    const localStore = new StandaloneInquiryStore(configDirectory, { kind: 'repository', repositoryDirectory: outside });
    const local = await localStore.create({ body: 'project の相談' });
    const otherWorkspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: '別の workspace', repositoryDirectories: [] });
    const otherStore = new StandaloneInquiryStore(configDirectory, { kind: 'workspace', workspaceId: otherWorkspace.id });
    const other = await otherStore.create({ body: '別の workspace の相談' });
    await connect(toolSet);

    for (const directory of toolSet === 'manager' ? [cwd, outside] : [cwd]) {
      expect((await list({ cwd: directory })).inquiries.map(({ id }) => id)).toEqual([shared.id]);
    }
    const requestCwd = toolSet === 'manager' ? outside : cwd;
    for (const id of [local.id, other.id]) {
      const result = await client.callTool({ name: 'takt_withdraw_standalone_inquiry', arguments: { cwd: requestCwd, id, reason: '不要です' } });
      expect(result.isError).toBe(true);
    }
    const result = await client.callTool({ name: 'takt_withdraw_standalone_inquiry', arguments: { cwd: requestCwd, id: shared.id, reason: '解決済みです' } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(await new StandaloneInquiryStore(configDirectory, owner).listPending()).toEqual([]);
    expect(await localStore.list()).toEqual([local]);
    expect(await otherStore.list()).toEqual([other]);
  });

  it('resolves the new workspace owner after adding a repository in the same MCP session', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const local = await store.create({ body: 'project の相談' });
    await connect('manager');
    expect((await list()).inquiries.map(({ id }) => id)).toEqual([local.id]);
    const result = await client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: outside } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const workspace = z.object({ workspace: z.object({ id: z.uuid() }) }).parse(JSON.parse(firstTextContent(result.content))).workspace;
    const workspaceStore = new StandaloneInquiryStore(configDirectory, { kind: 'workspace', workspaceId: workspace.id });
    const shared = await workspaceStore.create({ body: '新しい workspace の相談' });

    expect((await list()).inquiries.map(({ id }) => id)).toEqual([shared.id]);
    await withdraw(shared.id, 'workspace で解決しました');
    expect(await workspaceStore.listPending()).toEqual([]);
    expect(await store.list()).toEqual([local]);
  });

  it('returns every pending inquiry once through continuation offsets and handles empty and exhausted pages', async () => {
    await connect('manager');
    expect(await list()).toMatchObject({ inquiries: [], totalCount: 0, nextOffset: null });
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const expected = [];
    for (let index = 0; index < 5; index++) expected.push(await store.create({ body: `未回答 ${index}` }));
    const answered = await store.create({ body: '回答済み' });
    await store.answer(answered.id, 'JSON');
    const ids: string[] = [];
    let offset = 0;
    for (let index = 0; index < 3; index++) {
      const page = await list({ offset, limit: 2 });
      expect(page.offset).toBe(offset);
      expect(page.totalCount).toBe(5);
      expect(page.inquiries).toHaveLength(index < 2 ? 2 : 1);
      ids.push(...page.inquiries.map(({ id }) => id));
      if (index < 2) {
        expect(page.nextOffset).toBe(offset + page.inquiries.length);
        offset = page.nextOffset!;
      } else expect(page.nextOffset).toBeNull();
    }
    expect(ids.sort()).toEqual(expected.map(({ id }) => id).sort());
    expect(await list({ offset: 10, limit: 2 })).toMatchObject({ inquiries: [], totalCount: 5, offset: 10, nextOffset: null });
  });

  it('keeps continuation offsets aligned with byte-bounded pages without truncating saved bodies', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const body = '日本語\u0001\n"\\'.repeat(8000);
    const saved = [];
    for (let index = 0; index < 3; index++) saved.push(await store.create({ body: `${index}: ${body}` }));
    await connect('manager');
    const ids: string[] = [];
    let offset = 0;
    for (let index = 0; index < 3; index++) {
      const page = await list({ offset, limit: 50 });
      expect(page.totalCount).toBe(3);
      expect(page.inquiries.length).toBeGreaterThan(0);
      for (const inquiry of page.inquiries) {
        expect(inquiry.body.length).toBeLessThan(body.length);
        expect(inquiry.body).not.toContain('\uFFFD');
        ids.push(inquiry.id);
      }
      const nextOffset = offset + page.inquiries.length;
      expect(page.nextOffset).toBe(nextOffset < page.totalCount ? nextOffset : null);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(ids.sort()).toEqual(saved.map(({ id }) => id).sort());
    expect(await new StandaloneInquiryStore(configDirectory, owner).list()).toEqual(expect.arrayContaining(saved));
  });

  it('defaults a saved missing kind without inventing a creation time or rewriting the file', async () => {
    const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: '時刻なし', repositoryDirectories: [cwd] });
    owner = { kind: 'workspace', workspaceId: workspace.id };
    const id = crypto.webcrypto.randomUUID();
    const directory = join(configDirectory, 'workspaces', workspace.id, 'inquiries');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.json`);
    const serialized = JSON.stringify({ id, body: '保存済みの相談', recipient: 'human', status: 'pending' });
    writeFileSync(path, serialized);
    await connect('manager');

    expect((await list()).inquiries).toEqual([{ id, body: '保存済みの相談', kind: 'question', createdAt: null }]);
    expect(readFileSync(path, 'utf8')).toBe(serialized);
  });

  it('reports an unknown inquiry ID as an error without changing the saved inquiries', async () => {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const saved = await store.create({ body: '現在の相談' });
    await connect('manager');
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_withdraw_standalone_inquiry');
    const result = await client.callTool({ name: 'takt_withdraw_standalone_inquiry', arguments: {
      cwd, id: crypto.webcrypto.randomUUID(), reason: '不要です',
    } });
    expect(result.isError).toBe(true);
    expect(await store.list()).toEqual([saved]);
  });

  it('reports an invalid saved inquiry instead of returning a successful partial page', async () => {
    const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: '保存エラー', repositoryDirectories: [cwd] });
    owner = { kind: 'workspace', workspaceId: workspace.id };
    const directory = join(configDirectory, 'workspaces', workspace.id, 'inquiries');
    mkdirSync(directory, { recursive: true });
    const records = [
      { id: '650e8400-e29b-41d4-a716-446655440001', body: '未回答', recipient: 'human', status: 'pending' },
      { id: '650e8400-e29b-41d4-a716-446655440002', body: '回答の欠落', recipient: 'human', status: 'answered' },
    ];
    for (const record of records) writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
    await connect('manager');
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_list_standalone_inquiries');

    const result = await client.callTool({ name: 'takt_list_standalone_inquiries', arguments: { cwd, limit: 1 } });

    expect(result.isError).toBe(true);
    for (const record of records) expect(JSON.parse(readFileSync(join(directory, `${record.id}.json`), 'utf8'))).toEqual(record);
  });
});

describe('manager goal execution tools through MCP', () => {
  const names = ['takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal'];
  let cwd: string;
  let store: GoalStore;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;
  let confirmation: Awaited<ReturnType<typeof startManagerMcpConnection>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'goal-execution-mcp-')));
    initializeGitFixture(cwd, []);
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
    execFileSync('git', ['branch', goalRecord().branch], { cwd, stdio: 'pipe' });
    store = new GoalStore(cwd);
    await store.create(goalRecord());
    vi.spyOn(autoRun, 'ensureManagerRun').mockResolvedValue(undefined);
    confirmation = await startManagerMcpConnection(cwd);
    const goalExecutionConnection = confirmation;
    const options = { toolSet: 'manager' as const, allowedProjectRoot: cwd, goalExecutionConnection };
    server = createTaktMcpServer({}, options);
    client = new Client({ name: 'goal-execution-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  });
  afterEach(async () => {
    try { await client.close(); }
    finally {
      try { await server.close(); } finally { await confirmation.dispose(); }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      invalidateResolvedConfigCache(cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exposes all three state operations to the manager without adding approval passthroughs', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
    for (const name of names) expect(TAKT_MCP_MANAGER_TOOL_NAMES.some((allowed) => allowed === name)).toBe(false);
  });

  it.each([false, true])('transfers goal execution exposure to the actual MCP child: %s', async (enableGoalExecutionTools) => {
    const connect: (
      cwd: string,
      assignment: Parameters<typeof connectManagerMcp>[1],
      servers: Parameters<typeof connectManagerMcp>[2],
      options: { enableGoalExecutionTools: boolean },
    ) => ReturnType<typeof connectManagerMcp> = connectManagerMcp;
    const connection = await connect(cwd, undefined, undefined, { enableGoalExecutionTools });
    try {
      const tools = (await connection.client.listTools()).tools.map(({ name }) => name);
      for (const name of names) expect(tools.includes(name)).toBe(enableGoalExecutionTools);
      expect(tools).toContain('takt_list_goals');
    } finally { await connection.dispose(); }
  }, 30_000);

  it.each([
    { name: 'takt_pause_goal', executionStatus: 'active' },
    { name: 'takt_resume_goal', executionStatus: 'paused' },
    { name: 'takt_abort_goal', executionStatus: 'active' },
  ] as const)('rejects $name through the public entrypoint despite the former enable flag', async ({ name, executionStatus }) => {
    await store.update(goalId, (goal) => ({ ...goal, executionStatus }));
    vi.stubEnv(MANAGER_ASSIGNMENT_ENV, JSON.stringify({ kind: 'repository', repositoryDirectory: cwd }));
    const originalArgv = process.argv;
    const reader = new Client({ name: 'public-goal-execution-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    stdioTransport.mockReturnValueOnce(b);
    try {
      process.argv = [...originalArgv.slice(0, 2), '--tool-set', 'manager', '--enable-goal-execution-tools'];
      await connectTaktMcpServerToStdio();
      await reader.connect(a);
      const tools = (await reader.listTools()).tools.map(({ name }) => name);
      expect(tools).toContain('takt_list_goals');
      const goals = await reader.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(goals.isError).not.toBe(true);
      for (const operation of names) expect(tools).not.toContain(operation);
      const result = await reader.callTool({ name, arguments: {
        cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}),
      } });
      expect(result.isError).toBe(true);
      expect((await store.get(goalId)).executionStatus).toBe(executionStatus);
      expect(ensureDaemon).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      try { await reader.close(); } finally { await b.close(); }
    }
  });

  it.each([
    { toolSet: 'all', connected: false },
    { toolSet: 'all', connected: true },
    { toolSet: 'read-only', connected: false },
    { toolSet: 'read-only', connected: true },
    { toolSet: 'manager', connected: false },
  ] as const)('keeps goal execution unavailable for $toolSet connection (connected: $connected)', async ({ toolSet, connected }) => {
    const goalExecutionConnection = connected ? confirmation : undefined;
    const options = { toolSet, allowedProjectRoot: cwd, goalExecutionConnection };
    const restricted = createTaktMcpServer({}, options);
    const reader = new Client({ name: 'restricted-goal-execution-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await restricted.connect(b);
      await reader.connect(a);
      const tools = (await reader.listTools()).tools.map(({ name }) => name);
      for (const name of names) {
        expect(tools).not.toContain(name);
        const result = await reader.callTool({ name, arguments: { cwd, goalId, reason: '中止します' } });
        expect(result.isError).toBe(true);
      }
      expect((await store.get(goalId)).executionStatus).toBe('active');
    } finally { try { await reader.close(); } finally { await restricted.close(); } }
  });

  it('pauses, resumes and aborts the same goal while preserving its records and branch', async () => {
    const question = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const, kind: 'question' as const,
      body: '出力形式を選んでください', status: 'pending' as const };
    await store.update(goalId, (goal) => ({ ...goal, questions: [question] }));
    const runner = new TaskRunner(cwd);
    const task = runner.addTask('未実行の作業', { workflow: 'default', worktree: false, goal_id: goalId,
      goal_purpose: '結果を確認する', branch: goalRecord().branch });
    const unrelated = runner.addTask('別の作業', { workflow: 'default', worktree: false });
    const before = await store.get(goalId);
    const branchSha = () => execFileSync('git', ['rev-parse', goalRecord().branch], { cwd, encoding: 'utf8' }).trim();
    const sha = branchSha();
    const controller = new AbortController();
    const monitor = new GoalAbortMonitor(cwd, goalId, controller, { taskName: task.name, executionId: 'unstarted-task' });
    const invoke = async (name: string, extra: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { cwd, goalId, ...extra } });
      expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
    };
    try {
      expect((await store.get(goalId)).executionStatus).toBe('active');
      saveManagerEvent(cwd, { kind: 'registered', goalId });
      await invoke('takt_pause_goal');
      expect(await store.get(goalId)).toMatchObject({ id: goalId, executionStatus: 'paused', questions: [question] });
      expect(runner.listPendingTaskItems().map(({ name }) => name)).toContain(task.name);
      expect(readManagerEvents(cwd).map(({ event }) => event.goalId)).toContain(goalId);
      monitor.check();
      expect(controller.signal.aborted).toBe(false);
      expect(autoRun.ensureManagerRun).not.toHaveBeenCalled();

      await invoke('takt_resume_goal');
      expect((await store.get(goalId)).executionStatus).toBe('active');
      expect(readManagerEvents(cwd).map(({ event }) => event)).toContainEqual(expect.objectContaining({ kind: 'resumed', goalId }));
      expect(ensureDaemon).toHaveBeenCalledExactlyOnceWith();
      expect(autoRun.ensureManagerRun).toHaveBeenCalledExactlyOnceWith(cwd);
      expect((await store.get(goalId)).questions).toEqual([question]);
      monitor.check();
      expect(controller.signal.aborted).toBe(false);

      await invoke('takt_abort_goal', { reason: '要件の変更により中止します' });
      const aborted = await store.get(goalId);
      expect(aborted).toMatchObject({ id: goalId, executionStatus: 'aborted', objective: before.objective,
        branch: before.branch, workLog: before.workLog, acceptanceCriteria: before.acceptanceCriteria });
      expect(aborted.questions).toEqual([expect.objectContaining({ id: question.id, status: 'withdrawn' })]);
      expect(readManagerEvents(cwd).filter(({ event }) => event.goalId === goalId)).toEqual([]);
      expect(runner.listTaskStateItems()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: task.name, status: 'failed' }),
        expect.objectContaining({ name: unrelated.name, status: 'pending' }),
      ]));
      expect(branchSha()).toBe(sha);
      await vi.waitFor(() => expect(controller.signal.reason).toBeInstanceOf(GoalAbortedError), { timeout: 3000 });
      const result = await client.callTool({ name: 'takt_resume_goal', arguments: { cwd, goalId } });
      expect(result.isError).toBe(true);
      expect(await store.get(goalId)).toEqual(aborted);
      expect(ensureDaemon).toHaveBeenCalledTimes(1);
      expect(autoRun.ensureManagerRun).toHaveBeenCalledTimes(1);
    } finally { monitor.stop(); }
  });

  it('rejects a goal operation outside the current assignment without changing either goal', async () => {
    const outside = realpathSync(mkdtempSync(join(process.cwd(), '.tmp', 'outside-goal-execution-')));
    try {
      initializeGitFixture(outside, []);
      const outsideStore = new GoalStore(outside);
      await outsideStore.create(goalRecord());
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
      for (const name of names) {
        const result = await client.callTool({ name, arguments: {
          cwd: outside, goalId, ...(name === 'takt_abort_goal' ? { reason: '中止します' } : {}),
        } });
        expect(result.isError).toBe(true);
      }
      expect((await store.get(goalId)).executionStatus).toBe('active');
      expect((await outsideStore.get(goalId)).executionStatus).toBe('active');
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(autoRun.ensureManagerRun).not.toHaveBeenCalled();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

it('keeps the workspace assignment after removing the original repository in the same MCP session', async () => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = realpathSync(mkdtempSync(join(temporaryRoot, 'workspace-removal-')));
  const repositories = ['original', 'added'].map((name) => join(root, name));
  for (const repository of repositories) {
    mkdirSync(repository);
    initializeGitFixture(repository, []);
    mkdirSync(join(repository, '.takt'));
    writeFileSync(join(repository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  }
  const [original, added] = repositories as [string, string];
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: original });
  const client = new Client({ name: 'workspace-removal-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const add = await client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: added } });
    expect(add.isError, firstTextContent(add.content)).toBeUndefined();
    const store = new GoalStore(original);
    await store.create(goalRecord());
    const remove = () => client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: original } });
    expect((await remove()).isError).toBe(true);
    await store.update(goalId, (goal) => ({ ...goal, executionStatus: 'aborted' }));
    const removed = await remove();
    expect(removed.isError, firstTextContent(removed.content)).toBeUndefined();
    expect(JSON.parse(firstTextContent(removed.content)).workspace.repositoryDirectories).toEqual([added]);
    const rename = await client.callTool({ name: 'takt_rename_workspace', arguments: { name: '更新した担当' } });
    expect(rename.isError, firstTextContent(rename.content)).toBeUndefined();
    expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: added } })).isError).toBeUndefined();
    expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: original } })).isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    for (const repository of repositories) invalidateResolvedConfigCache(repository);
    rmSync(root, { recursive: true, force: true });
  }
});

const questionSchema = z.object({
  id: z.string().min(1), body: z.string(), status: z.enum(['pending', 'answered', 'withdrawn']),
  options: z.array(z.string()).optional(), recommendation: z.string().optional(),
  answer: z.object({ text: z.string(), source: z.literal('tui'), answeredAt: z.iso.datetime() }).optional(),
});
const askedQuestion = {
  body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV',
};

function expectAnswerSelectionGuidance(text: string, questionId: string): void {
  const guidance = text.split('\n').filter((line) => /Ctrl\+R|\^R/u.test(line));
  expect(guidance).toHaveLength(1);
  expect(guidance[0]).toMatch(/list|select|choose/iu);
  expect(guidance[0]).not.toContain(questionId);
}

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
  let session: ManagerServiceClient | undefined;
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
    vi.mocked(ensureDaemon).mockReset().mockResolvedValue(undefined);
    resetScenario();
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'manager-questions-')));
    const globalDirectory = join(cwd, '.takt', 'global-config');
    mkdirSync(globalDirectory, { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
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
    try { await session?.dispose(); }
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
    connection = await connectManagerMcp(cwd);
    const plan = createManagerConversationPlan(cwd, {});
    session = new ManagerServiceClient({ cwd,
      plan: { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } } });
    await session.ready;
    app = render(createElement(ManagerView, { cwd, lang: 'en', client: session, assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] }, initialDiagnostics: [], onExit: vi.fn() }));
    await vi.waitFor(() => expect(app!.lastFrame()?.replaceAll('\n', '')).toContain(basename(cwd)));
  }

  async function send(text: string): Promise<void> {
    app!.stdin.write(text);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(text));
    app!.stdin.write('\r');
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

  it('allows manager-selected work while a question remains pending', async () => {
    const question = await ask();
    expect((await enqueue('export')).isError).not.toBe(true);
    expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
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
    for (const value of [goalId.slice(0, 8), askedQuestion.body, 'CSV', 'JSON']) expect(requests[0]!.text).toContain(value);
    expect(requests[0]!.text.split('\n')[0]).toContain(basename(cwd));
    expectAnswerSelectionGuidance(requests[0]!.text, question.id);
    expect(requests[0]!.text).not.toContain(goalId);
    const displayed = await readManagerTestDisplay(cwd);
    expect(displayed.events).toEqual([]);
    expect(displayed.questions).toEqual([expect.objectContaining({ question: expect.objectContaining(question) })]);
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
    expectAnswerSelectionGuidance(requests[0]!.text, created.questionId);
    expect(requests[0]!.text).toContain(askedQuestion.body);
    expect((await invoke('takt_get_goal_question', { questionId: created.questionId })).question)
      .toMatchObject({ ...askedQuestion, id: created.questionId, status: 'pending' });
  }, 30_000);

  it.each([
    { kind: 'blocked' as const, language: 'ja' as const }, { kind: 'blocked' as const, language: 'en' as const },
    { kind: 'custom' as const, language: 'ja' as const }, { kind: 'custom' as const, language: 'en' as const },
  ])('sends $kind notifications with severity from the MCP tool to Slack and the $language TUI', async ({ kind, language }) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nlanguage: ${language}\nmanager:\n  auto_run: false\n`);
    invalidateResolvedConfigCache(cwd);
    const body = 'warning';
    await invoke('takt_notify_goal', { kind, body, severity: 'warning' });
    expect(requests).toHaveLength(1);
    const severity = language === 'ja' ? '重要度: 警告' : 'Severity: Warning';
    expect(requests[0]!.text.split('\n')).toContain(body);
    expect(requests[0]!.text.split('\n')[2]).toBe(severity);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.notifications).toEqual([expect.objectContaining({ kind, body, severity: 'warning' })]);
    const display = await readManagerTestDisplay(cwd, language);
    expect(display.events).toHaveLength(1);
    expect(display.events[0]!.message.split('\n')).toContain(body);
    expect(display.events[0]!.message.split('\n')[2]).toBe(severity);
  });

  it('persists question state for the inquiry menu without sending Slack when the webhook is unset', async () => {
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    const question = await ask();
    expect(question.status).toBe('pending');
    expect(requests).toEqual([]);
    const display = await readManagerTestDisplay(cwd);
    expect(display.events).toEqual([]);
    expect(display.questions).toEqual([expect.objectContaining({ question: expect.objectContaining(question) })]);
  });

  it.each(['HTTP error', 'connection error'] as const)('keeps the question usable and work running while reporting a Slack %s to stderr', async (failure) => {
    responseStatus = failure === 'HTTP error' ? 503 : 0;
    const stderr = vi.spyOn(process.stderr, 'write');
    const question = await ask();
    expect(question.status).toBe('pending');
    expect(requests).toHaveLength(1);
    expectAnswerSelectionGuidance(requests[0]!.text, question.id);
    expect(stderr).toHaveBeenCalledWith(failure === 'HTTP error'
      ? 'Slack webhook failed: HTTP 503\n' : 'Slack webhook connection failed\n');
    expect(stderr.mock.calls.flat().join('')).not.toContain(webhook);
    const display = await readManagerTestDisplay(cwd);
    expect(display.questions).toEqual([expect.objectContaining({ goalId, question: expect.objectContaining(question) })]);
    expect(display.events).toEqual([]);
    expect(JSON.stringify(display)).not.toContain(webhook);
    expect((await enqueue('export')).isError).not.toBe(true);
    expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
    await invoke('takt_withdraw_goal_question', { questionId: question.id });
    expect((await invoke('takt_get_goal_question', { questionId: question.id })).question).toMatchObject({ status: 'withdrawn' });
  });

  it('disables question notifications while retaining questions, manager-selected work and other notification kinds', async () => {
    configure('question');
    const question = await ask();
    expect(question.status).toBe('pending');
    expect(requests).toEqual([]);
    expect((await readManagerTestDisplay(cwd)).events).toEqual([]);
    expect((await enqueue('export')).isError).not.toBe(true);
    expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
    expect((await invoke('takt_get_goal_question', { questionId: question.id })).question).toMatchObject({ status: 'pending' });
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
    const blob = git(['hash-object', '-w', '--stdin'], 'validated output\n');
    const tree = git(['mktree'], `100644 blob ${blob}\toutput.txt\n`);
    const sha = git(['commit-tree', tree, '-p', branch, '-m', 'completed work fixture']);
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
      expect(await invoke('takt_merge_goal_task', { taskName: added.name, expectedSha: sha })).toMatchObject({ status: 'merged' });
    } else {
      git(['update-ref', `refs/heads/${branch}`, sha]);
      await invoke('takt_complete_goal', { expectedSha: sha, summary: '出力の検証が完了しました' });
    }
  }

  it.each(['progress', 'awaiting_merge', 'completed'] as const)('notifies Slack and the persisted TUI event after actual %s work', async (kind) => {
    configure(undefined, kind === 'completed' ? 'auto' : 'approve');
    await produce(kind);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain(goalId.slice(0, 8));
    expect(requests[0]!.text.split('\n')[0]).toContain(basename(cwd));
    expect(requests[0]!.text).not.toContain(goalId);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.notifications?.map((notification) => notification.kind)).toEqual([kind]);
    const display = await readManagerTestDisplay(cwd);
    expect(display.events).toHaveLength(kind === 'progress' ? 2 : 1);
    expect(display.events).toContainEqual({
      id: JSON.stringify([cwd, goalId, 'notification', saved.notifications![0]!.id]), message: requests[0]!.text,
    });
    if (kind === 'progress') {
      expect(saved.workLog).toHaveLength(1);
      expect(display.events[0]).toEqual({
        id: JSON.stringify([cwd, goalId, 'work-log', saved.workLog[0]!.id]), message: `${goalId}: ${saved.workLog[0]!.summary}`,
      });
      expect(requests[0]!.text).toContain('出力の検証');
    }
  });

  it.each(kinds)('disables only %s notification delivery while preserving the underlying operation', async (kind) => {
    configure(kind, kind === 'completed' ? 'auto' : 'approve');
    await produce(kind);
    expect(requests).toEqual([]);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.notifications).toBeUndefined();
    expect((await readManagerTestDisplay(cwd)).events).toEqual(kind === 'progress' ? [{
      id: JSON.stringify([cwd, goalId, 'work-log', saved.workLog[0]!.id]), message: `${goalId}: ${saved.workLog[0]!.summary}`,
    }] : []);
    const goal = (await invoke('takt_get_goal')).goal;
    if (kind === 'question') expect(goal).toMatchObject({ questions: [expect.objectContaining({ status: 'pending' })] });
    else if (kind === 'progress') {
      const taskSha = git(['rev-parse', 'takt/question-fixture-work']);
      expect(git(['merge-base', '--is-ancestor', taskSha, goalRecord().branch])).toBe('');
    }
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
    const saved = z.object({ items: z.array(z.object({ kind: z.string() })) }).parse(await invoke('takt_get_goal', { path: 'notifications' }));
    expect(saved.items.map((notification) => notification.kind)).toEqual(['awaiting_merge', 'completed']);
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
    expect((await readManagerTestDisplay(cwd)).events).toEqual([]);
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
    expect((await readManagerTestDisplay(cwd)).events).toEqual([]);
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
    expect(ensureDaemon).not.toHaveBeenCalled();
    let finishAutoRun!: () => void;
    const autoRunCompletion = new Promise<void>((resolve) => { finishAutoRun = resolve; });
    const ensureRun = vi.spyOn(autoRun, 'ensureManagerRun').mockImplementationOnce(() => autoRunCompletion);
    try {
      await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('Working'));
      app!.stdin.write('\x12');
      await vi.waitFor(() => {
        const lists = app!.lastFrame()?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
        expect(lists.some((box) => box.includes(question.body) && /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box))).toBe(true);
      });
      app!.stdin.write('\r');
      await vi.waitFor(() => expect(app!.lastFrame()).toContain('Enter your answer'));
      await send(answer);
      await vi.waitFor(async () => {
        expect((await invoke('takt_get_goal_question', { questionId: question.id })).question)
          .toMatchObject({ status: 'answered', answer: { text: answer, source: 'tui' } });
      }, { timeout: 30_000 });
      expect(ensureRun).toHaveBeenCalledExactlyOnceWith(cwd);
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(app!.lastFrame()).not.toContain('Answer saved');
      expect(readManagerEvents(cwd).map(({ event }) => event)).toEqual([expect.objectContaining({
        kind: 'answer', goalId, questionId: question.id, answer: { text: answer, source: 'tui', answeredAt: expect.any(String) },
      })]);
    } finally { finishAutoRun(); }
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('Answer saved'));
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

  it('shows new notifications in the same mounted TUI without replaying saved notifications on reopening', async () => {
    const first = ['保存済みの進捗', '保存済みの確認事項', '保存済みの次の作業', '保存済みの詳細末尾'];
    const second = ['新着の停止理由', '新着の確認事項', '新着の次の作業', '新着の詳細末尾'];
    const counts = getLabel('manager.counts', 'en', { goals: '1', questions: '0' }).replace(/\s+/gu, ' ');
    const project = basename(cwd);
    const customHeading = getLabel('manager.notificationHeadings.custom', 'en', { project });
    const blockedHeading = getLabel('manager.notificationHeadings.blocked', 'en', { project });
    const goalLine = getLabel('manager.notificationGoal', 'en', { objective: goalRecord().objective, id: goalId.slice(0, 8) });
    await invoke('takt_notify_goal', { kind: 'custom', body: first.join('\n'), severity: 'info' });
    const saved = await new GoalStore(cwd).get(goalId);
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(saved.notifications![0]!.recordedAt)));
    await mountManager();
    await vi.waitFor(() => {
      const frame = app!.lastFrame()!;
      expect(frame.replace(/\s+/gu, ' ')).toContain(counts);
      expect(frame).not.toContain('Working');
      for (const line of first) expect(frame).not.toContain(line);
      expect(frame).not.toContain(customHeading);
    });
    await invoke('takt_notify_goal', { kind: 'blocked', body: second.join('\n'), severity: 'warning' });
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '状況を確認しました', summary: null }) }]);
    await send('状況を教えてください');
    await vi.waitFor(() => {
      const frame = app!.lastFrame()!;
      const text = frame.replace(/\s+/gu, ' ');
      expect(text).toContain(blockedHeading);
      expect(text).toContain(goalLine);
      expect(text).toContain(getLabel('manager.notificationSeverity', 'en', {
        severity: getLabel('manager.notificationSeverities.warning', 'en'),
      }));
      for (const line of second.slice(0, 3)) expect(frame).toContain(line);
      expect(frame).not.toContain(second[3]);
      expect(text).toContain(getLabel('manager.notificationDigestHint', 'en'));
      expect(text).toContain(getLabel('manager.notificationBlockedAction', 'en', { project }));
      for (const line of first) expect(frame).not.toContain(line);
      expect(frame).not.toContain(customHeading);
      expect(frame).toContain('状況を確認しました');
      expect(frame).not.toContain('Working');
    }, { timeout: 10000 });
    app!.unmount();
    const options = session!.options;
    await session!.dispose();
    session = new ManagerServiceClient(options);
    await session.ready;
    app = render(createElement(ManagerView, { cwd, lang: 'en', client: session!, assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] }, initialDiagnostics: [], onExit: vi.fn() }));
    await vi.waitFor(() => {
      const frame = app!.lastFrame()!;
      expect(frame.replace(/\s+/gu, ' ')).toContain(counts);
      expect(frame).not.toContain('Working');
      for (const line of [...first, ...second]) expect(frame).not.toContain(line);
      expect(frame).not.toContain(customHeading);
      expect(frame).not.toContain(blockedHeading);
    });
  }, 30_000);
});
