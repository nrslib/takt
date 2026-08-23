/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
} from './helpers/stdinSimulator.js';

const { mockResolveFormalSpecMode, mockSelectRecentSession } = vi.hoisted(() => ({
  mockResolveFormalSpecMode: vi.fn(),
  mockSelectRecentSession: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveFormalSpecMode: (cwd: string) => mockResolveFormalSpecMode(cwd),
}));

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: unknown[]) => mockSelectRecentSession(...args),
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
  takeSessionState: vi.fn(() => null),
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
import { info } from '../shared/ui/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockInfo = vi.mocked(info);

function setupMockProvider(responses: string[]): void {
  const { provider } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
  mockResolveFormalSpecMode.mockResolvedValue(false);
  mockSelectRecentSession.mockResolvedValue(null);
});

afterEach(() => {
  restoreStdin();
});

describe('interactiveMode', () => {
  it.each([
    ['assistant', undefined, undefined],
    ['Grill Me', undefined, { assistantMode: 'grill-me' as const }],
    ['resumed assistant', 'existing-session', undefined],
  ] as const)('should resolve formal specification mode once when starting a %s session', async (_label, sessionId, options) => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await interactiveMode('/project', undefined, undefined, sessionId, undefined, options);

    expect(mockResolveFormalSpecMode).toHaveBeenCalledOnce();
    expect(mockResolveFormalSpecMode).toHaveBeenCalledWith('/project');
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    'should apply formal specification mode=%s before resume and mode=%s after selecting a session',
    async (initialFormalSpec, resumedFormalSpec) => {
      setupRawStdin(toRawInputs([
        'describe the initial behavior',
        '/resume',
        'describe the resumed behavior',
        '/go',
      ]));
      const { provider, capture } = createMockProvider([
        'Which initial states matter?',
        'Which resumed states matter?',
        '# Task instruction',
      ]);
      mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
      mockSelectRecentSession.mockResolvedValue('selected-session');
      mockResolveFormalSpecMode
        .mockResolvedValueOnce(initialFormalSpec)
        .mockResolvedValueOnce(resumedFormalSpec);

      await interactiveMode('/project');

      expect(mockResolveFormalSpecMode).toHaveBeenCalledTimes(2);
      expect(mockResolveFormalSpecMode).toHaveBeenNthCalledWith(1, '/project');
      expect(mockResolveFormalSpecMode).toHaveBeenNthCalledWith(2, '/project');
      expect(capture.systemPrompts).toHaveLength(3);
    },
  );

  it('should not resolve formal specification mode again when session selection is cancelled', async () => {
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupMockProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    await interactiveMode('/project');

    expect(mockResolveFormalSpecMode).toHaveBeenCalledOnce();
  });

  it.each([
    ['assistant', undefined],
    ['Grill Me', { assistantMode: 'grill-me' as const }],
  ] as const)('should apply resolved formal specification mode to the %s system prompt', async (_label, options) => {
    setupRawStdin(toRawInputs(['plan a stateful feature', '/cancel']));
    const { provider, capture } = createMockProvider(['Which states are involved?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecMode.mockResolvedValue(true);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, options);

    expect(capture.systemPrompts[0]).toMatch(/Gherkin/);
    expect(capture.systemPrompts[0]).toMatch(/\bQuint\b/);
    expect(capture.systemPrompts[0]).toMatch(/\bAlloy\b/);
  });

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

  it('should set up the Grill Me persona when selected', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/cancel']));
    const { provider } = createMockProvider(['Which roles may approve?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(provider.setup).toHaveBeenCalledWith(expect.objectContaining({
      name: 'grill-me-interactive',
    }));
  });

  it('should restrict Grill Me provider calls to read-only tools', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/cancel']));
    const { provider } = createMockProvider(['Which roles may approve?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect((provider as { _call: ReturnType<typeof vi.fn> })._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      }),
    );
  });

  it('should propagate readonly permission mode for Grill Me calls', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/cancel']));
    const { provider, capture } = createMockProvider(['Which roles may approve?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(capture.permissionModes).toEqual(['readonly']);
  });

  it('should show the Grill Me intro when selected', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(mockInfo).toHaveBeenCalled();
  });

  it('should return action=execute on /go after a Grill Me conversation', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/go']));
    setupMockProvider(['Which roles may approve?', 'Require explicit approval from repository maintainers.']);

    const result = await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(result).toEqual({
      action: 'execute',
      task: 'Require explicit approval from repository maintainers.',
    });
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

  it('should return action=execute with task on initial /go with inline task text', async () => {
    // Given
    setupRawStdin(toRawInputs(['/go add auth feature', '/cancel']));
    setupMockProvider(['Implement auth feature from inline /go task.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result).toEqual({
      action: 'execute',
      task: 'Implement auth feature from inline /go task.',
    });
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
  });

  it('should return action=execute with task on initial suffix /go command text', async () => {
    // Given
    setupRawStdin(toRawInputs(['add auth feature /go', '/cancel']));
    setupMockProvider(['Implement auth feature from suffix /go task.']);

    // When
    const result = await interactiveMode('/project');

    // Then
    expect(result).toEqual({
      action: 'execute',
      task: 'Implement auth feature from suffix /go task.',
    });
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
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

    // Then: task should be a summary.
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Summarized task.');
  });

  it('should keep initialInput as source context before user interaction', async () => {
    // Given: initialInput provided, then user types /go
    setupRawStdin(toRawInputs(['/go']));
    setupMockProvider(['Clarify task for "a".']);

    // When
    const result = await interactiveMode('/project', { sourceContext: 'a' });

    // Then: initial input is kept as source context and only /go summary call reaches AI
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Clarify task for "a".');
  });

  it('should pass the issue body and every comment to the Grill Me prompt', async () => {
    const sourceContext = [
      'Issue body for the current task',
      '**first-author**: first comment',
      '**task-author**: past task instructions',
      '**latest-author**: latest comment',
    ].join('\n');
    setupRawStdin(toRawInputs(['/go']));
    const { provider, capture } = createMockProvider(['Clarify the complete issue context.']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', { sourceContext }, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(capture.prompts[0]).toEqual(expect.stringContaining('Issue body for the current task'));
    expect(capture.prompts[0]).toEqual(expect.stringContaining('first comment'));
    expect(capture.prompts[0]).toEqual(expect.stringContaining('past task instructions'));
    expect(capture.prompts[0]).toEqual(expect.stringContaining('latest comment'));
  });

  it('should keep inline /go text as user note when source context exists before conversation', async () => {
    setupRawStdin(toRawInputs(['/go add auth feature', '/cancel']));
    setupMockProvider(['Clarify task for source context plus note.']);

    const result = await interactiveMode('/project', { sourceContext: 'a' });

    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      action: 'execute',
      task: 'Clarify task for source context plus note.',
    });
  });

  it('should send only explicit user turns and include initialInput in summary context', async () => {
    // Given: initialInput, then follow-up, then /go
    setupRawStdin(toRawInputs(['fix the login page', '/go']));
    setupMockProvider(['Got it, fixing login page.', 'Fix login page with clarified scope.']);

    // When
    const result = await interactiveMode('/project', { sourceContext: 'a' });

    // Then: first AI call is from explicit follow-up input, second is /go summary
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(2);

    // Task still contains all history for downstream use
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix login page with clarified scope.');
  });

  it('should keep direct task as conversation input instead of source context', async () => {
    setupRawStdin(toRawInputs(['/go']));
    setupMockProvider(['Clarify direct task.']);

    const result = await interactiveMode('/project', { userMessage: 'fix login' });

    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: 'execute', task: 'Clarify direct task.' });
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

  it('should not start provider call from initial input alone', async () => {
    const mockCall = vi.fn();
    mockGetProvider.mockReturnValue({
      getRuntimeInstructions: vi.fn(() => null),
      setup: () => ({
        call: mockCall,
      }),
    } as unknown as ReturnType<typeof getProvider>);

    setupRawStdin(toRawInputs(['/cancel']));
    const result = await interactiveMode('/project', { userMessage: 'trigger' });
    expect(result.action).toBe('cancel');
    expect(mockCall).not.toHaveBeenCalled();
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

  describe('/accept command', () => {
    it('should return action=execute with the latest assistant response unchanged', async () => {
      // Given
      const latestAssistantResponse = '  Implement the second request exactly.\nKeep this newline.\n';
      setupRawStdin(toRawInputs(['first request', 'second request', '/accept', '/cancel']));
      setupMockProvider(['Implement the first request.', latestAssistantResponse]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result).toEqual({
        action: 'execute',
        task: latestAssistantResponse,
      });
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      expect(mockProvider._call).toHaveBeenCalledTimes(2);
      expect(mockSelectOption).not.toHaveBeenCalled();
    });

    it('should show an error and continue when there is no assistant response', async () => {
      // Given
      setupRawStdin(toRawInputs(['/accept', '/cancel']));
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then
      expect(result).toEqual({ action: 'cancel', task: '' });
      expect(mockInfo).toHaveBeenCalled();
      const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
      expect(mockProvider._call).not.toHaveBeenCalled();
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
    it('should handle Ctrl+D to cancel input', async () => {
      // Given: Ctrl+D during input
      setupRawStdin(['\x04']);
      setupMockProvider([]);

      // When
      const result = await interactiveMode('/project');

      // Then: should cancel
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

  });

});
