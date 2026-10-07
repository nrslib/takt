import { beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = doubles.connect; callTool = doubles.call; close = doubles.close; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); } } }));
import { executeMockMcpCalls } from '../infra/mock/mcp.js';
import type { MockCallOptions } from '../infra/mock/types.js';
const calls = [{ server: 'manager', tool: 'takt_list_goals', arguments: { cwd: '/project' } }];
const options: MockCallOptions = {
  cwd: '/project', allowedTools: ['mcp__manager__takt_list_goals'],
  preparedMcp: { dispose: async () => {}, resolvedServers: { enabled: true, identity: 'fixture', serverNames: ['manager'], servers: { manager: { type: 'stdio', command: 'node', args: ['mcp.js'] } } } },
};
beforeEach(() => { vi.resetAllMocks(); doubles.call.mockResolvedValue({ content: [] }); });
describe('mock provider real MCP calls', () => {
  it('transfers real arguments and awaits SDK responses before closing both resources', async () => {
    await executeMockMcpCalls(calls, options);
    expect(doubles.call).toHaveBeenCalledWith({ name: calls[0]!.tool, arguments: calls[0]!.arguments }, undefined, { signal: undefined });
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    expect(doubles.transport).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/project', command: 'node' }));
  });
  it('refuses an unallowed tool before launching a server', async () => {
    await expect(executeMockMcpCalls(calls, { ...options, allowedTools: [] })).rejects.toThrow('not allowed');
    expect(doubles.connect).not.toHaveBeenCalled();
  });
  it('refuses an absent server rather than simulating a result', async () => {
    await expect(executeMockMcpCalls(calls, { ...options, preparedMcp: undefined })).rejects.toThrow('configured stdio');
  });
  it.each(['connect', 'call', 'error-result'] as const)('propagates %s failures and closes the transport', async (failure) => {
    if (failure === 'error-result') doubles.call.mockResolvedValue({ isError: true });
    else doubles[failure].mockRejectedValue(new Error('injected failure'));
    await expect(executeMockMcpCalls(calls, options)).rejects.toThrow();
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
});
