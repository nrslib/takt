import { describe, expect, it, vi } from 'vitest';

const { mockCallDeepSeekHarness } = vi.hoisted(() => ({
  mockCallDeepSeekHarness: vi.fn(),
}));

vi.mock('../infra/deepseek-harness/index.js', () => ({
  callDeepSeekHarness: mockCallDeepSeekHarness,
}));
import { DeepSeekHarnessProvider } from '../infra/providers/deepseek-harness.js';
import type { DeepSeekHarnessProviderOptions } from '../core/models/workflow-provider-options.js';
import type { ProviderCallOptions } from '../infra/providers/types.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';

describe('DeepSeekHarnessProvider', () => {
  it('declares the official SDK capability boundary', () => {
    const provider = new DeepSeekHarnessProvider();

    expect(provider.supportsStructuredOutput).toBe(false);
    expect(provider.supportsNativeImageInput).toBe(false);
    expect(provider.supportsPermissionControls?.()).toBe(false);
    expect(provider.getRuntimeInstructions()).toBeNull();
  });

  it('passes session, model, provider options, and abort state to the SDK client', async () => {
    mockCallDeepSeekHarness.mockResolvedValue({
      persona: 'worker',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });

    const provider = new DeepSeekHarnessProvider();
    const agent = provider.setup({ name: 'worker', systemPrompt: 'Follow the exact instruction.' });
    const onStream = vi.fn();
    const abortController = new AbortController();
    const providerOptions: DeepSeekHarnessProviderOptions = {
      requestTimeoutMs: 12_000,
      reasoningEffort: 'low',
    };

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'deepseek-v4-flash',
      sessionId: 'session-1',
      providerOptions: { deepseekHarness: providerOptions },
      effort: 'high',
      abortSignal: abortController.signal,
      onStream,
    });

    expect(mockCallDeepSeekHarness).toHaveBeenCalledWith('worker', 'implement', {
      cwd: '/tmp/work',
      systemPrompt: 'Follow the exact instruction.',
      model: 'deepseek-v4-flash',
      sessionId: 'session-1',
      providerOptions: { ...providerOptions, reasoningEffort: 'high' },
      abortSignal: abortController.signal,
      onStream,
      childProcessEnv: undefined,
    });
  });

  const unsupportedConstraints: Array<[string, Partial<ProviderCallOptions>, string]> = [
    ['maxTurns', { maxTurns: 3 }, 'maxTurns'],
    ['structured output', { outputSchema: { type: 'object' } }, 'structured output'],
    ['image input', { imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image.png' }] }, 'imageAttachments'],
    ['permissionMode', { permissionMode: 'readonly' as const }, 'permission controls'],
    ['bypassPermissions', { bypassPermissions: true }, 'permission controls'],
    ['strict-readonly isolation', { internalAgentIsolation: 'strict-readonly' as const }, 'read-only file access'],
    ['artifact-limited read paths', { readonlyFileReadPaths: ['/repo/spec.md'] }, 'read-only file access'],
    ['allowedTools', { allowedTools: ['Read'] as string[] }, 'allowedTools'],
    ['empty allowedTools', { allowedTools: [] as string[] }, 'allowedTools'],
    ['read-only file access', { allowReadonlyFileRead: true }, 'read-only file access'],
    ['permission callbacks', { onPermissionRequest: vi.fn() }, 'permission callbacks'],
    ['question callbacks', { onAskUserQuestion: vi.fn() }, 'permission callbacks'],
    ['MCP servers', { mcpServers: { docs: { command: 'node', args: ['server.js'] } } }, 'mcpServers'],
    ['prepared MCP configuration', { preparedMcp: { dispose: async () => {} } }, 'mcpServers'],
  ];

  it.each(unsupportedConstraints)('returns an error before SDK invocation for unsupported %s constraints', async (_name, constraint, expectedConstraint) => {
    mockCallDeepSeekHarness.mockClear();

    const response = await new DeepSeekHarnessProvider().setup({ name: 'worker' }).call('implement', {
      cwd: '/tmp/work',
      ...constraint,
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain(`cannot honor ${expectedConstraint}`);
    expect(mockCallDeepSeekHarness).not.toHaveBeenCalled();
  });

  it('rejects a reasoning effort value that the SDK cannot represent before invocation', async () => {
    mockCallDeepSeekHarness.mockClear();
    const response = await new DeepSeekHarnessProvider().setup({ name: 'worker' }).call('implement', {
      cwd: '/tmp/work',
      effort: 'xhigh',
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness cannot honor this reasoning effort; supported values are off, low, high, and max.',
    });
    expect(JSON.stringify(response)).not.toContain('xhigh');
    expect(mockCallDeepSeekHarness).not.toHaveBeenCalled();
  });

  it('keeps a fixed continuation refusal and its category at the provider boundary', async () => {
    mockCallDeepSeekHarness.mockReset();
    const rawFailure = 'session already exists TAKT_DUMMY_ERROR_SENTINEL';
    const fixedDiagnostic = 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.';
    mockCallDeepSeekHarness.mockResolvedValue({
      persona: 'worker',
      status: 'error',
      content: fixedDiagnostic,
      error: fixedDiagnostic,
      failureCategory: AGENT_FAILURE_CATEGORIES.SESSION_CONTINUATION_UNSUPPORTED,
      timestamp: new Date(),
    });
    const agent = new DeepSeekHarnessProvider().setup({ name: 'worker' });

    const response = await agent.call('continue existing work', {
      cwd: '/tmp/work',
      model: 'deepseek-v4-flash',
      sessionId: 'persisted-session',
      providerOptions: { deepseekHarness: { reasoningEffort: 'high' } },
    });

    expect(response).toMatchObject({
      status: 'error',
      content: fixedDiagnostic,
      error: fixedDiagnostic,
      failureCategory: AGENT_FAILURE_CATEGORIES.SESSION_CONTINUATION_UNSUPPORTED,
    });
    expect(response.sessionId).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain(rawFailure);
    expect(mockCallDeepSeekHarness).toHaveBeenCalledOnce();
    expect(mockCallDeepSeekHarness.mock.calls[0]?.[2]).toMatchObject({
      sessionId: 'persisted-session',
      providerOptions: { reasoningEffort: 'high' },
    });
  });

  it('passes the configured system prompt to the SDK runtime adapter', async () => {
    mockCallDeepSeekHarness.mockResolvedValue({
      persona: 'worker',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
    const systemPrompt = 'Keep {{unknown_template}} literal.';

    await new DeepSeekHarnessProvider().setup({ name: 'worker', systemPrompt }).call('implement', {
      cwd: '/tmp/work',
    });

    expect(mockCallDeepSeekHarness).toHaveBeenCalledWith('worker', 'implement', expect.objectContaining({
      systemPrompt,
    }));
  });
});
