import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTaktMcpServerToStdio } from '../app/mcp/index.js';
import { confirmationKeys } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ read: vi.fn(), server: vi.fn(), connect: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: doubles.read }));
vi.mock('../app/mcp/server.js', () => ({ createTaktMcpServer: doubles.server }));
vi.mock('../shared/utils/entrypoint.js', () => ({ isDirectEntrypoint: () => false }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

describe('Goal confirmation startup configuration', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.server.mockReturnValue({ connect: doubles.connect });
    doubles.connect.mockResolvedValue(undefined);
    process.argv = ['node', 'takt-mcp'];
  });
  afterEach(() => { process.argv = originalArgv; });

  it('reads the host key once and forwards it to server setup', async () => {
    const keys = confirmationKeys();
    doubles.read.mockReturnValue(keys.publicKey);
    process.argv.push('--goal-confirmation-public-key', '/host/confirmation.pub');
    await connectTaktMcpServerToStdio();
    expect(doubles.read).toHaveBeenCalledTimes(1);
    expect(doubles.read).toHaveBeenCalledWith('/host/confirmation.pub', 'utf8');
    expect(doubles.server).toHaveBeenCalledWith({}, expect.objectContaining({
      goalConfirmationPublicKey: keys.publicKey, toolSet: 'all',
    }));
    expect(doubles.connect).toHaveBeenCalledTimes(1);
  });

  it('keeps read-only startup available without a confirmation key', async () => {
    process.argv.push('--tool-set', 'read-only');
    await connectTaktMcpServerToStdio();
    expect(doubles.read).not.toHaveBeenCalled();
    expect(doubles.server).toHaveBeenCalledWith({}, expect.objectContaining({
      goalConfirmationPublicKey: undefined, toolSet: 'read-only',
    }));
  });

  it('forwards the manager tool set and only the host public key to MCP setup', async () => {
    const keys = confirmationKeys();
    doubles.read.mockReturnValue(keys.publicKey);
    process.argv.push('--tool-set', 'manager', '--goal-confirmation-public-key', '/host/confirmation.pub');

    await connectTaktMcpServerToStdio();

    expect(doubles.server).toHaveBeenCalledWith({}, expect.objectContaining({
      toolSet: 'manager', goalConfirmationPublicKey: keys.publicKey,
    }));
    expect(doubles.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing key path before connecting', async () => {
    process.argv.push('--goal-confirmation-public-key');
    await expect(connectTaktMcpServerToStdio()).rejects.toThrow();
    expect(doubles.server).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid PEM before connecting', async () => {
    doubles.read.mockReturnValue('invalid PEM');
    process.argv.push('--goal-confirmation-public-key', '/host/confirmation.pub');
    await expect(connectTaktMcpServerToStdio()).rejects.toThrow();
    expect(doubles.server).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });
});
