import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { connectManagerMcp,TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
const doubles = vi.hoisted(() => ({ mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), connect: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: () => true }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), mkdtemp: doubles.mkdtemp, writeFile: doubles.writeFile, rm: doubles.rm }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = doubles.connect; close = doubles.close; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); } } }));

describe('manager MCP resources', () => {
  it('preserves user MCP servers and gives its own definition priority on a name collision', async () => {
    const userServers = {
      browser: { command: '/browser-mcp' },
      [TAKT_MANAGER_MCP_SERVER_NAME]: { command: '/conflicting-user-mcp' },
    };
    const connection = await connectManagerMcp('/repository', undefined, userServers);
    try {
      expect(Object.keys(connection.servers).sort()).toEqual(['browser', TAKT_MANAGER_MCP_SERVER_NAME].sort());
      expect(connection.servers.browser).toEqual(userServers.browser);
      expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({
        command: process.execPath, args: expect.arrayContaining(['--tool-set', 'manager']),
      });
      expect(doubles.transport).toHaveBeenCalledWith(expect.objectContaining({ command: process.execPath }));
      expect(userServers[TAKT_MANAGER_MCP_SERVER_NAME].command).toBe('/conflicting-user-mcp');
    } finally { await connection.dispose(); }
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    doubles.mkdtemp.mockResolvedValue('/temporary/manager');
    doubles.writeFile.mockResolvedValue(undefined);
    doubles.connect.mockResolvedValue(undefined);
    doubles.close.mockResolvedValue(undefined);
    doubles.transportClose.mockResolvedValue(undefined);
    doubles.rm.mockResolvedValue(undefined);
  });

  it('explicitly transfers the webhook to both the host transport and provider MCP configuration', async () => {
    const webhook = 'https://example.test/manager-webhook';
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', webhook);
    const connection = await connectManagerMcp('/repository');
    expect(doubles.transport.mock.calls[0]![0].env).toMatchObject({ TAKT_NOTIFY_WEBHOOK: webhook });
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ env: { TAKT_NOTIFY_WEBHOOK: webhook } });
    await connection.dispose();
  });

  it('limits the MCP tool set without writing a key and closes both client and transport', async () => {
    const connection = await connectManagerMcp('/repository');
    expect(doubles.writeFile).not.toHaveBeenCalled();
    expect(doubles.transport.mock.calls[0]![0]).toMatchObject({ cwd: '/repository', args: expect.arrayContaining(['--tool-set', 'manager']) });
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ args: doubles.transport.mock.calls[0]![0].args });
    expect(doubles.rm).not.toHaveBeenCalled();
    await connection.dispose();
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    expect(doubles.rm).not.toHaveBeenCalled();
  });
  it.each(['/isolated-global-config', undefined])('preserves the configured global directory for the actual MCP child: %s', async (configDir) => {
    vi.stubEnv('TAKT_CONFIG_DIR', configDir);
    const connection = await connectManagerMcp('/repository');
    const expected = { ...(configDir === undefined ? {} : { TAKT_CONFIG_DIR: configDir }) };
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ env: expected });
    expect(doubles.transport.mock.calls[0]![0].env).toEqual(expected);
    await connection.dispose();
  });
  it.each(['connect', 'close'] as const)('closes MCP resources even when %s fails', async (stage) => {
    const failure = new Error('failed');
    if (stage === 'connect') doubles.connect.mockRejectedValueOnce(failure);
    if (stage === 'close') {
      const connection = await connectManagerMcp('/repository');
      doubles.close.mockRejectedValueOnce(failure);
      await expect(connection.dispose()).rejects.toThrow('failed');
      expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    } else {
      await expect(connectManagerMcp('/repository')).rejects.toThrow('failed');
    }
    expect(doubles.rm).not.toHaveBeenCalled();
  });
});
