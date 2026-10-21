import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { MANAGER_ASSIGNMENT_HEADER, withManagerAssignment } from '../features/manager/assignment.js';

const doubles = vi.hoisted(() => ({
  connect: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn(), httpTransport: vi.fn(),
  exists: vi.fn(), client: vi.fn(), startOwner: vi.fn(), closeOwner: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: doubles.exists }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = doubles.connect; close = doubles.close; constructor() { doubles.client(); }
} }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {
  close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); }
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {
  close = doubles.transportClose; constructor(url: URL, options: unknown) { doubles.httpTransport(url, options); }
} }));
vi.mock('../features/manager/managerMcpConnection.js', async (original) => ({
  ...await original<typeof import('../features/manager/managerMcpConnection.js')>(), startManagerMcpConnection: doubles.startOwner,
}));

describe('manager MCP resources', () => {
  const config = { type: 'http' as const, url: 'http://127.0.0.1:12345/', headers: {
    authorization: 'Bearer fixture',
    [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify({ kind: 'repository', repositoryDirectory: '/repository' })).toString('base64url'),
  } };
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.exists.mockReturnValue(true);
    doubles.startOwner.mockResolvedValue({ config, invalidate: doubles.invalidate, dispose: doubles.closeOwner });
    doubles.connect.mockResolvedValue(undefined);
    doubles.close.mockResolvedValue(undefined);
    doubles.transportClose.mockResolvedValue(undefined);
    doubles.closeOwner.mockResolvedValue(undefined);
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('shares the owned HTTP address and headers between the internal client and provider', async () => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: '/repository' };
    const connection = await connectManagerMcp('/repository', assignment, undefined, { enableGoalExecutionTools: true });
    expect(doubles.startOwner).toHaveBeenCalledWith('/repository', assignment);
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toEqual(config);
    expect(doubles.httpTransport).toHaveBeenCalledWith(new URL(config.url), { requestInit: { headers: config.headers } });
    expect(doubles.transport).not.toHaveBeenCalled();
    await connection.dispose();
    expect(doubles.invalidate.mock.invocationCallOrder[0]).toBeLessThan(doubles.close.mock.invocationCallOrder[0]!);
    expect(doubles.closeOwner).toHaveBeenCalledOnce();
  });

  it('preserves user MCP servers and gives its own definition priority on a name collision', async () => {
    const userServers = { browser: { type: 'http' as const, url: 'https://example.test/mcp' },
      [TAKT_MANAGER_MCP_SERVER_NAME]: { command: '/conflicting-user-mcp' } };
    const connection = await connectManagerMcp('/repository', undefined, userServers, { enableGoalExecutionTools: true });
    expect(connection.servers.browser).toEqual(userServers.browser);
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toEqual(config);
    expect(userServers[TAKT_MANAGER_MCP_SERVER_NAME].command).toBe('/conflicting-user-mcp');
    await connection.dispose();
  });

  it('keeps third-party HTTP configuration free of manager assignment and credentials', () => {
    const thirdParty = { type: 'http' as const, url: 'https://example.test/mcp', headers: { authorization: 'Bearer external' } };
    const updated = withManagerAssignment(thirdParty, { kind: 'repository', repositoryDirectory: '/work/担当A' });
    expect(updated).toEqual(thirdParty);
    expect(updated).not.toHaveProperty(`headers.${MANAGER_ASSIGNMENT_HEADER}`);
  });

  it.each([undefined, false])('keeps the existing stdio launch when goal execution is disabled: %s', async (enableGoalExecutionTools) => {
    const connection = await connectManagerMcp('/repository', undefined, undefined,
      enableGoalExecutionTools === undefined ? undefined : { enableGoalExecutionTools });
    const transport = doubles.transport.mock.calls[0]![0];
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ command: transport.command, args: transport.args, env: transport.env });
    expect(transport).toMatchObject({ cwd: '/repository', args: expect.arrayContaining(['--tool-set', 'manager']) });
    expect(doubles.startOwner).not.toHaveBeenCalled();
    await connection.dispose();
    expect(doubles.close).toHaveBeenCalledOnce();
    expect(doubles.transportClose).toHaveBeenCalledOnce();
  });

  it.each(['/isolated-global-config', undefined])('preserves global config and webhook for the stdio child: %s', async (configDir) => {
    vi.stubEnv('TAKT_CONFIG_DIR', configDir);
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', 'https://example.test/webhook');
    const connection = await connectManagerMcp('/repository');
    const expected = { ...(configDir === undefined ? {} : { TAKT_CONFIG_DIR: configDir }), TAKT_NOTIFY_WEBHOOK: 'https://example.test/webhook' };
    expect(doubles.transport.mock.calls[0]![0].env).toEqual(expected);
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ env: expected });
    await connection.dispose();
  });

  it.each(['client', 'transport', 'connect'] as const)('releases the HTTP owner when %s fails during startup', async (stage) => {
    const failure = new Error('startup failed');
    if (stage === 'client') doubles.client.mockImplementationOnce(() => { throw failure; });
    if (stage === 'transport') doubles.httpTransport.mockImplementationOnce(() => { throw failure; });
    if (stage === 'connect') doubles.connect.mockRejectedValueOnce(failure);
    await expect(connectManagerMcp('/repository', undefined, undefined, { enableGoalExecutionTools: true })).rejects.toBe(failure);
    expect(doubles.invalidate).toHaveBeenCalledOnce();
    expect(doubles.closeOwner).toHaveBeenCalledOnce();
    expect(doubles.close).toHaveBeenCalledTimes(stage === 'client' ? 0 : 1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(stage === 'connect' ? 1 : 0);
  });

  it('releases the stdio client when launch preparation fails', async () => {
    const failure = new Error('prepare failed');
    doubles.exists.mockImplementationOnce(() => { throw failure; });
    await expect(connectManagerMcp('/repository')).rejects.toBe(failure);
    expect(doubles.close).toHaveBeenCalledOnce();
    expect(doubles.transport).not.toHaveBeenCalled();
  });

  it.each(['close', 'transportClose', 'closeOwner'] as const)('attempts all cleanup when %s fails', async (stage) => {
    const connection = await connectManagerMcp('/repository', undefined, undefined, { enableGoalExecutionTools: true });
    const failure = new Error('close failed');
    doubles[stage].mockRejectedValueOnce(failure);
    await expect(connection.dispose()).rejects.toBe(failure);
    expect(doubles.close).toHaveBeenCalledOnce();
    expect(doubles.transportClose).toHaveBeenCalledOnce();
    expect(doubles.closeOwner).toHaveBeenCalledOnce();
  });

  it('reports startup and cleanup failures after attempting every resource close', async () => {
    const startup = new Error('startup failed');
    const cleanup = new Error('client close failed');
    doubles.connect.mockRejectedValueOnce(startup);
    doubles.close.mockRejectedValueOnce(cleanup);
    await expect(connectManagerMcp('/repository', undefined, undefined, { enableGoalExecutionTools: true })).rejects.toMatchObject({ errors: [startup, cleanup] });
    expect(doubles.transportClose).toHaveBeenCalledOnce();
    expect(doubles.closeOwner).toHaveBeenCalledOnce();
  });
});
