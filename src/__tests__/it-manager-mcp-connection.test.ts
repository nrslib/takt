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
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { MANAGER_ASSIGNMENT_HEADER, withManagerAssignment } from '../features/manager/assignment.js';
import { readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
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
    const connection = await connectManagerMcp(cwd, undefined, undefined, { enableGoalExecutionTools: true });
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
    const connection = await connectManagerMcp(cwd, { kind: 'repository', repositoryDirectory: cwd }, undefined, { enableGoalExecutionTools: true });
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
    const connection = await connectManagerMcp(cwd, assignment, undefined, { enableGoalExecutionTools: true });
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
      permissionJudge: { resolution: { provider: 'mock', model: undefined, providerOptions: {} }, language: 'ja',
        systemPrompt: 'judge fixture', managerPersona: 'manager fixture', managerPolicy: 'policy fixture' },
    });
    try {
      const input = { prompt: '担当を追加', instruction: '担当を追加', assignment, sessionId: undefined,
        configDirectory: getGlobalConfigDir(), abortSignal: new AbortController().signal };
      const first = await executor.execute(input);
      expect(first.message).toBe('担当を更新しました');
      expect(await executor.execute({ ...input, assignment: first.assignment, prompt: '担当を確認', instruction: '担当を確認' }))
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
