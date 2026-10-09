import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), connect: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: () => true }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), mkdtemp: doubles.mkdtemp, writeFile: doubles.writeFile, rm: doubles.rm }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = doubles.connect; close = doubles.close; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); } } }));
import { connectManagerMcp, prepareManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';

describe('manager MCP public key resources', () => {
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
    const connection = await connectManagerMcp('/repository', 'PUBLIC KEY');
    expect(doubles.transport.mock.calls[0]![0].env).toMatchObject({ TAKT_NOTIFY_WEBHOOK: webhook });
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ env: { TAKT_NOTIFY_WEBHOOK: webhook } });
    await connection.dispose();
  });

  it('writes only the public key, limits the MCP tool set, and releases resources after use', async () => {
    const connection = await connectManagerMcp('/repository', 'PUBLIC KEY');
    expect(doubles.writeFile).toHaveBeenCalledExactlyOnceWith('/temporary/manager/confirmation-public.pem', 'PUBLIC KEY', { mode: 0o600 });
    expect(doubles.transport.mock.calls[0]![0]).toMatchObject({ cwd: '/repository', args: expect.arrayContaining(['--tool-set', 'manager', '--goal-confirmation-public-key', '/temporary/manager/confirmation-public.pem']) });
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ args: doubles.transport.mock.calls[0]![0].args });
    expect(doubles.rm).not.toHaveBeenCalled();
    await connection.dispose();
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    expect(doubles.rm).toHaveBeenCalledWith('/temporary/manager', { recursive: true, force: true });
  });
  it.each(['/isolated-global-config', undefined])('preserves the configured global directory for the actual MCP child: %s', async (configDir) => {
    vi.stubEnv('TAKT_CONFIG_DIR', configDir);
    const connection = await connectManagerMcp('/repository', 'PUBLIC KEY');
    const expected = { ...(configDir === undefined ? {} : { TAKT_CONFIG_DIR: configDir }) };
    expect(connection.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({ env: expected });
    expect(doubles.transport.mock.calls[0]![0].env).toEqual(expected);
    await connection.dispose();
  });
  it('prepares completion-turn MCP without creating a redundant host client and delegates its goal owner', async () => {
    const owners = { '550e8400-e29b-41d4-a716-446655440000': '550e8400-e29b-41d4-a716-446655440001' };
    const prepared = await prepareManagerMcp('PUBLIC KEY', owners);
    expect(prepared.servers[TAKT_MANAGER_MCP_SERVER_NAME]).toMatchObject({
      env: { TAKT_MANAGER_GOAL_OWNERS: JSON.stringify(owners) },
    });
    expect(doubles.connect).not.toHaveBeenCalled();
    await prepared.dispose();
    expect(doubles.rm).toHaveBeenCalledTimes(1);
  });

  it.each(['write', 'connect', 'close'] as const)('releases public key resources even when %s fails', async (stage) => {
    const failure = new Error('failed');
    if (stage === 'write') doubles.writeFile.mockRejectedValueOnce(failure);
    if (stage === 'connect') doubles.connect.mockRejectedValueOnce(failure);
    if (stage === 'close') {
      const connection = await connectManagerMcp('/repository', 'PUBLIC KEY');
      doubles.close.mockRejectedValueOnce(failure);
      await expect(connection.dispose()).rejects.toThrow('failed');
      expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    } else {
      await expect(connectManagerMcp('/repository', 'PUBLIC KEY')).rejects.toThrow('failed');
    }
    expect(doubles.rm).toHaveBeenCalledWith('/temporary/manager', { recursive: true, force: true });
  });
});
