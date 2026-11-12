import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTestManagerMcp } from './helpers/manager-mcp.js';
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { TurnToolScope } from '../features/daemonTurn/toolScope.js';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { MANAGER_ASSIGNMENT_HEADER, withManagerAssignment } from '../features/manager/assignment.js';
import { createWorkspace, readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
import {
  addEpicMember, createEpic, getEpic, listEpics, recordEpicVerificationResult, startEpicVerification,
} from '../infra/epics/index.js';
import { completedEpicGoal, epicDefinition, secondGoalId, verificationResultFor } from './helpers/epic-fixtures.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { makeProvider } from './test-helpers.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import type { ManagerAssignmentIdentity } from '../features/manager/assignment.js';

vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

describe('manager MCP connection confirmation', () => {
  const names = ['takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal'];
  let cwd: string;
  let store: GoalStore;
  beforeEach(async () => {
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'manager-mcp-担当-')));
    initializeGitFixture(cwd, []);
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
    execFileSync('git', ['branch', goalRecord().branch], { cwd, stdio: 'pipe' });
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    store = new GoalStore(cwd);
    await store.create(goalRecord());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateResolvedConfigCache(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  async function epicFixture() {
    const globalConfigDirectory = getGlobalConfigDir();
    const workspace = await createWorkspace({ globalConfigDirectory, name: '連携確認', repositoryDirectories: [cwd] });
    const owner = { globalConfigDirectory, workspaceId: workspace.id };
    const epic = await createEpic({ ...owner, ...epicDefinition(), reason: '連携確認を依頼する' });
    const context = { ...owner, epicId: epic.id };
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    await store.update(goalId, () => completedEpicGoal(sha, sha));
    const connection = await connectTestManagerMcp(cwd, { kind: 'workspace', workspaceId: workspace.id });
    const call = (name: string, args: Record<string, unknown> = {}) => connection.client.callTool({
      name, arguments: { cwd, ...(name === 'takt_list_epics' ? {} : { epicId: epic.id }),
        ...(['takt_get_epic', 'takt_list_epics', 'takt_get_epic_verification_recovery'].includes(name)
          ? {} : { reason: '人の指示で操作する' }), ...args },
    });
    const success = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await call(name, args);
      expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      return result;
    };
    return { owner, context, connection, call, success, member: { repositoryDirectory: cwd, goalId } };
  }

  it('exposes Epic operations on the manager connection and reloads a created definition', async () => {
    const f = await epicFixture();
    try {
      const names = (await f.connection.client.listTools()).tools.map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining([
        'takt_create_epic', 'takt_get_epic', 'takt_list_epics', 'takt_update_epic_definition',
        'takt_add_epic_member', 'takt_remove_epic_member', 'takt_replace_epic_member', 'takt_refresh_epic_targets',
        'takt_start_epic_verification', 'takt_record_epic_verification_result', 'takt_complete_epic',
        'takt_abort_epic', 'takt_get_epic_verification_recovery',
      ]));
      const created = await f.connection.client.callTool({ name: 'takt_create_epic', arguments: {
        cwd, ...epicDefinition(), objective: '別の連携確認', reason: '別の確認を依頼する',
      } });
      expect(created.isError, firstTextContent(created.content)).not.toBe(true);
      const epics = await listEpics(f.owner);
      expect(epics).toHaveLength(2);
      const saved = epics.find(({ id }) => id !== f.context.epicId)!;
      expect(saved).toMatchObject({ ...epicDefinition(), objective: '別の連携確認', status: 'active',
        workspaceId: f.owner.workspaceId, changes: [expect.objectContaining({ reason: '別の確認を依頼する' })] });
      for (const name of ['takt_get_epic', 'takt_list_epics']) {
        const result = await f.success(name, name === 'takt_get_epic' ? { epicId: saved.id } : {});
        expect(firstTextContent(result.content)).toContain(saved.id);
      }
    } finally { await f.connection.dispose(); }
  });

  it('pages Epic reads from storage while retaining global field paths and later-record failures', async () => {
    const f = await epicFixture();
    try {
      for (const objective of ['Second', 'Third']) await createEpic({ ...f.owner, ...epicDefinition(), objective, reason: 'Separate Epic' });
      const all = await listEpics(f.owner);
      for (const offset of [0, 1]) {
        const result = JSON.parse(firstTextContent((await f.success('takt_list_epics', { offset, limit: 1 })).content));
        expect(result).toMatchObject({ epics: [all[offset]], totalCount: 3, offset, returnedCount: 1, nextOffset: offset + 1 });
      }
      const field = JSON.parse(firstTextContent((await f.success('takt_list_epics', { offset: 0, limit: 1, path: '1.objective' })).content));
      expect(field).toMatchObject({ path: '1.objective', content: all[1]!.objective });
      expect(JSON.parse(firstTextContent((await f.success('takt_list_epics', { path: 'length' })).content)))
        .toMatchObject({ path: 'length', content: '3' });
      expect(JSON.parse(firstTextContent((await f.success('takt_list_epics', { offset: 3, limit: 1 })).content)))
        .toMatchObject({ epics: [], totalCount: 3, nextOffset: null });
      const outside = join(f.owner.globalConfigDirectory, 'workspaces', f.owner.workspaceId, 'epics', all[2]!.id, 'epic.json');
      writeFileSync(outside, '{');
      expect((await f.call('takt_list_epics', { offset: 0, limit: 1 })).isError).toBe(true);
    } finally { await f.connection.dispose(); }
  });

  it('records definition and member changes through MCP while preserving the completed goals', async () => {
    const f = await epicFixture();
    try {
      const original = await store.get(goalId);
      await store.create({ ...original, id: secondGoalId });
      const replacement = { repositoryDirectory: cwd, goalId: secondGoalId };
      await f.success('takt_update_epic_definition', { changes: { objective: '更新した連携目的' }, reason: '目的を改訂する' });
      await f.success('takt_add_epic_member', { member: f.member, reason: '最初の成果を追加する' });
      await f.success('takt_replace_epic_member', { member: f.member, replacement, reason: '修正成果へ置換する' });
      await f.success('takt_refresh_epic_targets', { reason: '取り込み後の対象を固定する' });
      expect(await getEpic(f.context)).toMatchObject({ objective: '更新した連携目的', members: [replacement],
        targets: [{ ...replacement, targetSha: original.completion!.targetSha }], changes: expect.arrayContaining([
          expect.objectContaining({ reason: '目的を改訂する' }),
          expect.objectContaining({ member: f.member, reason: '最初の成果を追加する' }),
          expect.objectContaining({ member: f.member, replacement, reason: '修正成果へ置換する' }),
        ]) });
      await f.success('takt_remove_epic_member', { member: replacement, reason: '対象を外す' });
      await f.success('takt_abort_epic', { reason: '連携確認を中止する' });
      expect(await getEpic(f.context)).toMatchObject({ status: 'aborted', members: [], changes: expect.arrayContaining([
        expect.objectContaining({ member: replacement, reason: '対象を外す' }),
        expect.objectContaining({ reason: '連携確認を中止する' }),
      ]) });
      expect(await store.get(goalId)).toEqual(original);
      expect(await store.get(secondGoalId)).toEqual({ ...original, id: secondGoalId });
    } finally { await f.connection.dispose(); }
  });

  it.each(['unassigned', 'missing', 'duplicate'] as const)('rejects an %s Epic member through MCP without changing successful evidence', async (invalid) => {
    const f = await epicFixture();
    try {
      await addEpicMember({ ...f.context, member: f.member, reason: '成果を追加する' });
      const run = await startEpicVerification(f.context);
      await recordEpicVerificationResult({ ...f.context, result: verificationResultFor(run) });
      const before = await getEpic(f.context);
      await f.success('takt_get_epic');
      const outside = join(cwd, 'outside');
      if (invalid === 'unassigned') {
        mkdirSync(outside);
        initializeGitFixture(outside, []);
        await new GoalStore(outside).create(goalRecord());
      }
      const member = invalid === 'unassigned' ? { ...f.member, repositoryDirectory: outside }
        : invalid === 'missing' ? { ...f.member, goalId: secondGoalId } : f.member;
      expect((await f.call('takt_add_epic_member', { member })).isError).toBe(true);
      expect(await getEpic(f.context)).toEqual(before);
    } finally { await f.connection.dispose(); }
  });

  it('rejects foreign workspace Epic reads and writes on the same manager connection', async () => {
    const f = await epicFixture();
    try {
      const other = await createWorkspace({ globalConfigDirectory: f.owner.globalConfigDirectory, name: '別担当', repositoryDirectories: [] });
      const foreignOwner = { ...f.owner, workspaceId: other.id };
      const foreign = await createEpic({ ...foreignOwner, ...epicDefinition(), reason: '別担当の確認' });
      const before = await getEpic({ ...foreignOwner, epicId: foreign.id });
      for (const name of ['takt_get_epic', 'takt_abort_epic']) {
        expect((await f.call(name, { workspaceId: other.id, epicId: foreign.id })).isError).toBe(true);
      }
      expect(await getEpic({ ...foreignOwner, epicId: foreign.id })).toEqual(before);
      const listed = await f.success('takt_list_epics');
      expect(firstTextContent(listed.content)).toContain(f.context.epicId);
      expect(firstTextContent(listed.content)).not.toContain(foreign.id);
    } finally { await f.connection.dispose(); }
  });

  it('rejects Epic abortion without a reason before changing the saved record', async () => {
    const f = await epicFixture();
    try {
      await f.success('takt_get_epic');
      const before = await getEpic(f.context);
      for (const reason of [undefined, '']) {
        expect((await f.call('takt_abort_epic', { reason })).isError).toBe(true);
        expect(await getEpic(f.context)).toEqual(before);
      }
    } finally { await f.connection.dispose(); }
  });

  it('preserves the original run when an old MCP result arrives after a definition change', async () => {
    const f = await epicFixture();
    try {
      await f.success('takt_add_epic_member', { member: f.member });
      await f.success('takt_start_epic_verification');
      const old = (await getEpic(f.context)).runningVerification!;
      expect(old).toBeDefined();
      const recovery = await f.success('takt_get_epic_verification_recovery');
      expect(firstTextContent(recovery.content)).toContain(old.id);
      await f.success('takt_update_epic_definition', { changes: { verificationProcedure: { version: 2, steps: ['改訂した確認'] } } });
      await f.success('takt_start_epic_verification');
      const current = (await getEpic(f.context)).runningVerification!;
      await f.success('takt_record_epic_verification_result', { result: verificationResultFor(old) });
      const saved = await getEpic(f.context);
      expect(saved).toMatchObject({ status: 'active', runningVerification: { id: current.id }, verificationRuns: expect.arrayContaining([
        expect.objectContaining({ id: old.id, revision: old.revision, status: 'stale' }),
      ]) });
      expect(saved.currentEvidence).toBeUndefined();
      expect((await f.call('takt_complete_epic')).isError).toBe(true);
      expect((await getEpic(f.context)).status).toBe('active');
    } finally { await f.connection.dispose(); }
  });

  it('keeps result registration separate from completion and applies repeated MCP calls once', async () => {
    const f = await epicFixture();
    try {
      await f.success('takt_add_epic_member', { member: f.member });
      const goalBefore = await store.get(goalId);
      const refsBefore = execFileSync('git', ['for-each-ref'], { cwd, encoding: 'utf8' });
      await f.success('takt_start_epic_verification');
      const run = (await getEpic(f.context)).runningVerification!;
      await f.success('takt_record_epic_verification_result', { result: verificationResultFor(run) });
      expect((await getEpic(f.context)).status).toBe('active');
      await f.success('takt_complete_epic');
      const completed = await getEpic(f.context);
      expect(completed.status).toBe('completed');
      for (const _attempt of [1, 2]) {
        await f.success('takt_record_epic_verification_result', { result: verificationResultFor(run) });
        await f.success('takt_complete_epic');
        await f.success('takt_get_epic');
      }
      expect(await getEpic(f.context)).toEqual(completed);
      expect(completed.verificationRuns).toHaveLength(1);
      expect(await store.get(goalId)).toEqual(goalBefore);
      expect(execFileSync('git', ['for-each-ref'], { cwd, encoding: 'utf8' })).toBe(refsBefore);
    } finally { await f.connection.dispose(); }
  });

  it('records every patrol entry as inspection and preserves ordinary work kinds on the same MCP connection', async () => {
    const turnScope = new TurnToolScope();
    let patrol = true;
    const connection = await connectManagerMcp(cwd, { kind: 'repository', repositoryDirectory: cwd }, undefined,
      { turnScope, conversationTurn: () => ({ patrol }) });
    try {
      for (const isPatrol of [true, false]) {
        patrol = isPatrol;
        turnScope.begin(new AbortController().signal);
        for (const kind of [undefined, 'patrol'] as const) {
          const result = await connection.client.callTool({ name: 'takt_record_goal_work_log', arguments: {
            cwd, goalId, summary: 'inspection details', ...(kind === undefined ? {} : { kind }),
          } });
          expect(result.isError).not.toBe(true);
        }
        await turnScope.end();
      }
      expect((await store.get(goalId)).workLog.map((entry) => entry.kind)).toEqual(['patrol', 'patrol', undefined, 'patrol']);
    } finally { await turnScope.end(); await connection.dispose(); }
  });

  const operations = [
    { name: 'takt_pause_goal', executionStatus: 'active', expected: 'paused' },
    { name: 'takt_resume_goal', executionStatus: 'paused', expected: 'active' },
    { name: 'takt_abort_goal', executionStatus: 'active', expected: 'aborted' },
  ] as const;
  const seedWork = async (executionStatus: 'active' | 'paused') => {
    await store.update(goalId, (goal) => ({ ...goal, executionStatus, questions: [{
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', kind: 'question',
      body: '出力形式を選んでください', status: 'pending',
    }] }));
    const runner = new TaskRunner(cwd);
    runner.addTask('未実行の作業', { workflow: 'default', worktree: false, goal_id: goalId,
      goal_purpose: '結果を確認する', branch: goalRecord().branch });
    saveManagerEvent(cwd, { kind: 'registered', goalId });
    return async () => ({ goal: await store.get(goalId), tasks: runner.listTaskStateItems(), events: readManagerEvents(cwd) });
  };

  it.each(operations)('executes $name over the owned HTTP server using the provider configuration', async ({ name, executionStatus, expected }) => {
    await store.update(goalId, (goal) => ({ ...goal, executionStatus }));
    const connection = await connectTestManagerMcp(cwd, undefined, undefined);
    const config = connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]!;
    if (config.type !== 'http') throw new Error('Expected HTTP manager configuration');
    const reader = new Client({ name: 'provider-manager-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await reader.connect(transport);
      expect((await reader.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
      const result = await reader.callTool({ name, arguments: { cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}) } });
      expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      expect((await store.get(goalId)).executionStatus).toBe(expected);
      await transport.terminateSession();
    } finally {
      try { await reader.close(); } finally { try { await transport.close(); } finally { await connection.dispose(); } }
    }
  });

  describe.each(['missing', 'incorrect'] as const)('authorization: %s', (authorization) => {
    it.each(operations)('rejects $name without changing saved work', async ({ name, executionStatus }) => {
      const snapshot = await seedWork(executionStatus);
      const before = await snapshot();
      const owner = await startManagerMcpConnection(cwd);
      const headers = { ...owner.config.headers };
      if (authorization === 'missing') delete headers.authorization;
      else headers.authorization = 'Bearer ' + '0'.repeat(64);
      try {
        const response = await fetch(owner.config.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name, arguments: { cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}) },
          } }) });
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).not.toContain(owner.config.headers!.authorization);
        expect(await snapshot()).toEqual(before);
      } finally { await owner.dispose(); }
    });
  });

  it.each(operations)('rejects $name on the same connection after owner invalidation and disposal', async ({ name, executionStatus }) => {
    const snapshot = await seedWork(executionStatus);
    const before = await snapshot();
    const owner = await startManagerMcpConnection(cwd);
    const reader = new Client({ name: 'disconnected-manager-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(owner.config.url), { requestInit: { headers: owner.config.headers } });
    try {
      await reader.connect(transport);
      expect((await reader.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
      owner.invalidate();
      const request = { name, arguments: { cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}) } };
      await expect(reader.callTool(request)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await owner.dispose();
      await expect(reader.callTool(request)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      try { await reader.close(); } finally { try { await transport.close(); } finally { await owner.dispose(); } }
    }
  });

  it('transfers UTF-8 assignments per connection, isolates connections, and restores the workspace on the next turn', async () => {
    const other = join(cwd, '担当B');
    mkdirSync(other);
    initializeGitFixture(other, []);
    const otherStore = new GoalStore(other);
    await otherStore.create(goalRecord());
    const connection = await connectTestManagerMcp(cwd, { kind: 'repository', repositoryDirectory: cwd }, undefined);
    const config = connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]!;
    if (config.type !== 'http') throw new Error('Expected HTTP manager configuration');
    const readers: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
    const open = async (current: typeof config) => {
      const client = new Client({ name: 'assignment-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(current.url), { requestInit: { headers: current.headers } });
      readers.push({ client, transport });
      await client.connect(transport);
      return client;
    };
    try {
      const reader = await open(config);
      const secondConfig = withManagerAssignment(config, { kind: 'repository', repositoryDirectory: other });
      if (secondConfig.type !== 'http') throw new Error('Expected HTTP manager configuration');
      expect(JSON.parse(Buffer.from(config.headers![MANAGER_ASSIGNMENT_HEADER]!, 'base64url').toString('utf8'))).toEqual({ kind: 'repository', repositoryDirectory: cwd });
      const second = await open(secondConfig);
      expect(readers[0]!.transport.sessionId).not.toBe(readers[1]!.transport.sessionId);
      expect((await reader.callTool({ name: 'takt_pause_goal', arguments: { cwd: other, goalId } })).isError).toBe(true);
      expect((await second.callTool({ name: 'takt_pause_goal', arguments: { cwd, goalId } })).isError).toBe(true);
      expect((await second.callTool({ name: 'takt_pause_goal', arguments: { cwd: other, goalId } })).isError).not.toBe(true);
      expect((await otherStore.get(goalId)).executionStatus).toBe('paused');
      const addition = await reader.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: other } });
      expect(addition.isError, firstTextContent(addition.content)).not.toBe(true);
      const workspace = (await readWorkspaceRegistry(getGlobalConfigDir()))[0]!;
      expect((await reader.callTool({ name: 'takt_resume_goal', arguments: { cwd: other, goalId } })).isError).not.toBe(true);
      const nextConfig = withManagerAssignment(config, { kind: 'workspace', workspaceId: workspace.id });
      if (nextConfig.type !== 'http') throw new Error('Expected HTTP manager configuration');
      const next = await open(nextConfig);
      expect((await next.callTool({ name: 'takt_pause_goal', arguments: { cwd: other, goalId } })).isError).not.toBe(true);
      expect((await otherStore.get(goalId)).executionStatus).toBe('paused');
      for (const { transport } of readers) await transport.terminateSession();
    } finally {
      try { for (const { client, transport } of readers) { try { await client.close(); } finally { await transport.close(); } } }
      finally { await connection.dispose(); invalidateResolvedConfigCache(other); }
    }
  });

  it('restores the assignment changed in the provider turn into the next turn HTTP configuration', async () => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd };
    const connection = await connectTestManagerMcp(cwd, assignment, undefined);
    const other = join(cwd, '担当B');
    mkdirSync(other); initializeGitFixture(other, []);
    const observed: ManagerAssignmentIdentity[] = [];
    const provider = makeProvider({ setup: () => ({ call: async (_prompt, options) => {
      const config = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME]!;
      if (config.type !== 'http') throw new Error('Expected HTTP manager configuration');
      observed.push(JSON.parse(Buffer.from(config.headers![MANAGER_ASSIGNMENT_HEADER]!, 'base64url').toString('utf8')));
      const reader = new Client({ name: 'provider-turn-assignment', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
      try {
        await reader.connect(transport);
        if (observed.length === 1) {
          const tool = 'takt_add_workspace_repository';
          options.onStream?.({ type: 'tool_use', data: { id: 'addition', tool, input: { repositoryDirectory: other } } });
          const result = await reader.callTool({ name: tool, arguments: { repositoryDirectory: other } });
          expect(result.isError, firstTextContent(result.content)).not.toBe(true);
          options.onStream?.({ type: 'tool_result', data: { id: 'addition', content: JSON.stringify(result.content), isError: false } });
        } else {
          expect((await reader.callTool({ name: 'takt_list_goals', arguments: { cwd: other } })).isError).not.toBe(true);
        }
        await transport.terminateSession();
      } finally { try { await reader.close(); } finally { await transport.close(); } }
      return { persona: 'manager', status: 'done', timestamp: new Date(), content: JSON.stringify({ message: '担当を更新しました', summary: null }) };
    } }) });
    const executor = createManagerTurnExecutor(cwd, {
      ctx: { provider, providerType: 'claude', lang: 'ja', model: undefined, mcpServers: connection.servers },
      strategy: { systemPrompt: 'manager fixture' },
    });
    try {
      const input = { prompt: '担当を追加', instruction: '担当を追加', assignment, sessionId: undefined,
        configDirectory: getGlobalConfigDir(), abortSignal: new AbortController().signal };
      const first = await executor.execute(input);
      expect(first.message).toBe('担当を更新しました');
      expect(await executor.execute({ ...input, assignment: first.assignment, prompt: '担当を確認' }))
        .toMatchObject({ message: '担当を更新しました' });
      const workspace = (await readWorkspaceRegistry(getGlobalConfigDir()))[0]!;
      expect(observed).toEqual([assignment, { kind: 'workspace', workspaceId: workspace.id }]);
    } finally { await connection.dispose(); invalidateResolvedConfigCache(other); }
  });

  describe.each([false, true])('standalone manager with caller endpoint: %s', (fakeEndpoint) => {
    it.each([
      { name: 'takt_pause_goal', executionStatus: 'active' },
      { name: 'takt_resume_goal', executionStatus: 'paused' },
      { name: 'takt_abort_goal', executionStatus: 'active' },
    ] as const)('rejects $name from the standalone manager entrypoint without changing saved work', async ({ name, executionStatus }) => {
      const question = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
        kind: 'question' as const, body: '出力形式を選んでください', status: 'pending' as const };
      await store.update(goalId, (goal) => ({ ...goal, executionStatus, questions: [question] }));
      const runner = new TaskRunner(cwd);
      runner.addTask('未実行の作業', { workflow: 'default', worktree: false, goal_id: goalId,
        goal_purpose: '結果を確認する', branch: goalRecord().branch });
      saveManagerEvent(cwd, { kind: 'registered', goalId });
      const before = { goal: await store.get(goalId), tasks: runner.listTaskStateItems(), events: readManagerEvents(cwd) };
      const reader = new Client({ name: 'standalone-manager-test', version: '1' });
      const fake = createServer((req, res) => { req.resume(); res.writeHead(204); res.end(); });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      const address = fake.address();
      if (address === null || typeof address === 'string') throw new Error('Missing fake endpoint address');
      const transport = new StdioClientTransport({ command: process.execPath,
        args: ['--import', createRequire(import.meta.url).resolve('tsx/esm'),
          fileURLToPath(new URL('../app/mcp/manager.ts', import.meta.url)), '--tool-set', 'manager'],
        env: { TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR!, ...(fakeEndpoint ? {
          TAKT_MANAGER_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/`, TAKT_MANAGER_MCP_TOKEN: 'a'.repeat(64),
        } : {}) }, cwd, stderr: 'pipe' });
      try {
        await reader.connect(transport);
        const tools = (await reader.listTools()).tools.map(({ name }) => name);
        expect(tools).toContain('takt_list_goals');
        const result = await reader.callTool({ name, arguments: {
          cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}),
        } });
        const after = { goal: await store.get(goalId), tasks: runner.listTaskStateItems(), events: readManagerEvents(cwd) };
        for (const operation of names) expect(tools).not.toContain(operation);
        expect(result.isError).toBe(true);
        expect(after).toEqual(before);
      } finally { try { await reader.close(); } finally { try { await transport.close(); } finally {
        fake.closeAllConnections();
        await new Promise<void>((resolve, reject) => fake.close((error) => error ? reject(error) : resolve()));
      } } }
    }, 30_000);
  });

});
