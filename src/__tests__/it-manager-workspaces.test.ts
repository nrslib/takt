import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cleanup,render } from 'ink-testing-library';
import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { resolveAssignedProjectRoot,resolveCurrentManagerAssignment } from '../features/manager/assignment.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { connectManagerMcp,TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createWorkspaceManagerContext,resolveManagerStartup,type ManagerAssignment } from '../features/manager/startupResolution.js';
import { addManagerRepository,removeManagerRepository,renameManagerWorkspace } from '../features/manager/workspaceOperations.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { createWorkspace,findWorkspaceForRepository,readWorkspace,readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario,setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { goalInput,goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

describe('manager workspace storage and repository boundaries', () => {
  let root: string;
  let globalDirectory: string;
  let repositoryA: string;
  let repositoryB: string;
  let repositoryC: string;

  function repository(name: string): string {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
    execFileSync('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
    mkdirSync(join(directory, '.takt'));
    writeFileSync(join(directory, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\nmanager:\n  auto_run: false\n');
    return directory;
  }

  function single(): ManagerAssignment {
    return { kind: 'repository', repositoryDirectory: repositoryA, repositoryDirectories: [repositoryA] };
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-workspaces-')));
    globalDirectory = join(root, 'global');
    mkdirSync(globalDirectory);
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    repositoryA = repository('a'); repositoryB = repository('b'); repositoryC = repository('c');
  });
  afterEach(() => { cleanup(); resetScenario(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('creates a workspace on addition and resolves the same context from every member and subdirectory', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    expect(workspace).toBeDefined();
    const expected = createWorkspaceManagerContext(workspace!, globalDirectory);
    mkdirSync(join(repositoryB, 'src'));
    for (const cwd of [repositoryA, repositoryB, join(repositoryB, 'src')]) {
      expect(await resolveManagerStartup(cwd, globalDirectory)).toEqual({ kind: 'ready', context: expected });
    }
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    expect(JSON.parse(readFileSync(join(globalDirectory, 'workspaces', workspace!.id, 'workspace.json'), 'utf8'))).toEqual(workspace);
    expect(existsSync(join(globalDirectory, 'managers'))).toBe(false);
    expect(existsSync(join(globalDirectory, 'workspaces', 'registry.lock'))).toBe(false);
    expect(await resolveCurrentManagerAssignment(single(), globalDirectory)).toEqual(expected.assignment);
  });

  it('keeps unassigned repositories in single mode and offers workspaces outside repositories', async () => {
    expect(await readWorkspaceRegistry(globalDirectory)).toEqual([]);
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [] });
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '担当', repositoryDirectories: [repositoryA, repositoryB] });
    expect(await resolveManagerStartup(repositoryC, globalDirectory)).toEqual({ kind: 'ready', context: {
      cwd: repositoryC, assignment: { kind: 'repository', repositoryDirectory: repositoryC, repositoryDirectories: [repositoryC] },
    } });
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [workspace] });
  });

  it('normalizes subdirectories and aliases and rejects non-Git and already assigned additions without changing records', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    mkdirSync(join(repositoryB, 'src'));
    symlinkSync(repositoryB, join(root, 'alias'), 'dir');
    expect(await addManagerRepository(assignment, join(repositoryB, 'src'), globalDirectory)).toEqual(workspace);
    expect(await addManagerRepository(assignment, join(root, 'alias'), globalDirectory)).toEqual(workspace);
    await expect(addManagerRepository(assignment, root, globalDirectory)).rejects.toThrow();
    const other = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '別担当', repositoryDirectories: [repositoryC] });
    await expect(addManagerRepository(assignment, repositoryC, globalDirectory)).rejects.toThrow(other.id);
    await expect(createWorkspace({ globalConfigDirectory: globalDirectory, name: '重複', repositoryDirectories: [repositoryB] })).rejects.toThrow(workspace!.id);
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    expect(await findWorkspaceForRepository(globalDirectory, repositoryB)).toEqual(workspace);
  });

  it.each(['active', 'paused'] as const)('rejects removal with unfinished %s goals and permits it after abort', async (executionStatus) => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    const goal = await new GoalStore(repositoryB).create({ ...goalRecord(), executionStatus });
    await expect(removeManagerRepository(assignment, repositoryB, globalDirectory)).rejects.toThrow(goal.id);
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    await new GoalStore(repositoryB).update(goal.id, (current) => ({ ...current, executionStatus: 'aborted' }));
    expect((await removeManagerRepository(assignment, repositoryB, globalDirectory)).repositoryDirectories).toEqual([repositoryA]);
    expect(await findWorkspaceForRepository(globalDirectory, repositoryB)).toBeUndefined();
  });

  it('renames, removes the session base, permits an empty workspace, and rejects removal outside the assignment', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const identity = { kind: 'workspace' as const, workspaceId: workspace!.id };
    expect((await renameManagerWorkspace(await resolveCurrentManagerAssignment(identity, globalDirectory), '開発', globalDirectory)).name).toBe('開発');
    await expect(removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory)).rejects.toThrow();
    await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryA, globalDirectory);
    const empty = await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryB, globalDirectory);
    expect(empty.repositoryDirectories).toEqual([]);
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [empty] });
  });

  it('rejects assigned-parent nested repositories and symlinks to unassigned repositories', async () => {
    const nested = repository('a/nested');
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    symlinkSync(repositoryC, join(repositoryA, 'outside'), 'dir');
    for (const directory of [nested, repositoryC, join(repositoryA, 'outside')]) {
      await expect(resolveAssignedProjectRoot(directory, assignment)).rejects.toThrow();
    }
    expect(await resolveAssignedProjectRoot(repositoryB, assignment)).toBe(repositoryB);
  });

  it('checks every MCP operation against the current assignment, including nested repositories and later membership changes', async () => {
    const nested = repository('a/nested');
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: repositoryA,
      managerAssignment: { kind: 'workspace', workspaceId: workspace!.id } });
    const client = new Client({ name: 'workspace-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const goal = await new GoalStore(repositoryB).create(goalRecord());
      mkdirSync(join(repositoryB, 'src'));
      const result = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: join(repositoryB, 'src'), goalId: goal.id } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(firstTextContent(result.content)).goal.id).toBe(goal.id);
      for (const cwd of [repositoryC, nested]) {
        await new GoalStore(cwd).create({ ...goalRecord(), executionStatus: 'aborted' });
        const denied = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd, goalId: goal.id, summary: '担当外' } });
        expect(denied.isError).toBe(true);
        expect(firstTextContent(denied.content)).toContain('not assigned');
        expect((await new GoalStore(cwd).get(goal.id)).workLog).toEqual([]);
      }
      expect((await new GoalStore(repositoryB).get(goal.id)).workLog).toEqual([]);
      expect((await client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: repositoryC } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).not.toBe(true);
      const recorded = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: repositoryC, goalId: goal.id, summary: '担当内' } });
      expect(recorded.isError, firstTextContent(recorded.content)).not.toBe(true);
      expect((await new GoalStore(repositoryC).get(goal.id)).workLog).toEqual([expect.objectContaining({ summary: '担当内' })]);
      expect((await client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryC } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).toBe(true);
      expect((await client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryA } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryB } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('uses mock conversation output to approve a goal only in its chosen repository and rechecks assignment before registering', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const identity = { kind: 'workspace' as const, workspaceId: workspace!.id };
    const session = createManagerConversationSession({ cwd: repositoryA, assignment: identity,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } } });
    const reply = (repositoryDirectory: string | undefined) => setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({
      message: '確認', summary: { ...goalInput(), repositoryDirectory },
    }) }, { persona: 'manager', status: 'done', content: JSON.stringify({ message: '登録済み', summary: null }) }]);
    try {
      for (const target of [undefined, repositoryC, repository('a/nested')]) {
        reply(target);
        expect((await session.handleUserMessage({ text: '相談' })).kind).toBe('error');
        expect(session.getPendingSummary()).toBeNull();
      }
      reply(repositoryB);
      expect((await session.handleUserMessage({ text: '相談' })).kind).toBe('reply');
      expect(session.getPendingSummary()!.repositoryDirectory).toBe(repositoryB);
      const registered = await session.approveSummary(session.getPendingSummary()!.revision);
      expect(registered.kind).toBe('goal_registered');
      expect((await new GoalStore(repositoryA).list()).goals).toEqual([]);
      expect((await new GoalStore(repositoryB).list()).goals).toHaveLength(1);
      reply(repositoryC);
      await addManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory);
      await session.handleUserMessage({ text: '別の相談' });
      const pending = session.getPendingSummary()!;
      await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory);
      expect((await session.approveSummary(pending.revision)).kind).toBe('error');
      expect((await new GoalStore(repositoryC).list()).goals).toEqual([]);
    } finally { await session.close(); }
  });

  it.each([false, true])('retains the workspace when removing the original repository in the same turn=%s', async (sameTurn) => {
    const assignment = single();
    const mcp = await connectManagerMcp(repositoryA, assignment);
    const provider = new MockProvider();
    const originalSetup = provider.setup.bind(provider);
    vi.spyOn(provider, 'setup').mockImplementation((config) => {
      const agent = originalSetup(config);
      return { call: async (prompt, options) => {
        const response = await agent.call(prompt, options);
        if (prompt.endsWith('担当を追加')) {
          const workspace = (await readWorkspaceRegistry(globalDirectory)).find((workspace) => workspace.repositoryDirectories.includes(repositoryB));
          if (workspace !== undefined) options.onStream?.({ type: 'tool_result', data: {
            id: 'workspace-operation', isError: false, content: JSON.stringify({ workspace }),
          } });
        }
        return response;
      } };
    });
    const session = createManagerConversationSession({ cwd: repositoryA, assignment,
      plan: { ctx: { provider, providerType: 'mock', model: undefined, lang: 'ja', mcpServers: mcp.servers },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read', ...['takt_add_workspace_repository', 'takt_remove_workspace_repository', 'takt_list_goals'].map((tool) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${tool}`)] } } });
    const scenario = (tool: string, args: Record<string, unknown>, removeOriginal = false) => setMockScenario([{ persona: 'manager', status: 'done',
      content: JSON.stringify({ message: '担当を更新', summary: null }),
      streamEvents: [{ type: 'tool_use', tool, id: 'workspace-operation', input: args }],
      mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool, arguments: args },
        ...(removeOriginal ? [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryA } }] : [])],
    }]);
    try {
      mkdirSync(join(repositoryB, 'src'));
      scenario('takt_add_workspace_repository', { repositoryDirectory: sameTurn ? join(repositoryB, 'src') : repositoryB }, sameTurn);
      expect((await session.handleUserMessage({ text: '担当を追加' })).kind).toBe('reply');
      if (!sameTurn) {
        expect((await readWorkspaceRegistry(globalDirectory))[0]!.repositoryDirectories).toEqual([repositoryA, repositoryB]);
        scenario('takt_remove_workspace_repository', { repositoryDirectory: repositoryA });
        expect((await session.handleUserMessage({ text: '元の担当を削除' })).kind).toBe('reply');
      }
      expect((await readWorkspaceRegistry(globalDirectory))[0]!.repositoryDirectories).toEqual([repositoryB]);
      const workspace = (await readWorkspaceRegistry(globalDirectory))[0]!;
      expect(await session.getAssignment()).toEqual({ kind: 'workspace', workspaceId: workspace.id,
        name: workspace.name, repositoryDirectories: [repositoryB] });
      scenario('takt_list_goals', { cwd: repositoryB });
      expect((await session.handleUserMessage({ text: '現在の担当を確認' })).kind).toBe('reply');
    } finally { await session.close(); await mcp.dispose(); }
  });

  it('keeps the standalone assignment after failed additions of missing, non-Git and already assigned repositories', async () => {
    const other = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '別の担当', repositoryDirectories: [repositoryB] });
    const assignment = single();
    const mcp = await connectManagerMcp(repositoryA, assignment);
    const session = createManagerConversationSession({ cwd: repositoryA, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja', mcpServers: mcp.servers },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read', `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`] } } });
    try {
      for (const repositoryDirectory of [join(root, 'missing'), root, repositoryB]) {
        const result = await mcp.client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory } });
        expect(result.isError).toBe(true);
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '追加できません', summary: null }),
          streamEvents: [{ type: 'tool_use', tool: 'takt_add_workspace_repository', id: 'add-repository', input: { repositoryDirectory } }],
        }]);
        expect((await session.handleUserMessage({ text: '担当を追加' })).kind).toBe('reply');
        expect(await session.getAssignment()).toEqual(assignment);
        expect(await readWorkspaceRegistry(globalDirectory)).toEqual([other]);
      }
    } finally { await session.close(); await mcp.dispose(); }
  });

  it('shows the current workspace name and count and goals from all members in the TUI', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    const goal = await new GoalStore(repositoryB).create({ ...goalRecord(), executionStatus: 'paused' });
    const session = createManagerConversationSession({ cwd: repositoryA, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } } });
    const app = render(createElement(ManagerView, { cwd: repositoryA, assignment, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => { expect(app.lastFrame()).toContain(`${workspace!.name} (2)`); expect(app.lastFrame()).toContain(goal.id); });
      await renameManagerWorkspace(assignment, '新しい担当', globalDirectory);
      await addManagerRepository(assignment, repositoryC, globalDirectory);
      setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '担当を確認', summary: null }) }]);
      app.stdin.write('担当を確認');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('担当を確認'));
      app.stdin.write('\r');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('新しい担当 (3)'), { timeout: 30_000 });
    } finally { app.unmount(); await session.close(); }
  });

  it('transfers assignment to the real manager MCP child and restricts its operations', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const mcp = await connectManagerMcp(repositoryA, { kind: 'workspace', workspaceId: workspace!.id });
    try {
      expect((await mcp.client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryB } })).isError).not.toBe(true);
      expect((await mcp.client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).toBe(true);
      expect((await mcp.client.callTool({ name: 'takt_rename_workspace', arguments: { name: '担当変更' } })).isError).not.toBe(true);
      expect((await readWorkspace(globalDirectory, workspace!.id))!.name).toBe('担当変更');
    } finally { await mcp.dispose(); }
  });
});
