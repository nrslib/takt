/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupRawStdin, restoreStdin, toRawInputs, createMockProvider } from './helpers/stdinSimulator.js';

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

function setupMockProvider(responses: string[]): void {
  const { provider } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
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

  it('should pass sessionId to provider when sessionId parameter is given', async () => {
    // Given
    setupRawStdin(toRawInputs(['hello', '/cancel']));
    setupMockProvider(['AI response']);

    // When
    await interactiveMode('/project', undefined, undefined, 'test-session-id');

    // Then: provider call should include the overridden sessionId
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: 'test-session-id',
      }),
    );
  });

  it('should include run session context in system prompt when provided', async () => {
    // Given
    setupRawStdin(toRawInputs(['hello', '/cancel']));
    const mockSetup = vi.fn();
    const mockCall = vi.fn(async () => ({
      persona: 'interactive',
      status: 'done' as const,
      content: 'AI response',
      timestamp: new Date(),
    }));
    mockSetup.mockReturnValue({ call: mockCall });
    mockGetProvider.mockReturnValue({ setup: mockSetup, _call: mockCall } as unknown as ReturnType<typeof getProvider>);

    const runSessionContext = {
      task: 'Previous run task',
      piece: 'default',
      status: 'completed',
      movementLogs: [{ step: 'implement', persona: 'coder', status: 'completed', content: 'Implementation done' }],
      reports: [],
    };

    // When
    await interactiveMode('/project', undefined, undefined, undefined, runSessionContext);

    // Then: system prompt should contain run session content
    expect(mockSetup).toHaveBeenCalled();
    const setupArgs = mockSetup.mock.calls[0]![0] as { systemPrompt: string };
    expect(setupArgs.systemPrompt).toContain('Previous run task');
    expect(setupArgs.systemPrompt).toContain('default');
    expect(setupArgs.systemPrompt).toContain('completed');
    expect(setupArgs.systemPrompt).toContain('implement');
    expect(setupArgs.systemPrompt).toContain('Implementation done');
    expect(setupArgs.systemPrompt).toContain('Previous Run Reference');
  });

  it('should not include run session section in system prompt when not provided', async () => {
    // Given
    setupRawStdin(toRawInputs(['hello', '/cancel']));
    const mockSetup = vi.fn();
    const mockCall = vi.fn(async () => ({
      persona: 'interactive',
      status: 'done' as const,
      content: 'AI response',
      timestamp: new Date(),
    }));
    mockSetup.mockReturnValue({ call: mockCall });
    mockGetProvider.mockReturnValue({ setup: mockSetup, _call: mockCall } as unknown as ReturnType<typeof getProvider>);

    // When
    await interactiveMode('/project');

    // Then: system prompt should NOT contain run session section
    expect(mockSetup).toHaveBeenCalled();
    const setupArgs = mockSetup.mock.calls[0]![0] as { systemPrompt: string };
    expect(setupArgs.systemPrompt).not.toContain('Previous Run Reference');
  });

  it('should abort in-flight provider call on SIGINT during initial input', async () => {
    mockGetProvider.mockReturnValue({
      setup: () => ({
        call: vi.fn((_prompt: string, options: { abortSignal?: AbortSignal }) => {
          return new Promise((resolve) => {
            options.abortSignal?.addEventListener('abort', () => {
              resolve({
                persona: 'interactive',
                status: 'error',
                content: 'aborted',
                timestamp: new Date(),
              });
            }, { once: true });
          });
        }),
      }),
    } as unknown as ReturnType<typeof getProvider>);

    const promise = interactiveMode('/project', 'trigger');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]?.();

    const result = await promise;
    expect(result.action).toBe('cancel');
  });

  it('should use saved sessionId from initializeSession when no sessionId parameter is given', async () => {
    // Given
    setupRawStdin(toRawInputs(['hello', '/cancel']));
    setupMockProvider(['AI response']);

    // When: no sessionId parameter
    await interactiveMode('/project');

    // Then: provider call should include sessionId from initializeSession (undefined in mock)
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: undefined,
      }),
    );
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

    it('should move cursor with arrow keys and insert at position', async () => {
      // Given: type "hllo", left 3 → cursor at 1, type "e", Enter
      // buffer: "h" + "e" + "llo" = "hello"
      setupRawStdin([
        'hllo\x1B[D\x1B[D\x1B[De\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: arrow keys move cursor, "e" inserted at position 1 → "hello"
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

    it('should handle Ctrl+U to clear current line', async () => {
      // Given: type "hello", Ctrl+U (\x15), type "world", Enter
      setupRawStdin([
        'hello\x15world\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: "hello" was cleared by Ctrl+U, only "world" remains
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('world');
      expect(prompt).not.toContain('helloworld');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+W to delete previous word', async () => {
      // Given: type "hello world", Ctrl+W (\x17), Enter
      setupRawStdin([
        'hello world\x17\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: "world" was deleted by Ctrl+W, "hello " remains
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello');
      expect(prompt).not.toContain('world');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+H (backspace alternative) to delete character', async () => {
      // Given: type "ab", Ctrl+H (\x08), type "c", Enter
      setupRawStdin([
        'ab\x08c\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: Ctrl+H deletes 'b', buffer is "ac"
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('ac');
      expect(result.action).toBe('cancel');
    });

    it('should ignore unknown control characters (e.g. Ctrl+G)', async () => {
      // Given: type "ab", Ctrl+G (\x07, bell), type "c", Enter
      setupRawStdin([
        'ab\x07c\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: Ctrl+G is ignored, buffer is "abc"
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('abc');
      expect(result.action).toBe('cancel');
    });
  });

  describe('cursor management', () => {
    it('should move cursor left with arrow key and insert at position', async () => {
      // Given: type "helo", left 2, type "l", Enter → "hello" wait...
      // "helo" cursor at 4, left 2 → cursor at 2, type "l" → insert at 2: "helelo"? No.
      // Actually: "helo"[0]='h',[1]='e',[2]='l',[3]='o'
      // cursor at 4, left 2 → cursor at 2 (before 'l'), type 'l' → "hel" + "l" + "o" = "hello"? No.
      // Insert at index 2: "he" + "l" + "lo" = "hello". Yes!
      setupRawStdin([
        'helo\x1B[D\x1B[Dl\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      // When
      const result = await interactiveMode('/project');

      // Then: buffer should be "hello"
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello');
      expect(result.action).toBe('cancel');
    });

    it('should move cursor right with arrow key after moving left', async () => {
      // "hello" left 3 → cursor at 2, right 1 → cursor at 3, type "X" → "helXlo"
      setupRawStdin([
        'hello\x1B[D\x1B[D\x1B[D\x1B[CX\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('helXlo');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+A to move cursor to beginning of line', async () => {
      // Type "world", Ctrl+A, type "hello ", Enter → "hello world"
      setupRawStdin([
        'world\x01hello \r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello world');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+A via Kitty CSI-u to move cursor to beginning', async () => {
      // Type "test", Ctrl+A via Kitty ([97;5u), type "X", Enter → "Xtest"
      setupRawStdin([
        'test\x1B[97;5uX\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Xtest');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+E to move cursor to end of line', async () => {
      // Type "hello", Ctrl+A, Ctrl+E, type "!", Enter → "hello!"
      setupRawStdin([
        'hello\x01\x05!\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello!');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+K to delete from cursor to end of line', async () => {
      // Type "hello world", left 6 (cursor before "world"), Ctrl+K, Enter → "hello"
      // Actually: "hello world" length=11, left 6 → cursor at 5 (space before "world")
      // Ctrl+K deletes from 5 to 11 → " world" removed → buffer "hello"
      setupRawStdin([
        'hello world\x1B[D\x1B[D\x1B[D\x1B[D\x1B[D\x1B[D\x0B\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello');
      expect(prompt).not.toContain('hello world');
      expect(result.action).toBe('cancel');
    });

    it('should handle backspace in middle of text', async () => {
      // Type "helllo", left 2, backspace, Enter
      // "helllo" cursor at 6, left 2 → cursor at 4, backspace deletes [3]='l' → "hello"
      setupRawStdin([
        'helllo\x1B[D\x1B[D\x7F\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello');
      expect(result.action).toBe('cancel');
    });

    it('should handle Home key to move to beginning of line', async () => {
      // Type "world", Home (\x1B[H), type "hello ", Enter → "hello world"
      setupRawStdin([
        'world\x1B[Hhello \r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello world');
      expect(result.action).toBe('cancel');
    });

    it('should handle End key to move to end of line', async () => {
      // Type "hello", Home, End (\x1B[F), type "!", Enter → "hello!"
      setupRawStdin([
        'hello\x1B[H\x1B[F!\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello!');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+W with cursor in middle of text', async () => {
      // Type "hello world!", left 1 (before !), Ctrl+W, Enter
      // cursor at 11, Ctrl+W deletes "world" → "hello !"
      setupRawStdin([
        'hello world!\x1B[D\x17\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('hello !');
      expect(result.action).toBe('cancel');
    });

    it('should handle Ctrl+U with cursor in middle of text', async () => {
      // Type "hello world", left 5 (cursor at 6, before "world"), Ctrl+U, Enter
      // Ctrl+U deletes "hello " → buffer becomes "world"
      setupRawStdin([
        'hello world\x1B[D\x1B[D\x1B[D\x1B[D\x1B[D\x15\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('world');
      expect(prompt).not.toContain('hello');
      expect(result.action).toBe('cancel');
    });

    it('should not move cursor past line boundaries with arrow keys', async () => {
      // Type "ab", left 3 (should stop at 0), type "X", Enter → "Xab"
      setupRawStdin([
        'ab\x1B[D\x1B[D\x1B[DX\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Xab');
      expect(result.action).toBe('cancel');
    });

    it('should not move cursor past line end with right arrow', async () => {
      // Type "ab", right 2 (already at end, no effect), type "c", Enter → "abc"
      setupRawStdin([
        'ab\x1B[C\x1B[Cc\r',
        '/cancel\r',
      ]);
      setupMockProvider(['response']);

      const result = await interactiveMode('/project');

      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      const prompt = mockProvider._call.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('abc');
      expect(result.action).toBe('cancel');
    });
  });
});
