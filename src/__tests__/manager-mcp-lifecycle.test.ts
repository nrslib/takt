import { beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), connect: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: () => true }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), mkdtemp: doubles.mkdtemp, writeFile: doubles.writeFile, rm: doubles.rm }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = doubles.connect; close = doubles.close; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); } } }));
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';

describe('manager MCP public key resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.mkdtemp.mockResolvedValue('/temporary/manager');
    doubles.writeFile.mockResolvedValue(undefined);
    doubles.connect.mockResolvedValue(undefined);
    doubles.close.mockResolvedValue(undefined);
    doubles.transportClose.mockResolvedValue(undefined);
    doubles.rm.mockResolvedValue(undefined);
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
