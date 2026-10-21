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
import { createTaktMcpServer,type TaktMcpServerOptions } from '../features/mcp/server.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { createWorkspace,findWorkspaceForRepository,readWorkspace,readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario,setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { goalInput,goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

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

  async function withClient(options: TaktMcpServerOptions, action: (client: Client) => Promise<void>): Promise<void> {
    const server = createTaktMcpServer({}, { allowedProjectRoot: repositoryA, toolSet: 'manager', ...options });
    const client = new Client({ name: 'workspace-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try { await action(client); }
    finally { await client.close(); await server.close(); }
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    return JSON.parse(firstTextContent(result.content));
  }

  function workspaceRepositories(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
      const directory = join(root, 'repositories', 'r'.repeat(180), 's'.repeat(180), `開発-${index}-${'作業'.repeat(30)}`);
      mkdirSync(directory, { recursive: true });
      execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
      return directory;
    });
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-workspaces-')));
    globalDirectory = join(root, 'global');
    mkdirSync(globalDirectory);
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    repositoryA = repository('a'); repositoryB = repository('b'); repositoryC = repository('c');
  });
  afterEach(() => { cleanup(); resetScenario(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('retrieves every saved repository after bounded add, remove and rename responses without repeating the mutation', async () => {
    const directories = [repositoryA, ...workspaceRepositories(110)];
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: directories });
    expect(Buffer.byteLength(JSON.stringify({ workspace }))).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const operations = [
        { name: 'takt_add_workspace_repository', args: { repositoryDirectory: repositoryB } },
        { name: 'takt_remove_workspace_repository', args: { repositoryDirectory: repositoryA } },
        { name: 'takt_rename_workspace', args: { name: '開発担当更新' } },
      ];
      for (const operation of operations) {
        const output = (await call(client, operation.name, operation.args)).workspace;
        const saved = (await readWorkspace(globalDirectory, workspace.id))!;
        expect(Buffer.byteLength(JSON.stringify({ workspace: saved }))).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
        expect(output).toMatchObject({ id: saved.id, name: saved.name, totalCount: saved.repositoryDirectories.length,
          returnedCount: output.repositoryDirectories.length, omittedCount: saved.repositoryDirectories.length - output.repositoryDirectories.length,
          offset: 0, nextOffset: output.repositoryDirectories.length, truncated: true });
        const members: string[] = [...output.repositoryDirectories];
        let offset = output.nextOffset;
        while (offset !== null) {
          const page = (await call(client, 'takt_list_tasks', { cwd: repositoryA, view: 'workspace', offset, limit: 50 })).workspace;
          expect(page).toMatchObject({ offset, returnedCount: page.repositoryDirectories.length,
            omittedCount: saved.repositoryDirectories.length - page.repositoryDirectories.length });
          expect(page.nextOffset).toBe(offset + page.returnedCount < page.totalCount ? offset + page.returnedCount : null);
          members.push(...page.repositoryDirectories);
          offset = page.nextOffset;
        }
        expect(members).toEqual(saved.repositoryDirectories);
        expect(await readWorkspace(globalDirectory, workspace.id)).toEqual(saved);
      }
    });
  });

  it('pages 51 repositories and retrieves UTF-8 name and saved repository strings', async () => {
    const directories = [repositoryA, ...workspaceRepositories(50)];
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: directories });
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const { tools } = await client.listTools();
      for (const name of ['takt_add_workspace_repository', 'takt_remove_workspace_repository', 'takt_rename_workspace', 'takt_list_tasks']) {
        const description = tools.find((tool) => tool.name === name)!.description;
        for (const selector of ['64 KiB', 'truncation', 'takt_list_tasks view workspace', 'offset/limit', 'path name or repositoryDirectories.N', 'textOffset/maxBytes']) {
          expect(description, name).toContain(selector);
        }
      }
      const read = (args: Record<string, unknown>) => call(client, 'takt_list_tasks', { cwd: repositoryA, view: 'workspace', ...args });
      expect((await read({ limit: 1 })).workspace).toMatchObject({ totalCount: 51, returnedCount: 1, omittedCount: 50, nextOffset: 1 });
      const first = (await read({ limit: 50 })).workspace;
      const last = (await read({ offset: first.nextOffset, limit: 50 })).workspace;
      expect(first).toMatchObject({ returnedCount: 50, nextOffset: 50 });
      expect(last).toMatchObject({ returnedCount: 1, nextOffset: null });
      expect([...first.repositoryDirectories, ...last.repositoryDirectories]).toEqual(directories);
      for (const args of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { cwd: 'relative' }, { path: 'id' }]) {
        expect((await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace', ...args } })).isError).toBe(true);
      }
      expect((await read({ path: 'name' }))).toMatchObject({ content: workspace.name, truncated: false, nextOffset: null });
      for (const [path, original, maxBytes] of [
        ['name', workspace.name, 4], ['repositoryDirectories.50', directories[50]!, 64],
      ] as const) {
        let text = '';
        let textOffset = 0;
        for (;;) {
          const page = await read({ path, textOffset, maxBytes });
          expect(page).toMatchObject({ workspaceId: workspace.id, path, offset: textOffset, totalBytes: Buffer.byteLength(original),
            returnedBytes: Buffer.byteLength(page.content) });
          expect(page.returnedBytes).toBeLessThanOrEqual(maxBytes);
          text += page.content;
          if (page.nextOffset === null) break;
          expect(page.truncated).toBe(true);
          expect(page.nextOffset).toBe(textOffset + page.returnedBytes);
          textOffset = page.nextOffset;
        }
        expect(text).toBe(original);
      }
      const longName = '開発担当'.repeat(6000);
      const renamed = await call(client, 'takt_rename_workspace', { name: longName });
      expect(renamed.truncated).toBe(true);
      expect(renamed.omissions).toContainEqual(expect.objectContaining({ path: 'workspace.name', totalBytes: Buffer.byteLength(longName),
        returnedBytes: Buffer.byteLength(renamed.workspace.name) }));
      let restored = '';
      let textOffset = 0;
      for (;;) {
        const page = await read({ path: 'name', textOffset });
        restored += page.content;
        if (page.nextOffset === null) break;
        textOffset = page.nextOffset;
      }
      expect(restored).toBe(longName);
      expect((await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace', path: 'repositoryDirectories.51' } })).isError).toBe(true);
    });
  });

  it('keeps the created workspace identity after removing the session base and reads an empty workspace without launching work', async () => {
    await withClient({}, async (client) => {
      const workspace = (await call(client, 'takt_add_workspace_repository', { repositoryDirectory: repositoryB })).workspace;
      expect(workspace.repositoryDirectories).toEqual([repositoryA, repositoryB]);
      await call(client, 'takt_remove_workspace_repository', { repositoryDirectory: repositoryA });
      const read = () => call(client, 'takt_list_tasks', { cwd: join(root, 'missing'), view: 'workspace' });
      expect((await read()).workspace).toMatchObject({ id: workspace.id, repositoryDirectories: [repositoryB] });
      await call(client, 'takt_remove_workspace_repository', { repositoryDirectory: repositoryB });
      const saved = readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8');
      vi.mocked(ensureManagerRun).mockClear();
      expect((await read()).workspace).toMatchObject({ id: workspace.id, repositoryDirectories: [],
        totalCount: 0, returnedCount: 0, omittedCount: 0, offset: 0, nextOffset: null, truncated: false });
      expect(ensureManagerRun).not.toHaveBeenCalled();
      expect(readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8')).toBe(saved);
      expect(existsSync(join(repositoryA, '.takt', 'tasks.yaml'))).toBe(false);
    });
  });

  it.each(['read-only', 'all'] as const)('rejects workspace reads for %s without exposing assigned data', async (toolSet) => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: [repositoryA] });
    await withClient({ toolSet, managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const result = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(firstTextContent(result.content)).toMatch(/only available to managers/);
      expect((await call(client, 'takt_list_tasks', { cwd: repositoryA })).tasks).toEqual([]);
    });
  });

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
        strategy: { systemPrompt: 'manager fixture' } } });
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
        strategy: { systemPrompt: 'manager fixture' } } });
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
        strategy: { systemPrompt: 'manager fixture' } } });
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
        strategy: { systemPrompt: 'manager fixture' } } });
    const app = render(createElement(ManagerView, { cwd: repositoryA, assignment, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain(`${workspace!.name} (2)`);
        expect(app.lastFrame()).toContain(goal.objective);
        expect(app.lastFrame()).toContain('一時停止');
      });
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
