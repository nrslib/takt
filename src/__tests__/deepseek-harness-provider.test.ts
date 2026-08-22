import { describe, expect, it, vi } from 'vitest';

const { mockCallDeepSeekHarness, mockLogger } = vi.hoisted(() => ({
  mockCallDeepSeekHarness: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../infra/deepseek-harness/index.js', () => ({
  callDeepSeekHarness: mockCallDeepSeekHarness,
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  createLogger: vi.fn(() => mockLogger),
}));

import { DeepSeekHarnessProvider } from '../infra/providers/deepseek-harness.js';

describe('DeepSeekHarnessProvider', () => {
  it('declares the official SDK capability boundary', () => {
    const provider = new DeepSeekHarnessProvider();

    expect(provider.supportsStructuredOutput).toBe(false);
    expect(provider.supportsNativeImageInput).toBe(false);
    expect(provider.supportsPermissionControls?.()).toBe(false);
    expect(provider.getRuntimeInstructions()).toBeNull();
  });

  it('passes session, model, provider options, and abort state to the bridge client', async () => {
    mockCallDeepSeekHarness.mockResolvedValue({
      persona: 'worker',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });

    const provider = new DeepSeekHarnessProvider();
    const agent = provider.setup({ name: 'worker', systemPrompt: 'Use Cordis.' });
    const onStream = vi.fn();
    const abortController = new AbortController();

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'deepseek-v4-flash',
      sessionId: 'session-1',
      providerOptions: {
        deepseekHarness: {
          pythonPath: '/usr/bin/python3',
          requestTimeoutMs: 12_000,
        },
      },
      abortSignal: abortController.signal,
      onStream,
    });

    expect(mockCallDeepSeekHarness).toHaveBeenCalledWith('worker', 'implement', {
      cwd: '/tmp/work',
      model: 'deepseek-v4-flash',
      sessionId: 'session-1',
      providerOptions: {
        pythonPath: '/usr/bin/python3',
        requestTimeoutMs: 12_000,
      },
      abortSignal: abortController.signal,
      systemPrompt: 'Use Cordis.',
      onStream,
      childProcessEnv: undefined,
    });
  });

  it.each([
    ['permissionMode', { permissionMode: 'readonly' as const }],
    ['bypassPermissions', { bypassPermissions: true }],
    ['allowedTools', { allowedTools: ['Read'] }],
  ] as const)('returns an error before bridge invocation for unsupported %s constraints', async (_name, constraint) => {
    mockCallDeepSeekHarness.mockClear();

    const response = await new DeepSeekHarnessProvider().setup({ name: 'worker' }).call('implement', {
      cwd: '/tmp/work',
      ...constraint,
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('cannot honor');
    expect(mockCallDeepSeekHarness).not.toHaveBeenCalled();
  });

  it('warns when TAKT options have no official SDK equivalent', async () => {
    mockCallDeepSeekHarness.mockResolvedValue({
      persona: 'worker',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
    mockLogger.warn.mockClear();

    await new DeepSeekHarnessProvider().setup({ name: 'worker' }).call('implement', {
      cwd: '/tmp/work',
      onPermissionRequest: vi.fn(),
      onAskUserQuestion: vi.fn(),
      mcpServers: { docs: { command: 'node', args: ['server.js'] } },
      maxTurns: 3,
      outputSchema: { type: 'object' },
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image.png' }],
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'DeepSeek Harness does not expose TAKT permission callbacks through the Python SDK; ignoring',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'DeepSeek Harness does not support TAKT mcpServers; configure tools in Cordis',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith('DeepSeek Harness does not support maxTurns; ignoring');
    expect(mockLogger.warn).toHaveBeenCalledWith('DeepSeek Harness does not support TAKT structured output; ignoring');
    expect(mockLogger.warn).toHaveBeenCalledWith('DeepSeek Harness does not support imageAttachments; ignoring');
  });
});
