import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn(), transportClose: vi.fn(), transport: vi.fn(), log: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = doubles.connect; callTool = doubles.call; close = doubles.close; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = doubles.transportClose; constructor(input: unknown) { doubles.transport(input); } } }));
vi.mock('../shared/utils/private-file.js', () => ({ appendPrivateFile: doubles.log }));
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { executeMockMcpCalls } from '../infra/mock/mcp.js';
import { callMock } from '../infra/mock/client.js';
import { resetScenario, setMockScenario } from '../infra/mock/scenario.js';
import type { MockCallOptions } from '../infra/mock/types.js';
const calls = [{ server: 'manager', tool: 'takt_list_goals', arguments: { cwd: '/project' } }];
const options: MockCallOptions = {
  cwd: '/project', allowedTools: ['mcp__manager__takt_list_goals'],
  preparedMcp: { dispose: async () => {}, resolvedServers: { enabled: true, identity: 'fixture', serverNames: ['manager'], servers: { manager: { type: 'stdio', command: 'node', args: ['mcp.js'] } } } },
};
beforeEach(() => {
  vi.resetAllMocks();
  doubles.call.mockResolvedValue({ content: [] });
  doubles.close.mockResolvedValue(undefined);
  doubles.transportClose.mockResolvedValue(undefined);
});
afterEach(() => { resetScenario(); vi.unstubAllEnvs(); });
describe('mock provider real MCP calls', () => {
  it('transfers real arguments and awaits SDK responses before closing both resources', async () => {
    const onCallCompleted = vi.fn();
    await expect(executeMockMcpCalls(calls, options, onCallCompleted)).resolves.toBe('completed');
    expect(onCallCompleted).toHaveBeenCalledExactlyOnceWith({ server: 'manager', tool: 'takt_list_goals', result: { content: [] } });
    expect(doubles.call).toHaveBeenCalledWith({ name: calls[0]!.tool, arguments: calls[0]!.arguments }, undefined, { signal: undefined });
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
    expect(doubles.transport).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/project', command: 'node', stderr: 'inherit' }));
  });
  it('refuses an unallowed tool before launching a server', async () => {
    await expect(executeMockMcpCalls(calls, { ...options, allowedTools: [] }, vi.fn())).rejects.toThrow('not allowed');
    expect(doubles.connect).not.toHaveBeenCalled();
  });
  it('refuses an absent server rather than simulating a result', async () => {
    await expect(executeMockMcpCalls(calls, { ...options, preparedMcp: undefined }, vi.fn())).rejects.toThrow('configured stdio');
  });
  it('does not connect or construct a transport when the signal is already aborted', async () => {
    const signal = AbortSignal.abort();
    await expect(executeMockMcpCalls(calls, { ...options, abortSignal: signal }, vi.fn())).resolves.toBe('aborted');
    expect(doubles.connect).not.toHaveBeenCalled();
    expect(doubles.transport).not.toHaveBeenCalled();
  });
  it.each(['connect', 'call', 'error-result'] as const)('propagates %s failures and closes the transport', async (failure) => {
    if (failure === 'error-result') doubles.call.mockResolvedValue({ isError: true });
    else doubles[failure].mockRejectedValue(new Error('injected failure'));
    await expect(executeMockMcpCalls(calls, options, vi.fn())).rejects.toThrow();
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it('preserves a connection failure alongside both cleanup failures', async () => {
    const connectionError = new Error('connection failed');
    const clientError = new Error('client close failed');
    const transportError = new Error('transport close failed');
    doubles.connect.mockRejectedValue(connectionError);
    doubles.close.mockRejectedValue(clientError);
    doubles.transportClose.mockRejectedValue(transportError);
    await expect(executeMockMcpCalls(calls, options, vi.fn())).rejects.toMatchObject({
      errors: [connectionError, clientError, transportError],
    });
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it('propagates a cleanup failure after a successful call and still closes the transport', async () => {
    const error = new Error('client close failed');
    doubles.close.mockRejectedValue(error);
    await expect(executeMockMcpCalls(calls, options, vi.fn())).rejects.toBe(error);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it('records actual MCP responses before completing the provider call', async () => {
    vi.stubEnv('TAKT_MOCK_CALL_LOG', '/calls.jsonl');
    const result = { content: [{ type: 'text', text: 'actual response' }] };
    doubles.call.mockResolvedValue(result);
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    await expect(callMock('manager', 'task', options)).resolves.toMatchObject({ status: 'done' });
    expect(doubles.log.mock.calls.map(([, content]) => JSON.parse(content))).toEqual([
      expect.objectContaining({ event: 'start' }),
      expect.objectContaining({ event: 'mcp_tool_call', mcpToolCall: { server: 'manager', tool: 'takt_list_goals', transport: 'stdio', result } }),
      expect.objectContaining({ event: 'complete', status: 'done', aborted: false }),
    ]);
  });
  it.each(['before', 'during-connect', 'during-call'] as const)('returns blocked and records completion for abort %s MCP execution', async (phase) => {
    vi.stubEnv('TAKT_MOCK_CALL_LOG', '/calls.jsonl');
    const controller = new AbortController();
    if (phase === 'before') controller.abort();
    else if (phase === 'during-connect') doubles.connect.mockImplementation(async (_transport, request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      throw new McpError(ErrorCode.RequestTimeout, 'cancelled');
    });
    else doubles.call.mockImplementation(async (_input, _schema, request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      throw new McpError(ErrorCode.RequestTimeout, 'cancelled');
    });
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    const onStream = vi.fn();
    await expect(callMock('manager', 'task', { ...options, abortSignal: controller.signal, onStream })).resolves.toMatchObject({ status: 'blocked' });
    expect(doubles.log.mock.calls.map(([, content]) => JSON.parse(content))).toEqual([
      expect.objectContaining({ event: 'start' }),
      expect.objectContaining({ event: 'complete', status: 'blocked', aborted: true }),
    ]);
    expect(onStream).not.toHaveBeenCalled();
    expect(doubles.call).toHaveBeenCalledTimes(phase === 'during-call' ? 1 : 0);
  });
  it.each(['close', 'transportClose'] as const)('returns blocked when cancelled during %s after a successful call', async (resource) => {
    const controller = new AbortController();
    doubles[resource].mockImplementation(async () => { controller.abort(); });
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    await expect(callMock('manager', 'task', { ...options, abortSignal: controller.signal })).resolves.toMatchObject({ status: 'blocked' });
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it.each(['close', 'transportClose'] as const)('preserves a %s failure when cancelled after a successful call', async (resource) => {
    const controller = new AbortController();
    const error = new Error('cleanup failed');
    doubles[resource].mockImplementation(async () => {
      controller.abort();
      throw error;
    });
    await expect(executeMockMcpCalls(calls, { ...options, abortSignal: controller.signal }, vi.fn())).rejects.toBe(error);
    expect(doubles.close).toHaveBeenCalledTimes(1);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it('propagates an ordinary MCP error from the provider call', async () => {
    const error = new McpError(ErrorCode.ConnectionClosed, 'connection failed');
    doubles.connect.mockRejectedValue(error);
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    await expect(callMock('manager', 'task', options)).rejects.toBe(error);
  });
  it('preserves SDK cancellation and both cleanup failures instead of completing as blocked', async () => {
    const controller = new AbortController();
    const cancellation = new McpError(ErrorCode.RequestTimeout, 'cancelled');
    const clientError = new Error('client close failed');
    const transportError = new Error('transport close failed');
    doubles.call.mockImplementation(async () => {
      controller.abort();
      throw cancellation;
    });
    doubles.close.mockRejectedValue(clientError);
    doubles.transportClose.mockRejectedValue(transportError);
    vi.stubEnv('TAKT_MOCK_CALL_LOG', '/calls.jsonl');
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    await expect(callMock('manager', 'task', { ...options, abortSignal: controller.signal })).rejects.toMatchObject({
      errors: [cancellation, clientError, transportError],
    });
    expect(doubles.log.mock.calls.map(([, content]) => JSON.parse(content).event)).toEqual(['start']);
    expect(doubles.transportClose).toHaveBeenCalledTimes(1);
  });
  it.each(['failure', 'abort', 'cleanup-failure'] as const)('retains the first successful call when the next call ends in %s', async (outcome) => {
    vi.stubEnv('TAKT_MOCK_CALL_LOG', '/calls.jsonl');
    const controller = new AbortController();
    const result = { content: [{ type: 'text', text: 'task enqueued' }] };
    const laterError = new Error('later failure');
    doubles.call.mockResolvedValueOnce(result).mockImplementationOnce(async () => {
      expect(doubles.log.mock.calls.map(([, content]) => JSON.parse(content).event)).toEqual(['start', 'mcp_tool_call']);
      if (outcome === 'abort') controller.abort('stop');
      if (outcome !== 'cleanup-failure') throw laterError;
      return { content: [] };
    });
    if (outcome === 'cleanup-failure') {
      doubles.close.mockResolvedValueOnce(undefined).mockRejectedValueOnce(laterError);
    }
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: [calls[0]!, calls[0]!] }]);
    const response = callMock('manager', 'task', { ...options, abortSignal: controller.signal });
    if (outcome === 'abort') await expect(response).resolves.toMatchObject({ status: 'blocked' });
    else await expect(response).rejects.toBe(laterError);
    const entries = doubles.log.mock.calls.map(([, content]) => JSON.parse(content));
    expect(entries[1]).toMatchObject({ event: 'mcp_tool_call', mcpToolCall: { result } });
    expect(entries.map(({ event }) => event)).toEqual(outcome === 'abort'
      ? ['start', 'mcp_tool_call', 'complete']
      : outcome === 'cleanup-failure' ? ['start', 'mcp_tool_call', 'mcp_tool_call'] : ['start', 'mcp_tool_call']);
  });
  it('records a successful call even if its own cleanup fails', async () => {
    vi.stubEnv('TAKT_MOCK_CALL_LOG', '/calls.jsonl');
    const error = new Error('client close failed');
    doubles.close.mockRejectedValue(error);
    setMockScenario([{ status: 'done', content: 'done', mcpToolCalls: calls }]);
    await expect(callMock('manager', 'task', options)).rejects.toBe(error);
    expect(doubles.log.mock.calls.map(([, content]) => JSON.parse(content).event)).toEqual(['start', 'mcp_tool_call']);
  });
});
