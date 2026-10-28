import { realpathSync, statSync, type Stats } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspace, readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
import { MANAGER_ASSIGNMENT_ENV, MANAGER_ASSIGNMENT_HEADER } from '../features/manager/assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { withManagerReadScope } from '../features/manager/readScopeProvider.js';
import { classifyManagerToolPermission } from '../features/manager/toolPermissionClassifier.js';
import { managerReadScope, type ScopedReadRequest } from '../features/manager/readScope.js';
import type { Provider, ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  accessSync: vi.fn(), realpathSync: Object.assign(vi.fn(), { native: vi.fn() }), statSync: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()), realpath: vi.fn(),
}));
vi.mock('../infra/config/global/workspaceRegistry.js', () => ({ readWorkspace: vi.fn(), readWorkspaceRegistry: vi.fn() }));

describe('manager provider read assignment', () => {
  const response = { persona: 'manager', status: 'done' as const, content: '', timestamp: new Date(0) };
  const call = vi.fn<ProviderAgent['call']>();
  let provider: Provider;
  const workspaceId = '650e8400-e29b-41d4-a716-446655440001';
  function assignmentServer(rawAssignment: string): NonNullable<ProviderCallOptions['mcpServers']> {
    return { [TAKT_MANAGER_MCP_SERVER_NAME]: {
      type: 'stdio', command: 'fixture', env: { [MANAGER_ASSIGNMENT_ENV]: rawAssignment },
    } };
  }

  function httpAssignmentServer(header: string | undefined): NonNullable<ProviderCallOptions['mcpServers']> {
    return { [TAKT_MANAGER_MCP_SERVER_NAME]: {
      type: 'http', url: 'http://127.0.0.1:12345/',
      ...(header === undefined ? {} : { headers: { [MANAGER_ASSIGNMENT_HEADER]: header } }),
    } };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(realpathSync.native).mockImplementation((path) => String(path));
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as Stats);
    vi.mocked(readWorkspaceRegistry).mockResolvedValue([]);
    call.mockResolvedValue(response);
    provider = makeProvider({ setup: () => ({ call }) });
  });

  async function invoke(mcpServers?: ProviderCallOptions['mcpServers']) {
    const handler = vi.fn().mockResolvedValue({ decision: 'allow' });
    const abortSignal = new AbortController().signal;
    const original: ScopedReadRequest = { toolName: 'Read', toolInput: { file_path: 'public.txt' }, cwd: '/work/runtime', abortSignal };
    call.mockImplementationOnce(async (_prompt, options) => {
      await options.onToolPermissionDecision!(original);
      return response;
    });
    const wrapped = withManagerReadScope(provider, '/work/repo', '/config', ['.env']);
    expect(await wrapped.setup({ name: 'manager' }).call('prompt', {
      cwd: '/work/repo', model: 'fixture', sessionId: 'existing', onToolPermissionDecision: handler, mcpServers,
    })).toEqual(response);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ model: 'fixture', sessionId: 'existing' });
    expect(handler).toHaveBeenCalledOnce();
    const scoped = handler.mock.calls[0]![0] as ScopedReadRequest;
    expect(scoped).toMatchObject(original);
    expect(original[managerReadScope]).toBeUndefined();
    return scoped[managerReadScope];
  }

  it('uses the manager directory independently of runtime cwd and tool arguments', async () => {
    expect(await invoke()).toEqual({ repositoryDirectories: ['/work/repo'], sensitivePaths: ['.env'] });
  });

  it('transfers the full workspace assignment', async () => {
    vi.mocked(readWorkspaceRegistry).mockResolvedValue([{
      id: 'fixture-id', name: 'workspace', repositoryDirectories: ['/work/repo', '/work/second'],
    }]);
    expect(await invoke()).toEqual({ repositoryDirectories: ['/work/repo', '/work/second'], sensitivePaths: ['.env'] });
  });

  it('uses the explicit HTTP workspace instead of the workspace inferred from the manager directory', async () => {
    vi.mocked(readWorkspaceRegistry).mockResolvedValue([{
      id: 'other-workspace', name: 'inferred', repositoryDirectories: ['/work/repo', '/work/unassigned'],
    }]);
    vi.mocked(readWorkspace).mockResolvedValue({
      id: workspaceId, name: 'assigned', repositoryDirectories: ['/work/second', '/work/third'],
    });
    const header = Buffer.from(JSON.stringify({ kind: 'workspace', workspaceId }), 'utf8').toString('base64url');

    expect(await invoke(httpAssignmentServer(header))).toEqual({
      repositoryDirectories: ['/work/second', '/work/third'], sensitivePaths: ['.env'],
    });
    expect(readWorkspace).toHaveBeenCalledWith('/config', workspaceId);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['invalid encoding', '%%%'],
    ['decoding exception', 'fixture-encoded-assignment'],
    ['invalid JSON', Buffer.from('{', 'utf8').toString('base64url')],
    ['invalid assignment', Buffer.from('{"kind":"workspace","workspaceId":"invalid"}', 'utf8').toString('base64url')],
  ])('judges HTTP reads with %s instead of inferring a scope from cwd', async (condition, header) => {
    const decode = condition === 'decoding exception' ? vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('fixture decode failure');
    }) : undefined;
    let scope;
    try {
      scope = await invoke(httpAssignmentServer(header));
    } finally {
      decode?.mockRestore();
    }

    expect(scope).toBeUndefined();
    expect(classifyManagerToolPermission({
      toolName: 'Read', toolInput: { file_path: '/work/repo/public.txt' }, cwd: '/work/repo', [managerReadScope]: scope,
    } as ScopedReadRequest, 'ja', 'claude-sdk')).toEqual({ decision: 'judge' });
  });

  it.each(['explicit workspace', 'registry'] as const)(
    'uses current members after removal within the same agent call through %s', async (source) => {
      const workspace = { id: workspaceId, name: 'workspace', repositoryDirectories: ['/work/repo', '/work/second'] };
      vi.mocked(readWorkspace).mockResolvedValue(workspace);
      vi.mocked(readWorkspaceRegistry).mockResolvedValue([workspace]);
      const original: ScopedReadRequest = { toolName: 'Read', toolInput: { file_path: '/work/second/public.txt' }, cwd: '/work/repo' };
      const handler = vi.fn(async (request: ScopedReadRequest) => {
        const result = classifyManagerToolPermission(request, 'ja', 'claude-sdk');
        return result.decision === 'allow' ? { decision: 'allow' as const }
          : { decision: 'deny' as const, reason: 'requires judge' };
      });
      call.mockImplementationOnce(async (_prompt, options) => {
        const decide = options.onToolPermissionDecision!;
        expect(await decide(original)).toEqual({ decision: 'allow' });
        const updated = { ...workspace, repositoryDirectories: ['/work/repo'] };
        vi.mocked(readWorkspace).mockResolvedValue(updated);
        vi.mocked(readWorkspaceRegistry).mockResolvedValue([updated]);
        expect(await decide(original)).toEqual({ decision: 'deny', reason: 'requires judge' });
        return response;
      });
      const wrapped = withManagerReadScope(provider, '/work/repo', '/config', ['.env']);
      expect(await wrapped.setup({ name: 'manager' }).call('prompt', {
        cwd: '/work/repo', onToolPermissionDecision: handler,
        ...(source === 'explicit workspace' ? { mcpServers: assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })) } : {}),
      })).toEqual(response);
      expect(handler.mock.calls.map(([request]) => request[managerReadScope])).toEqual([
        { repositoryDirectories: ['/work/repo', '/work/second'], sensitivePaths: ['.env'] },
        { repositoryDirectories: ['/work/repo'], sensitivePaths: ['.env'] },
      ]);
      expect(original[managerReadScope]).toBeUndefined();
    },
  );

  it.each(['workspace', 'registry', 'realpath'] as const)(
    'does not reuse a previous scope after a %s failure in the same agent call', async (failure) => {
      const workspace = { id: workspaceId, name: 'workspace', repositoryDirectories: ['/work/repo'] };
      vi.mocked(readWorkspace).mockResolvedValue(workspace);
      const classifications: string[] = [];
      const handler = vi.fn(async (request: ScopedReadRequest) => {
        classifications.push(classifyManagerToolPermission(request, 'ja', 'claude-sdk').decision);
        return { decision: 'allow' as const };
      });
      call.mockImplementationOnce(async (_prompt, options) => {
        const decide = options.onToolPermissionDecision!;
        const request = { toolName: 'Read', toolInput: { file_path: '/work/repo/public.txt' }, cwd: '/work/repo' };
        await decide(request);
        const error = new Error('fixture scope resolution failure');
        if (failure === 'workspace') vi.mocked(readWorkspace).mockRejectedValue(error);
        else if (failure === 'registry') vi.mocked(readWorkspaceRegistry).mockRejectedValue(error);
        else vi.mocked(realpath).mockRejectedValue(error);
        await decide(request);
        return response;
      });
      const wrapped = withManagerReadScope(provider, '/work/repo', '/config', ['.env']);
      expect(await wrapped.setup({ name: 'manager' }).call('prompt', {
        cwd: '/work/repo', onToolPermissionDecision: handler,
        ...(failure === 'workspace' ? { mcpServers: assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })) } : {}),
      })).toEqual(response);
      expect(handler.mock.calls.map(([request]) => request[managerReadScope])).toEqual([
        { repositoryDirectories: ['/work/repo'], sensitivePaths: ['.env'] }, undefined,
      ]);
      expect(classifications).toEqual(['allow', 'judge']);
    },
  );

  it('waits for each asynchronous scope resolution before invoking the handler', async () => {
    const workspace = { id: workspaceId, name: 'workspace', repositoryDirectories: ['/work/repo'] };
    vi.mocked(readWorkspace).mockResolvedValue(workspace);
    const handler = vi.fn().mockResolvedValue({ decision: 'deny', reason: 'handler result' });
    call.mockImplementationOnce(async (_prompt, options) => {
      const decide = options.onToolPermissionDecision!;
      const request = { toolName: 'Read', toolInput: { file_path: 'public.txt' }, cwd: '/work/repo' };
      expect(await decide(request)).toEqual({ decision: 'deny', reason: 'handler result' });
      const updated = { ...workspace, repositoryDirectories: [] };
      let complete!: (value: typeof workspace) => void;
      const pending = new Promise<typeof workspace>((resolve) => { complete = resolve; });
      vi.mocked(readWorkspace).mockReturnValue(pending);
      const decision = decide(request);
      try {
        await Promise.resolve();
        expect(handler).toHaveBeenCalledOnce();
      } finally { complete(updated); }
      expect(await decision).toEqual({ decision: 'deny', reason: 'handler result' });
      return response;
    });
    const wrapped = withManagerReadScope(provider, '/work/repo', '/config', ['.env']);
    expect(await wrapped.setup({ name: 'manager' }).call('prompt', {
      cwd: '/work/repo', onToolPermissionDecision: handler,
      mcpServers: assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })),
    })).toEqual(response);
    expect(handler.mock.calls[1]![0][managerReadScope]).toEqual({ repositoryDirectories: [], sensitivePaths: ['.env'] });
  });

  it('does not fabricate a scope when registry resolution fails', async () => {
    vi.mocked(readWorkspaceRegistry).mockRejectedValue(new Error('fixture invalid registry'));
    expect(await invoke()).toBeUndefined();
  });

  it('uses the explicit workspace current members even after the manager directory is removed', async () => {
    vi.mocked(readWorkspace).mockResolvedValue({ id: workspaceId, name: 'workspace', repositoryDirectories: ['/work/second'] });
    expect(await invoke(assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })))).toEqual({
      repositoryDirectories: ['/work/second'], sensitivePaths: ['.env'],
    });
    expect(readWorkspace).toHaveBeenCalledWith('/config', workspaceId);
  });

  it('keeps an explicit workspace empty after its last repository is removed', async () => {
    vi.mocked(readWorkspace).mockResolvedValue({ id: workspaceId, name: 'workspace', repositoryDirectories: [] });
    expect(await invoke(assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })))).toEqual({
      repositoryDirectories: [], sensitivePaths: ['.env'],
    });
  });

  it('does not replace a missing explicit workspace with the manager directory', async () => {
    expect(await invoke(assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })))).toBeUndefined();
  });

  it('does not replace an unreadable explicit workspace with the manager directory', async () => {
    vi.mocked(readWorkspace).mockRejectedValue(new Error('fixture unreadable workspace'));
    expect(await invoke(assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId })))).toBeUndefined();
  });

  it.each(['{', 'null', '{"kind":"workspace"}', '{"kind":"workspace","workspaceId":"invalid"}'])(
    'does not resolve a scope from an invalid assignment: %s', async (rawAssignment) => {
      expect(await invoke(assignmentServer(rawAssignment))).toBeUndefined();
    },
  );

  it('preserves directory resolution for an explicit repository assignment', async () => {
    const repositoryDirectory = '/work/repo';
    expect(await invoke(assignmentServer(JSON.stringify({ kind: 'repository', repositoryDirectory })))).toEqual({
      repositoryDirectories: [repositoryDirectory], sensitivePaths: ['.env'],
    });
  });

  it('does not use another MCP server as the source of assignment', async () => {
    const server = assignmentServer(JSON.stringify({ kind: 'workspace', workspaceId }))[TAKT_MANAGER_MCP_SERVER_NAME]!;
    expect(await invoke({ unrelated: server })).toEqual({ repositoryDirectories: ['/work/repo'], sensitivePaths: ['.env'] });
  });

  it('keeps an empty workspace unassigned even when its base is reached through an alias', async () => {
    vi.mocked(readWorkspaceRegistry).mockResolvedValue([{
      id: 'fixture-id', name: 'workspace', repositoryDirectories: [],
    }]);
    vi.mocked(realpath).mockResolvedValue('/physical/workspace');
    expect(await invoke()).toEqual({ repositoryDirectories: [], sensitivePaths: ['.env'] });
  });

  it('preserves prototype methods and their original receiver', async () => {
    class PrototypeProvider {
      #instruction = 'private receiver';
      getRuntimeInstructions(): string { return this.#instruction; }
    }
    provider = Object.assign(new PrototypeProvider(), provider);
    delete (provider as Partial<Provider>).getRuntimeInstructions;
    const wrapped = withManagerReadScope(provider, '/work/repo', '/config', []);
    expect(wrapped.getRuntimeInstructions()).toBe('private receiver');
  });

  it('forwards a call without a decision handler without resolving assignment', async () => {
    const wrapped = withManagerReadScope(provider, '/work/repo', '/config', []);
    const options = { cwd: '/work/repo', sessionId: 'existing' };
    expect(await wrapped.setup({ name: 'manager' }).call('prompt', options)).toEqual(response);
    expect(call).toHaveBeenCalledWith('prompt', options);
    expect(readWorkspaceRegistry).not.toHaveBeenCalled();
  });
});
