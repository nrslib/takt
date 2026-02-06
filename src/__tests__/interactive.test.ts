/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAgentSessions: vi.fn(() => ({})),
  updateAgentSession: vi.fn(),
  getProjectConfigDir: vi.fn(() => '/tmp'),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
}));

// Mock readline to simulate user input
vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

import { createInterface } from 'node:readline';
import { getProvider } from '../infra/providers/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { selectOption } from '../shared/prompt/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockCreateInterface = vi.mocked(createInterface);
const mockSelectOption = vi.mocked(selectOption);

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
  // selectPostSummaryAction uses selectOption with action values
  mockSelectOption.mockResolvedValue('execute');
});

describe('interactiveMode', () => {
  it('should return action=cancel when user types /cancel', async () => {
    // Given
    setupInputSequence(['/cancel']);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return action=cancel on EOF (Ctrl+D)', async () => {
    // Given
    setupInputSequence([null]);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('cancel');
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

  it('should return action=execute with task on /go after conversation', async () => {
    // Given
    setupInputSequence(['add auth feature', '/go']);
    setupMockProvider(['What kind of authentication?', 'Implement auth feature with chosen method.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Implement auth feature with chosen method.');
  });

  it('should reject /go with no prior conversation', async () => {
    // Given: /go immediately, then /cancel to exit
    setupInputSequence(['/go', '/cancel']);
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then: should cancel (fell through to /cancel)
    expect(result.action).toBe('cancel');
  });

  it('should skip empty input', async () => {
    // Given: empty line, then actual input, then /go
    setupInputSequence(['', 'do something', '/go']);
    setupMockProvider(['Sure, what exactly?', 'Do something with the clarified scope.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('execute');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(2);
  });

  it('should accumulate conversation history across multiple turns', async () => {
    // Given: two user messages before /go
    setupInputSequence(['first message', 'second message', '/go']);
    setupMockProvider(['response to first', 'response to second', 'Summarized task.']);

    // When
    const result = await interactiveMode('/project');

    // Then: task should be a summary and prompt should include full history
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Summarized task.');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    const summaryPrompt = mockProvider.call.mock.calls[2]?.[1] as string;
    expect(summaryPrompt).toContain('Conversation:');
    expect(summaryPrompt).toContain('User: first message');
    expect(summaryPrompt).toContain('Assistant: response to first');
    expect(summaryPrompt).toContain('User: second message');
    expect(summaryPrompt).toContain('Assistant: response to second');
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
    setupMockProvider(['What do you mean by "a"?', 'Clarify task for "a".']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: AI should have been called with initialInput
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(2);
    expect(mockProvider.call.mock.calls[0]?.[1]).toBe('a');

    // /go should work because initialInput already started conversation
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Clarify task for "a".');
  });

  it('should send only current input for subsequent turns after initialInput', async () => {
    // Given: initialInput, then follow-up, then /go
    setupInputSequence(['fix the login page', '/go']);
    setupMockProvider(['What about "a"?', 'Got it, fixing login page.', 'Fix login page with clarified scope.']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: each call receives only its own input (session handles history)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { call: ReturnType<typeof vi.fn> };
    expect(mockProvider.call).toHaveBeenCalledTimes(3);
    expect(mockProvider.call.mock.calls[0]?.[1]).toBe('a');
    expect(mockProvider.call.mock.calls[1]?.[1]).toBe('fix the login page');

    // Task still contains all history for downstream use
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix login page with clarified scope.');
  });

  describe('/play command', () => {
    it('should return action=execute with task on /play command', async () => {
      // Given
      setupInputSequence(['/play implement login feature']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('execute');
      expect(result.task).toBe('implement login feature');
    });

    it('should show error when /play has no task content', async () => {
      // Given: /play without task, then /cancel to exit
      setupInputSequence(['/play', '/cancel']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel (fell through to /cancel)
      expect(result.action).toBe('cancel');
    });

    it('should handle /play with leading/trailing spaces', async () => {
      // Given
      setupInputSequence(['/play   test task  ']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('execute');
      expect(result.task).toBe('test task');
    });

    it('should skip AI summary when using /play', async () => {
      // Given
      setupInputSequence(['/play quick task']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: provider should NOT have been called (no summary needed)
      const mockProvider = mockGetProvider.mock.results[0]?.value as { call: ReturnType<typeof vi.fn> };
      expect(mockProvider.call).not.toHaveBeenCalled();
      expect(result.action).toBe('execute');
      expect(result.task).toBe('quick task');
    });
  });

  describe('action selection after /go', () => {
    it('should return action=create_issue when user selects create issue', async () => {
      // Given
      setupInputSequence(['describe task', '/go']);
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValue('create_issue');

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('create_issue');
      expect(result.task).toBe('Summarized task.');
    });

    it('should return action=save_task when user selects save task', async () => {
      // Given
      setupInputSequence(['describe task', '/go']);
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValue('save_task');

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('save_task');
      expect(result.task).toBe('Summarized task.');
    });

    it('should continue editing when user selects continue', async () => {
      // Given: user selects 'continue' first, then cancels
      setupInputSequence(['describe task', '/go', '/cancel']);
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValueOnce('continue');

      // When
      const result = await interactiveMode('/project');

      // Then: should fall through to /cancel
      expect(result.action).toBe('cancel');
    });

    it('should continue editing when user presses ESC (null)', async () => {
      // Given: selectOption returns null (ESC), then user cancels
      setupInputSequence(['describe task', '/go', '/cancel']);
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValueOnce(null);

      // When
      const result = await interactiveMode('/project');

      // Then: should fall through to /cancel
      expect(result.action).toBe('cancel');
    });
  });
});
