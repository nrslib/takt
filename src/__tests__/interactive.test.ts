/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
}));

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../utils/debug.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../cli.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../config/paths.js', () => ({
  loadAgentSessions: vi.fn(() => ({})),
  updateAgentSession: vi.fn(),
}));

vi.mock('../utils/ui.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

// Mock readline to simulate user input
vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

import { createInterface } from 'node:readline';
import { getProvider } from '../providers/index.js';
import { interactiveMode } from '../commands/interactive.js';

const mockGetProvider = vi.mocked(getProvider);
const mockCreateInterface = vi.mocked(createInterface);

/** Helper to set up a sequence of readline inputs */
function setupInputSequence(inputs: (string | null)[]): void {
  let callIndex = 0;

  mockCreateInterface.mockImplementation(() => {
    const input = callIndex < inputs.length ? inputs[callIndex] : null;
    callIndex++;

    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    const rlMock = {
      question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
        if (input === null) {
          // Simulate EOF (Ctrl+D) — emit close event asynchronously
          // so that the on('close') listener is registered first
          queueMicrotask(() => {
            const closeListeners = listeners['close'] || [];
            for (const listener of closeListeners) {
              listener();
            }
          });
        } else {
          callback(input);
        }
      }),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (!listeners[event]) {
          listeners[event] = [];
        }
        listeners[event]!.push(listener);
        return rlMock;
      }),
    } as unknown as ReturnType<typeof createInterface>;

    return rlMock;
  });
}

/** Create a mock provider that returns given responses */
function setupMockProvider(responses: string[]): void {
  let callIndex = 0;
  const mockProvider = {
    call: vi.fn(async () => {
      const content = callIndex < responses.length ? responses[callIndex] : 'AI response';
      callIndex++;
      return {
        agent: 'interactive',
        status: 'done' as const,
        content: content!,
        timestamp: new Date(),
      };
    }),
    callCustom: vi.fn(),
  };
  mockGetProvider.mockReturnValue(mockProvider);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('interactiveMode', () => {
  it('should return confirmed=false when user types /cancel', async () => {
    // Given
    setupInputSequence(['/cancel']);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.confirmed).toBe(false);
    expect(result.task).toBe('');
  });

  it('should return confirmed=false on EOF (Ctrl+D)', async () => {
    // Given
    setupInputSequence([null]);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.confirmed).toBe(false);
  });

  it('should call provider with allowed tools for codebase exploration', async () => {
    // Given
    setupInputSequence(['fix the login bug', '/go']);
    setupMockProvider(['What kind of login bug?']);

    // When
    await interactiveMode('/project');

    // Then
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledWith(
      'interactive',
      expect.any(String),
      expect.objectContaining({
        cwd: '/project',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      }),
    );
  });

  it('should return confirmed=true with task on /go after conversation', async () => {
    // Given
    setupInputSequence(['add auth feature', '/go']);
    setupMockProvider(['What kind of authentication?']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.confirmed).toBe(true);
    expect(result.task).toContain('add auth feature');
    expect(result.task).toContain('What kind of authentication?');
  });

  it('should reject /go with no prior conversation', async () => {
    // Given: /go immediately, then /cancel to exit
    setupInputSequence(['/go', '/cancel']);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then: should not confirm (fell through to /cancel)
    expect(result.confirmed).toBe(false);
  });

  it('should skip empty input', async () => {
    // Given: empty line, then actual input, then /go
    setupInputSequence(['', 'do something', '/go']);
    setupMockProvider(['Sure, what exactly?']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.confirmed).toBe(true);
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(1);
  });

  it('should accumulate conversation history across multiple turns', async () => {
    // Given: two user messages before /go
    setupInputSequence(['first message', 'second message', '/go']);
    setupMockProvider(['response to first', 'response to second']);

    // When
    const result = await interactiveMode('/project');

    // Then: task should contain all messages
    expect(result.confirmed).toBe(true);
    expect(result.task).toContain('first message');
    expect(result.task).toContain('response to first');
    expect(result.task).toContain('second message');
    expect(result.task).toContain('response to second');
  });

  it('should send only current input per turn (session handles history)', async () => {
    // Given
    setupInputSequence(['first msg', 'second msg', '/go']);
    setupMockProvider(['AI reply 1', 'AI reply 2']);

    // When
    await interactiveMode('/project');

    // Then: each call receives only the current user input (session maintains context)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call.mock.calls[0]?.[1]).toBe('first msg');
    expect(mockProvider.call.mock.calls[1]?.[1]).toBe('second msg');
  });

  it('should process initialInput as first message before entering loop', async () => {
    // Given: initialInput provided, then user types /go
    setupInputSequence(['/go']);
    setupMockProvider(['What do you mean by "a"?']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: AI should have been called with initialInput
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(1);
    expect(mockProvider.call.mock.calls[0]?.[1]).toBe('a');

    // /go should work because initialInput already started conversation
    expect(result.confirmed).toBe(true);
    expect(result.task).toContain('a');
    expect(result.task).toContain('What do you mean by "a"?');
  });

  it('should send only current input for subsequent turns after initialInput', async () => {
    // Given: initialInput, then follow-up, then /go
    setupInputSequence(['fix the login page', '/go']);
    setupMockProvider(['What about "a"?', 'Got it, fixing login page.']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: each call receives only its own input (session handles history)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(2);
    expect(mockProvider.call.mock.calls[0]?.[1]).toBe('a');
    expect(mockProvider.call.mock.calls[1]?.[1]).toBe('fix the login page');

    // Task still contains all history for downstream use
    expect(result.confirmed).toBe(true);
    expect(result.task).toContain('a');
    expect(result.task).toContain('fix the login page');
  });
});
