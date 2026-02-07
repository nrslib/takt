/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
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

import { getProvider } from '../infra/providers/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { selectOption } from '../shared/prompt/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);

// Store original stdin/stdout properties to restore
let savedIsTTY: boolean | undefined;
let savedIsRaw: boolean | undefined;
let savedSetRawMode: typeof process.stdin.setRawMode | undefined;
let savedStdoutWrite: typeof process.stdout.write;
let savedStdinOn: typeof process.stdin.on;
let savedStdinRemoveListener: typeof process.stdin.removeListener;
let savedStdinResume: typeof process.stdin.resume;
let savedStdinPause: typeof process.stdin.pause;

/**
 * Captures the current data handler and provides sendData.
 *
 * When readMultilineInput registers process.stdin.on('data', handler),
 * this captures the handler so tests can send raw input data.
 *
 * rawInputs: array of raw strings to send sequentially. Each time a new
 * 'data' listener is registered, the next raw input is sent via queueMicrotask.
 */
function setupRawStdin(rawInputs: string[]): void {
  savedIsTTY = process.stdin.isTTY;
  savedIsRaw = process.stdin.isRaw;
  savedSetRawMode = process.stdin.setRawMode;
  savedStdoutWrite = process.stdout.write;
  savedStdinOn = process.stdin.on;
  savedStdinRemoveListener = process.stdin.removeListener;
  savedStdinResume = process.stdin.resume;
  savedStdinPause = process.stdin.pause;

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
  process.stdin.setRawMode = vi.fn((mode: boolean) => {
    (process.stdin as unknown as { isRaw: boolean }).isRaw = mode;
    return process.stdin;
  }) as unknown as typeof process.stdin.setRawMode;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;
  process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;

  let currentHandler: ((data: Buffer) => void) | null = null;
  let inputIndex = 0;

  process.stdin.on = vi.fn(((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'data') {
      currentHandler = handler as (data: Buffer) => void;
      // Send next input when handler is registered
      if (inputIndex < rawInputs.length) {
        const data = rawInputs[inputIndex]!;
        inputIndex++;
        queueMicrotask(() => {
          if (currentHandler) {
            currentHandler(Buffer.from(data, 'utf-8'));
          }
        });
      }
    }
    return process.stdin;
  }) as typeof process.stdin.on);

  process.stdin.removeListener = vi.fn(((event: string) => {
    if (event === 'data') {
      currentHandler = null;
    }
    return process.stdin;
  }) as typeof process.stdin.removeListener);
}

function restoreStdin(): void {
  if (savedIsTTY !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
  }
  if (savedIsRaw !== undefined) {
    Object.defineProperty(process.stdin, 'isRaw', { value: savedIsRaw, configurable: true, writable: true });
  }
  if (savedSetRawMode) {
    process.stdin.setRawMode = savedSetRawMode;
  }
  if (savedStdoutWrite) {
    process.stdout.write = savedStdoutWrite;
  }
  if (savedStdinOn) {
    process.stdin.on = savedStdinOn;
  }
  if (savedStdinRemoveListener) {
    process.stdin.removeListener = savedStdinRemoveListener;
  }
  if (savedStdinResume) {
    process.stdin.resume = savedStdinResume;
  }
  if (savedStdinPause) {
    process.stdin.pause = savedStdinPause;
  }
}

/**
 * Convert user-level inputs to raw stdin data.
 *
 * Each element is either:
 * - A string: sent as typed characters + Enter (\r)
 * - null: sent as Ctrl+D (\x04)
 */
function toRawInputs(inputs: (string | null)[]): string[] {
  return inputs.map((input) => {
    if (input === null) return '\x04';
    return input + '\r';
  });
}

/** Create a mock provider that returns given responses */
function setupMockProvider(responses: string[]): void {
  let callIndex = 0;
  const mockCall = vi.fn(async () => {
    const content = callIndex < responses.length ? responses[callIndex] : 'AI response';
    callIndex++;
    return {
      persona: 'interactive',
      status: 'done' as const,
      content: content!,
      timestamp: new Date(),
    };
  });
  const mockProvider = {
    setup: () => ({ call: mockCall }),
    _call: mockCall,
  };
  mockGetProvider.mockReturnValue(mockProvider);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
});

describe('interactiveMode', () => {
  it('should return action=cancel when user types /cancel', async () => {
    // Given
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return action=cancel on EOF (Ctrl+D)', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should call provider with allowed tools for codebase exploration', async () => {
    // Given
    setupRawStdin(toRawInputs(['fix the login bug', '/go']));
    setupMockProvider(['What kind of login bug?']);

    // When
    await interactiveMode('/project');

    // Then
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: '/project',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      }),
    );
  });

  it('should return action=execute with task on /go after conversation', async () => {
    // Given
    setupRawStdin(toRawInputs(['add auth feature', '/go']));
    setupMockProvider(['What kind of authentication?', 'Implement auth feature with chosen method.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Implement auth feature with chosen method.');
  });

  it('should reject /go with no prior conversation', async () => {
    // Given: /go immediately, then /cancel to exit
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    setupMockProvider([]);

    // When
    const result = await interactiveMode('/project');

    // Then: should cancel (fell through to /cancel)
    expect(result.action).toBe('cancel');
  });

  it('should skip empty input', async () => {
    // Given: empty line (just Enter), then actual input, then /go
    setupRawStdin(toRawInputs(['', 'do something', '/go']));
    setupMockProvider(['Sure, what exactly?', 'Do something with the clarified scope.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result.action).toBe('execute');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(2);
  });

  it('should accumulate conversation history across multiple turns', async () => {
    // Given: two user messages before /go
    setupRawStdin(toRawInputs(['first message', 'second message', '/go']));
    setupMockProvider(['response to first', 'response to second', 'Summarized task.']);

    // When
    const result = await interactiveMode('/project');

    // Then: task should be a summary and prompt should include full history
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Summarized task.');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    const summaryPrompt = mockProvider._call.mock.calls[2]?.[0] as string;
    expect(summaryPrompt).toContain('Conversation:');
    expect(summaryPrompt).toContain('User: first message');
    expect(summaryPrompt).toContain('Assistant: response to first');
    expect(summaryPrompt).toContain('User: second message');
    expect(summaryPrompt).toContain('Assistant: response to second');
  });

  it('should send only current input per turn (session handles history)', async () => {
    // Given
    setupRawStdin(toRawInputs(['first msg', 'second msg', '/go']));
    setupMockProvider(['AI reply 1', 'AI reply 2']);

    // When
    await interactiveMode('/project');

    // Then: each call receives user input with policy injected (session maintains context)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call.mock.calls[0]?.[0]).toContain('first msg');
    expect(mockProvider._call.mock.calls[1]?.[0]).toContain('second msg');
  });

  it('should inject policy into user messages', async () => {
    // Given
    setupRawStdin(toRawInputs(['test message', '/cancel']));
    setupMockProvider(['response']);

    // When
    await interactiveMode('/project');

    // Then: the prompt should contain policy section
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('## Policy');
    expect(prompt).toContain('Interactive Mode Policy');
    expect(prompt).toContain('Policy Reminder');
    expect(prompt).toContain('test message');
  });

  it('should process initialInput as first message before entering loop', async () => {
    // Given: initialInput provided, then user types /go
    setupRawStdin(toRawInputs(['/go']));
    setupMockProvider(['What do you mean by "a"?', 'Clarify task for "a".']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: AI should have been called with initialInput (with policy injected)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(2);
    const firstPrompt = mockProvider._call.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('## Policy');
    expect(firstPrompt).toContain('a');

    // /go should work because initialInput already started conversation
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Clarify task for "a".');
  });

  it('should send only current input for subsequent turns after initialInput', async () => {
    // Given: initialInput, then follow-up, then /go
    setupRawStdin(toRawInputs(['fix the login page', '/go']));
    setupMockProvider(['What about "a"?', 'Got it, fixing login page.', 'Fix login page with clarified scope.']);

    // When
    const result = await interactiveMode('/project', 'a');

    // Then: each call receives only its own input with policy (session handles history)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(3);
    const firstPrompt = mockProvider._call.mock.calls[0]?.[0] as string;
    const secondPrompt = mockProvider._call.mock.calls[1]?.[0] as string;
    expect(firstPrompt).toContain('a');
    expect(secondPrompt).toContain('fix the login page');

    // Task still contains all history for downstream use
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix login page with clarified scope.');
  });

  describe('/play command', () => {
    it('should return action=execute with task on /play command', async () => {
      // Given
      setupRawStdin(toRawInputs(['/play implement login feature']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('execute');
      expect(result.task).toBe('implement login feature');
    });

    it('should show error when /play has no task content', async () => {
      // Given: /play without task, then /cancel to exit
      setupRawStdin(toRawInputs(['/play', '/cancel']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel (fell through to /cancel)
      expect(result.action).toBe('cancel');
    });

    it('should handle /play with leading/trailing spaces', async () => {
      // Given
      setupRawStdin(toRawInputs(['/play   test task  ']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result.action).toBe('execute');
      expect(result.task).toBe('test task');
    });

    it('should skip AI summary when using /play', async () => {
      // Given
      setupRawStdin(toRawInputs(['/play quick task']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: provider should NOT have been called (no summary needed)
      const mockProvider = mockGetProvider.mock.results[0]?.value as { _call: ReturnType<typeof vi.fn> };
      expect(mockProvider._call).not.toHaveBeenCalled();
      expect(result.action).toBe('execute');
      expect(result.task).toBe('quick task');
    });
  });

  describe('action selection after /go', () => {
    it('should return action=create_issue when user selects create issue', async () => {
      // Given
      setupRawStdin(toRawInputs(['describe task', '/go']));
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
      setupRawStdin(toRawInputs(['describe task', '/go']));
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
      setupRawStdin(toRawInputs(['describe task', '/go', '/cancel']));
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValueOnce('continue');

      // When
      const result = await interactiveMode('/project');

      // Then: should fall through to /cancel
      expect(result.action).toBe('cancel');
    });

    it('should continue editing when user presses ESC (null)', async () => {
      // Given: selectOption returns null (ESC), then user cancels
      setupRawStdin(toRawInputs(['describe task', '/go', '/cancel']));
      setupMockProvider(['response', 'Summarized task.']);
      mockSelectOption.mockResolvedValueOnce(null);

      // When
      const result = await interactiveMode('/project');

      // Then: should fall through to /cancel
      expect(result.action).toBe('cancel');
    });
  });

  describe('multiline input', () => {
    it('should handle paste with newlines via bracket paste mode', async () => {
      // Given: pasted text with newlines, then /cancel
      // \x1B[200~ starts paste, \x1B[201~ ends paste
      setupRawStdin([
        '\x1B[200~line1\nline2\nline3\x1B[201~\r',
        '/cancel\r',
      ]);
      setupMockProvider(['Got multiline input']);

      // When
      const result = await interactiveMode('/project');

      // Then: the pasted text should have been sent to AI with newlines preserved
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('line1\nline2\nline3');
      expect(result.action).toBe('cancel');
    });

    it('should handle Shift+Enter (Kitty protocol) for newline insertion', async () => {
      // Given: text with Shift+Enter (\x1B[13;2u) for newline
      setupRawStdin([
        'hello\x1B[13;2uworld\r',
        '/cancel\r',
      ]);
      setupMockProvider(['Got multiline input']);

      // When
      const result = await interactiveMode('/project');

      // Then: input should contain a newline between hello and world
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello\nworld');
      expect(result.action).toBe('cancel');
    });

    it('should handle backspace to delete last character', async () => {
      // Given: type "ab", backspace (\x7F), type "c", Enter
      setupRawStdin([
        'ab\x7Fc\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: input should be "ac" (b was deleted by backspace)
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('ac');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+C to cancel input', async () => {
      // Given: Ctrl+C during input
      setupRawStdin(['\x03']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+C (Kitty CSI-u) to cancel input', async () => {
      // Given: Ctrl+C reported as Kitty keyboard protocol sequence
      setupRawStdin(['\x1B[99;5u']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+D to cancel input', async () => {
      // Given: Ctrl+D during input
      setupRawStdin(['\x04']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+D (Kitty CSI-u) to cancel input', async () => {
      // Given: Ctrl+D reported as Kitty keyboard protocol sequence
      setupRawStdin(['\x1B[100;5u']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+C (xterm modifyOtherKeys) to cancel input', async () => {
      // Given: Ctrl+C reported as xterm modifyOtherKeys sequence
      setupRawStdin(['\x1B[27;5;99~']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+D (xterm modifyOtherKeys) to cancel input', async () => {
      // Given: Ctrl+D reported as xterm modifyOtherKeys sequence
      setupRawStdin(['\x1B[27;5;100~']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
      expect(result.action).toBe('cancel');
    });

    it('should ignore arrow keys in normal mode', async () => {
      // Given: text with arrow keys interspersed (arrows are ignored)
      setupRawStdin([
        'he\x1B[Dllo\x1B[C\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: arrows are ignored, text is "hello"
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello');
      expect(result.action).toBe('cancel');
    });

    it('should handle empty input on Enter', async () => {
      // Given: just Enter (empty), then /cancel
      setupRawStdin(toRawInputs(['', '/cancel']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: empty input is skipped, falls through to /cancel
      expect(result.action).toBe('cancel');
    });
  });
});
