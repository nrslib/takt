/**
 * `outputMode` decides who owns stdout. A silent caller (the Ink TUI) draws its
 * own frames, so nothing in the AI call may write to the terminal behind it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAttachmentReference } from '../shared/types/image-attachments.js';

const { mockInfo, mockError, mockBlankLine } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
  blankLine: (...args: unknown[]) => mockBlankLine(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  updatePersonaSession: vi.fn(),
}));

import { callAIWithRetry, type SessionContext } from '../features/interactive/aiCaller.js';

const ATTACHMENT: ImageAttachmentReference = {
  placeholder: '{{image:1}}',
  path: '/tmp/takt-image-1.png',
};

/** Mirrors a provider that cannot take images natively, e.g. the mock provider. */
function createContext(): SessionContext {
  const agent = {
    call: vi.fn(async () => ({
      persona: 'interactive',
      status: 'done' as const,
      content: 'answer',
      timestamp: new Date(),
      sessionId: 'session-1',
    })),
  };
  return {
    provider: {
      supportsNativeImageInput: false,
      getRuntimeInstructions: () => null,
      setup: () => agent,
    } as unknown as SessionContext['provider'],
    providerType: 'mock',
    model: 'mock-model',
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI call output ownership', () => {
  it('should not write to the terminal in silent mode when images cannot go native', async () => {
    const { result } = await callAIWithRetry(
      'prompt {{image:1}}',
      'system',
      ['Read'],
      '/repo',
      createContext(),
      { outputMode: 'silent', imageAttachments: [ATTACHMENT] },
    );

    expect(result?.success).toBe(true);
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('should still tell a terminal caller that image paths were inlined', async () => {
    await callAIWithRetry(
      'prompt {{image:1}}',
      'system',
      ['Read'],
      '/repo',
      createContext(),
      { outputMode: 'terminal', imageAttachments: [ATTACHMENT] },
    );

    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('does not support native image input'),
    );
  });
});
