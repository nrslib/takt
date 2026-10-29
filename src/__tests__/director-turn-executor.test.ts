import { afterEach, expect, it, vi } from 'vitest';
import { createDirectorTurnExecutor } from '../features/director/turnExecutor.js';
import { DIRECTOR_TOOL_ALLOWLIST, DIRECTOR_MCP_SERVER_NAME } from '../features/director/mcp.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { makeProvider } from './test-helpers.js';
import * as adapters from '../infra/providers/mcp/index.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';

afterEach(() => vi.restoreAllMocks());
const success = { persona: 'director', status: 'done' as const, content: 'reply', timestamp: new Date(), sessionId: 'next-session' };
function fixture() {
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue(success);
  const dispose = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ dispose }));
  vi.spyOn(adapters, 'createMcpAdapter').mockReturnValue({ validate: vi.fn(), prepare, classifyFailure: () => ({ category: 'provider_error' }) });
  const setup = vi.fn(() => ({ call }));
  const executor = createDirectorTurnExecutor({ cwd: '/config', systemPrompt: 'director prompt',
    ctx: { provider: makeProvider({ setup }), providerType: 'mock', model: 'model', lang: 'ja' } },
  { type: 'http', url: 'http://127.0.0.1:12345/', headers: { authorization: 'test-only' } });
  const invalidateSession = vi.fn(async () => {});
  const input: ManagerTurnInput = { prompt: 'message', instruction: 'message', sessionId: 'prior-session',
    assignment: undefined, configDirectory: '/config', abortSignal: new AbortController().signal,
    recovery: { context: '', invalidateSession } };
  return { call, dispose, prepare, setup, executor, input, invalidateSession };
}

it('exposes only the dedicated MCP set and preserves readonly restrictions on overflow retry', async () => {
  const f = fixture();
  f.call.mockRejectedValueOnce(new Error('prompt is too long'));
  expect(await f.executor.execute(f.input)).toMatchObject({ message: 'reply', summary: null, sessionId: 'next-session' });
  expect(f.setup).toHaveBeenCalledWith({ name: 'director', systemPrompt: 'director prompt' });
  expect(f.call).toHaveBeenCalledTimes(2);
  for (const [, options] of f.call.mock.calls) {
    expect(options).toMatchObject({ cwd: '/config', permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST,
      callerManagedSession: true, callerManagedMcp: true, model: 'model', language: 'ja' });
    expect(Object.keys(options.mcpServers!)).toEqual([DIRECTOR_MCP_SERVER_NAME]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.mcpOnlySideEffects).toBeUndefined();
    expect(options.allowReadonlyFileRead).toBeUndefined();
  }
  expect(f.call.mock.calls[0]![1].sessionId).toBe('prior-session');
  expect(f.call.mock.calls[1]![1].sessionId).toBeUndefined();
  expect(f.invalidateSession).toHaveBeenCalledOnce();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it('clears a rejected saved session before a single fresh call', async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...success, status: 'error', failureCategory: 'session_continuation_unsupported' });
  f.call.mockResolvedValueOnce({ ...success, sessionId: undefined });
  expect((await f.executor.execute(f.input)).sessionId).toBeUndefined();
  expect(f.invalidateSession).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenCalledTimes(2);
});

it('removes builtin tools and ambient configuration at the Claude SDK boundary', async () => {
  const options = buildSdkOptions({ cwd: '/config', permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST });
  expect(options.tools).toEqual([]);
  expect(options.allowedTools).toEqual(DIRECTOR_TOOL_ALLOWLIST);
  expect(options.settingSources).toEqual([]);
  expect(options.skills).toEqual([]);
  expect(options.plugins).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Skill', 'mcp__takt_director__takt_get_run', 'mcp__ambient__write']) {
    expect(await options.canUseTool!(tool, {}, { signal: new AbortController().signal, toolUseID: 'test', requestId: 'request' })).toMatchObject({ behavior: 'deny' });
  }
  expect(await options.canUseTool!(DIRECTOR_TOOL_ALLOWLIST[0]!, {}, { signal: new AbortController().signal, toolUseID: 'test', requestId: 'request' })).toMatchObject({ behavior: 'allow' });
});

it.each(['tool', 'generic', 'cancelled'] as const)('never replays a %s failure and disposes prepared MCP', async (condition) => {
  const f = fixture();
  const controller = new AbortController();
  f.call.mockImplementationOnce(async (_prompt, options) => {
    if (condition === 'tool') options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: DIRECTOR_TOOL_ALLOWLIST[0]!, input: {} } });
    if (condition === 'cancelled') controller.abort();
    throw new Error(condition === 'generic' ? 'network failure' : 'prompt is too long');
  });
  await expect(f.executor.execute({ ...f.input, abortSignal: controller.signal })).rejects.toThrow();
  expect(f.call).toHaveBeenCalledOnce();
  expect(f.dispose).toHaveBeenCalledOnce();
});
