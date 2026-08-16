import { describe, expect, it, vi } from 'vitest';

const { mockCallPi, mockLogger } = vi.hoisted(() => ({
  mockCallPi: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../infra/pi/index.js', () => ({ callPi: mockCallPi }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  createLogger: vi.fn(() => mockLogger),
}));

import { PiProvider } from '../infra/providers/pi.js';

describe('PiProvider', () => {
  it('exposes Pi SDK capabilities', () => {
    const provider = new PiProvider();

    expect(provider.supportsStructuredOutput).toBe(false);
    expect(provider.supportsNativeImageInput).toBe(true);
  });

  it('passes Pi options and the persona system prompt to the SDK client', async () => {
    mockCallPi.mockResolvedValue({
      persona: 'worker',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });

    const provider = new PiProvider();
    const agent = provider.setup({ name: 'worker', systemPrompt: 'Be concise.' });
    const onStream = vi.fn();
    const onActivity = vi.fn();
    const abortController = new AbortController();

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'anthropic/claude-sonnet-4-5',
      sessionId: 'session-1',
      permissionMode: 'readonly',
      allowedTools: ['Read', 'Glob'],
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image.png' }],
      providerOptions: {
        pi: { extensions: ['npm:trusted-extension'], noSkills: true },
      },
      abortSignal: abortController.signal,
      onStream,
      onActivity,
    });

    expect(mockCallPi).toHaveBeenCalledWith('worker', 'implement', {
      cwd: '/tmp/work',
      model: 'anthropic/claude-sonnet-4-5',
      sessionId: 'session-1',
      permissionMode: 'readonly',
      allowedTools: ['Read', 'Glob'],
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image.png' }],
      providerOptions: { extensions: ['npm:trusted-extension'], noSkills: true },
      abortSignal: abortController.signal,
      systemPrompt: 'Be concise.',
      onStream,
      onActivity,
      childProcessEnv: undefined,
    });
  });

});
