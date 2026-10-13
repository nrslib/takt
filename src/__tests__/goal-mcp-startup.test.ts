import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTaktMcpServerToStdio } from '../app/mcp/index.js';

const doubles = vi.hoisted(() => ({ read: vi.fn(), server: vi.fn(), connect: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: doubles.read,
}));
vi.mock('../app/mcp/server.js', () => ({ createTaktMcpServer: doubles.server }));
vi.mock('../shared/utils/entrypoint.js', () => ({ isDirectEntrypoint: () => false }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

describe('Goal MCP startup configuration', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.server.mockReturnValue({ connect: doubles.connect });
    doubles.connect.mockResolvedValue(undefined);
    process.argv = ['node', 'takt-mcp'];
  });
  afterEach(() => { process.argv = originalArgv; });

  it.each(['all', 'manager', 'read-only'])('starts the %s tool set without a confirmation key', async (toolSet) => {
    process.argv.push('--tool-set', toolSet);
    await connectTaktMcpServerToStdio();
    expect(doubles.read).not.toHaveBeenCalled();
    expect(doubles.server).toHaveBeenCalledWith({}, expect.objectContaining({ toolSet }));
    expect(doubles.server.mock.calls[0]![1]).not.toHaveProperty('goalConfirmationPublicKey');
    expect(doubles.connect).toHaveBeenCalledOnce();
  });
});
