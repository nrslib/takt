/**
 * Tests for interactive mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderAgent } from '../infra/providers/types.js';
import { DeepSeekHarnessProvider } from '../infra/providers/deepseek-harness.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { StreamDisplay as TerminalStreamDisplay } from '../shared/ui/StreamDisplay.js';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
  createScenarioProvider,
} from './helpers/stdinSimulator.js';

const {
  mockResolveFormalSpecConfiguration,
  mockResolveFormalSpecConfigurationWithoutPrompt,
  mockSelectRecentSession,
  mockRunFormalSpecVerification,
  mockDeepSeekClientCall,
  mockFetchIssue,
} = vi.hoisted(() => ({
  mockResolveFormalSpecConfiguration: vi.fn(),
  mockResolveFormalSpecConfigurationWithoutPrompt: vi.fn(),
  mockSelectRecentSession: vi.fn(),
  mockRunFormalSpecVerification: vi.fn(),
  mockDeepSeekClientCall: vi.fn(),
  mockFetchIssue: vi.fn(),
}));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/git/index.js')>()),
  getGitProvider: () => ({
    checkCliStatus: () => ({ available: true }),
    fetchIssue: mockFetchIssue,
  }),
}));

vi.mock('../infra/deepseek-harness/index.js', () => ({
  callDeepSeekHarness: mockDeepSeekClientCall,
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
  resolveFormalSpecConfiguration: (...args: unknown[]) => mockResolveFormalSpecConfiguration(...args),
  resolveFormalSpecConfigurationWithoutPrompt: (cwd: string) => mockResolveFormalSpecConfigurationWithoutPrompt(cwd),
}));

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: unknown[]) => mockSelectRecentSession(...args),
}));

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: (...args: unknown[]) => mockRunFormalSpecVerification(...args),
  cleanupFormalSpecVerificationArtifacts: () => undefined,
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
import { runConversationLoop } from '../features/interactive/conversationLoop.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import { createInstructConversationPlan } from '../features/interactive/taskActionConversationPlan.js';
import { runDirectInstructMode } from '../features/tasks/resume/directInstructMode.js';
import { selectOption } from '../shared/prompt/index.js';
import { getLabel } from '../shared/i18n/index.js';
import { info, error, StreamDisplay } from '../shared/ui/index.js';

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
  mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: false, comments: true, modelCheckTimeoutSeconds: 300 });
  mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({ mode: false, comments: true, modelCheckTimeoutSeconds: 300 });
  mockSelectRecentSession.mockResolvedValue(null);
  mockRunFormalSpecVerification.mockReset().mockResolvedValue({
    verdict: 'passed',
    verificationStarted: true,
    quint: { status: 'passed' },
    alloy: { status: 'passed' },
  });
});

afterEach(() => {
  restoreStdin();
  mockSelectOption.mockReset();
});

describe('interactiveMode', () => {
  it('should preview instructions against the replaced Issue within the same conversation', async () => {
    const first = '# Fix first Issue\n\nIssue: #123\n\nFix the first problem.';
    const next = '# Fix next Issue\n\nIssue: #456\n\nFix the next problem.';
    setupRawStdin(toRawInputs(['/go', '/issue #456', '/go']));
    const { provider, capture } = createMockProvider([first, next]);
    mockGetProvider.mockReturnValue(provider);
    mockSelectOption.mockResolvedValueOnce('continue').mockResolvedValueOnce('save_task');
    mockFetchIssue.mockReturnValue({
      number: 456, title: 'Issue 456', body: 'Body 456', labels: [], comments: [], url: 'https://example.com/issues/456',
    });

    const result = await interactiveMode('/project', {
      sourceContext: '## Issue #123: Issue 123\n\nBody 123',
    });

    expect(result).toMatchObject({ action: 'save_task', task: next, issueContextReplacement: { issueNumber: 456 } });
    expect(capture.callCount).toBe(2);
    expect(capture.prompts[0]).toContain('## Issue #123: Issue 123');
    expect(capture.prompts[1]).toContain('## Issue #456: Issue 456');
    expect(capture.prompts[1]).not.toContain('## Issue #123: Issue 123');
    expect(capture.prompts[1]).toContain(first);
    expect(mockFetchIssue).toHaveBeenCalledWith(456, '/project');
    const displayed = mockInfo.mock.calls.map((call) => call[0]);
    expect(displayed).toContain(first);
    expect(displayed).toContain(next);
    expect(mockSelectOption).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('should wait for the initial formal specification answer=%s before starting dialogue', async (mode) => {
    setupRawStdin(toRawInputs(['continue discussing the task', '/cancel']));
    const { provider, capture } = createMockProvider(['What should be changed?']);
    mockGetProvider.mockReturnValue(provider);
    let answer!: (configuration: { mode: boolean; comments: boolean; modelCheckTimeoutSeconds: number }) => void;
    mockResolveFormalSpecConfiguration.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    const run = interactiveMode('/project');
    await Promise.resolve();

    expect(mockResolveFormalSpecConfiguration).toHaveBeenCalledWith('/project');
    expect(capture.callCount).toBe(0);
    answer({ mode, comments: true, modelCheckTimeoutSeconds: 300 });
    const result = await run;

    expect(capture.callCount).toBe(1);
    expect(capture.prompts[0]).toContain('continue discussing the task');
    expect(capture.systemPrompts[0]).toBe(buildInteractiveSystemPrompt('en', {
      grillMe: false, formalSpec: mode, formalSpecComments: true,
    }));
    expect(result.action).toBe('cancel');
  });

  it('should propagate resume confirmation cancellation through the plan and keep the same dialogue', async () => {
    setupRawStdin(toRawInputs(['before resume', '/resume', 'after cancellation', '/cancel']));
    const { provider, capture } = createMockProvider(['Initial answer.', 'Continued answer.']);
    mockGetProvider.mockReturnValue(provider);
    mockSelectRecentSession.mockResolvedValue('unapproved-session');
    mockResolveFormalSpecConfiguration
      .mockResolvedValueOnce({ mode: true, comments: false, modelCheckTimeoutSeconds: 45 })
      .mockResolvedValueOnce(null);

    const result = await interactiveMode('/project', undefined, undefined, 'initial-session');

    expect(result.action).toBe('cancel');
    expect(capture.callCount).toBe(2);
    expect(capture.sessionIds).not.toContain('unapproved-session');
    expect(capture.systemPrompts[1]).toBe(capture.systemPrompts[0]);
    expect(capture.prompts[1]).toContain('after cancellation');
    expect(mockResolveFormalSpecConfiguration).toHaveBeenNthCalledWith(1, '/project');
    expect(mockResolveFormalSpecConfiguration).toHaveBeenNthCalledWith(2, '/project', { allowCancel: true });
  });
  it.each([
    ['assistant', undefined, undefined],
    ['Grill Me', undefined, { assistantMode: 'grill-me' as const }],
    ['resumed assistant', 'existing-session', undefined],
  ] as const)('should resolve formal specification mode once when starting a %s session', async (_label, sessionId, options) => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await interactiveMode('/project', undefined, undefined, sessionId, undefined, options);

    expect(mockResolveFormalSpecConfiguration).toHaveBeenCalledOnce();
    expect(mockResolveFormalSpecConfiguration).toHaveBeenCalledWith('/project');
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
      mockResolveFormalSpecConfiguration
        .mockResolvedValueOnce({ mode: initialFormalSpec, comments: true })
        .mockResolvedValueOnce({ mode: resumedFormalSpec, comments: true });

      await interactiveMode('/project');

      expect(mockResolveFormalSpecConfiguration).toHaveBeenCalledTimes(2);
      expect(mockResolveFormalSpecConfiguration).toHaveBeenNthCalledWith(1, '/project');
      expect(mockResolveFormalSpecConfiguration).toHaveBeenNthCalledWith(2, '/project', { allowCancel: true });
      expect(capture.systemPrompts).toHaveLength(3);
    },
  );

  it('should not resolve formal specification mode again when session selection is cancelled', async () => {
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupMockProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    await interactiveMode('/project');

    expect(mockResolveFormalSpecConfiguration).toHaveBeenCalledOnce();
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)('should update guarded /verify execution after readline resume (%s to %s)', async (initialFormalSpec, resumedFormalSpec) => {
    mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({
      mode: initialFormalSpec,
      comments: true,
      modelCheckTimeoutSeconds: 300,
    });
    mockSelectRecentSession.mockResolvedValue('selected-session');
    setupRawStdin(toRawInputs(['/resume', '/verify', '/cancel']));
    setupMockProvider(resumedFormalSpec
      ? [
        '```quint\nmodule resumedAgreement {}\n```',
        'The resumed specification passed.',
      ]
      : []);

    const plan = createInstructConversationPlan('/project', {
      cwd: '/project',
      branchContext: 'branch context',
      branchName: 'feature/verify',
      taskName: 'verify command',
      taskContent: 'add formal verification',
      retryNote: '',
    });
    const resolveResumedSessionConfiguration = vi.fn().mockResolvedValue({
      systemPrompt: 'resumed system prompt',
      formalSpec: resumedFormalSpec,
      formalSpecComments: true,
      modelCheckTimeoutSeconds: 300,
    });

    const result = await runConversationLoop(
      '/project',
      plan.ctx,
      { ...plan.strategy, resolveResumedSessionConfiguration },
      undefined,
      undefined,
    );

    expect(result.action).toBe('cancel');
    expect(resolveResumedSessionConfiguration).toHaveBeenCalledOnce();
    if (resumedFormalSpec) {
      expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
        '```quint\nmodule resumedAgreement {}\n```',
        '/project',
        { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 300 },
      );
    } else {
      expect(mockInfo).toHaveBeenCalledWith(getLabel('interactive.ui.verifyUnavailable', 'en'));
      expect(mockGetProvider.mock.results[0]?.value?._call).not.toHaveBeenCalled();
      expect(mockRunFormalSpecVerification).not.toHaveBeenCalled();
    }
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

  it('should allow Grill Me to use the same default tools as assistant', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/cancel']));
    const { provider } = createMockProvider(['Which roles may approve?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect((provider as { _call: ReturnType<typeof vi.fn> })._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      }),
    );
  });

  it('should leave Grill Me permission resolution to the configured session', async () => {
    setupRawStdin(toRawInputs(['design an approval flow', '/cancel']));
    const { provider, capture } = createMockProvider(['Which roles may approve?']);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);

    await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      assistantMode: 'grill-me',
    });

    expect(capture.permissionModes).toEqual([undefined]);
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

  it('should reject /verify outside formal specification mode without sending it to the provider', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    setupMockProvider([]);

    const result = await interactiveMode('/project');

    expect(result.action).toBe('cancel');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(getLabel('interactive.ui.verifyUnavailable', 'en'));
  });

  it.each(['codex', 'opencode', 'pi'] as const)('should route /verify through generation and interpretation for %s', async (providerType) => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const generatedResponse = '```quint\nmodule currentAgreement {}\n```\n```alloy\ncheck CurrentAgreement\n```';
    const { provider, capture } = createMockProvider([
      generatedResponse,
      'The current agreement passed verification.',
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });

    const result = await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      provider: providerType,
    });

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(2);
    expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
      generatedResponse,
      '/project',
      { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 300 },
    );
    expect(provider._call.mock.invocationCallOrder[0]).toBeLessThan(mockRunFormalSpecVerification.mock.invocationCallOrder[0]!);
    expect(mockRunFormalSpecVerification.mock.invocationCallOrder[0]).toBeLessThan(provider._call.mock.invocationCallOrder[1]!);
    expect(capture.allowedTools).toEqual(providerType === 'codex' ? [undefined, undefined] : [[], ['Read']]);
    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly', 'strict-readonly']);
    expect(provider._call.mock.calls[1]![1]).toMatchObject({ allowReadonlyFileRead: true });
  });

  it('should reject DeepSeek Harness before specification generation reaches the client', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    mockGetProvider.mockReturnValue(new DeepSeekHarnessProvider());
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });

    const result = await interactiveMode('/project', undefined, undefined, undefined, undefined, {
      provider: 'deepseek-harness',
    });

    expect(result.action).toBe('cancel');
    expect(mockDeepSeekClientCall).not.toHaveBeenCalled();
    expect(mockRunFormalSpecVerification).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DeepSeek Harness cannot honor read-only file access'));
  });

  it.each(['codex', 'opencode', 'pi'] as const)('should display generated specifications before the interpretation when /verify succeeds for %s', async (providerType) => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const generatedResponse = '```quint\nmodule currentAgreement {}\n```\n```alloy\ncheck CurrentAgreement\n```';
    const interpretedResponse = 'Both specifications passed verification.';
    const call = vi.fn<ProviderAgent['call']>()
      .mockImplementationOnce(async (_prompt, options) => {
        const event: StreamEvent = { type: 'text', data: { text: generatedResponse } };
        options.onStream?.(event);
        return { persona: 'test', status: 'done', content: generatedResponse, timestamp: new Date() };
      })
      .mockImplementationOnce(async (_prompt, options) => {
        const event: StreamEvent = { type: 'text', data: { text: interpretedResponse } };
        options.onStream?.(event);
        return { persona: 'test', status: 'done', content: interpretedResponse, timestamp: new Date() };
      });
    const { provider } = createMockProvider([]);
    vi.mocked(provider.setup).mockReturnValue({ call });
    mockGetProvider.mockReturnValue(provider);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    mockRunFormalSpecVerification.mockResolvedValueOnce({
      verdict: 'passed',
      verificationStarted: true,
      message: 'All formal specifications passed.',
      quint: { status: 'passed' },
      alloy: { status: 'passed' },
    });

    const displayMock = vi.mocked(StreamDisplay);
    const originalDisplayImplementation = displayMock.getMockImplementation()!;
    try {
      displayMock.mockImplementation((agentName, quiet, progressInfo) =>
        new TerminalStreamDisplay(agentName, quiet, progressInfo));

      const result = await interactiveMode('/project', undefined, undefined, undefined, undefined, {
        provider: providerType,
      });

      const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(result.action).toBe('cancel');
      expect(output).toContain(generatedResponse);
      expect(output).toContain(interpretedResponse);
      expect(output.indexOf(interpretedResponse)).toBeGreaterThanOrEqual(
        output.indexOf(generatedResponse) + generatedResponse.length,
      );
    } finally {
      displayMock.mockImplementation(originalDisplayImplementation);
    }
  });

  it('should stop the OpenCode /verify flow with an explicit error when the generated response has no formal blocks', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    setupMockProvider(['The current agreement has no formal blocks.']);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    mockRunFormalSpecVerification.mockResolvedValueOnce({
      verdict: 'error',
      verificationStarted: false,
      message: 'No formal specification blocks found.',
      quint: { status: 'skipped' },
      alloy: { status: 'skipped' },
    });

    const result = await interactiveMode('/project', undefined, undefined, undefined, undefined, { provider: 'opencode' });

    expect(result.action).toBe('cancel');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith('No formal specification blocks found.');
  });

  it('should route one /verify command through generation, verification, and interpretation', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const initialAgreement = 'unique-readline-agreement-3c91b7';
    const verificationMessage = 'unique-readline-verification-message-42f0ac';
    const generatedResponse = '```quint\nmodule currentAgreement {}\n```\n```alloy\ncheck CurrentAgreement\n```';
    const { provider, capture } = createMockProvider([
      generatedResponse,
      'The current agreement passed verification.',
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    mockRunFormalSpecVerification.mockResolvedValueOnce({
      verdict: 'failed',
      verificationStarted: true,
      message: verificationMessage,
      quint: { status: 'failed', message: verificationMessage },
      alloy: { status: 'skipped' },
    });

    const result = await interactiveMode('/project', { userMessage: initialAgreement });

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(2);
    expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
      generatedResponse,
      '/project',
      { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 300 },
    );
    expect(capture.prompts[0]).toContain('<initial-user-input>');
    expect(capture.prompts[0]).toContain(initialAgreement);
    expect(capture.prompts[0]).toContain('</initial-user-input>');
    expect(capture.prompts[1]).toContain(verificationMessage);
    expect(capture.allowedTools).toEqual([[], ['Read']]);
    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly', 'strict-readonly']);
  });

  it('should not retry a failed existing session during formal generation', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const { provider, capture } = createScenarioProvider([
      { content: 'formal generation failed', status: 'error' },
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });

    const result = await interactiveMode('/project', undefined, undefined, 'stale-formal-session');

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(1);
    expect(capture.sessionIds).toEqual(['stale-formal-session']);
    expect(capture.allowedTools).toEqual([[]]);
    expect(capture.permissionModes).toEqual(['readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly']);
  });

  it('should not retry a failed existing session during formal interpretation', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const generatedResponse = '```quint\nmodule currentAgreement {}\n```';
    const { provider, capture } = createScenarioProvider([
      { content: generatedResponse, sessionId: 'formal-generation-session' },
      { content: 'formal interpretation failed', status: 'error' },
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });

    const result = await interactiveMode('/project');

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(2);
    expect(capture.sessionIds).toEqual([undefined, 'formal-generation-session']);
    expect(capture.allowedTools).toEqual([[], ['Read']]);
    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly', 'strict-readonly']);
  });

  it('should abort the verifier on SIGINT before starting interpretation', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const { provider } = createMockProvider([
      '```quint\nmodule currentAgreement {}\n```',
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    let verificationSignal: AbortSignal | undefined;
    mockRunFormalSpecVerification.mockImplementationOnce(async (...args: unknown[]) => {
      verificationSignal = (args[2] as { abortSignal: AbortSignal }).abortSignal;
      process.emit('SIGINT');
      verificationSignal.throwIfAborted();
      return {
        verdict: 'passed' as const,
        verificationStarted: true,
        quint: { status: 'passed' as const },
        alloy: { status: 'skipped' as const },
      };
    });

    const result = await interactiveMode('/project');

    expect(result.action).toBe('cancel');
    expect(verificationSignal).toBeInstanceOf(AbortSignal);
    expect(verificationSignal?.aborted).toBe(true);
    expect(provider._call).toHaveBeenCalledOnce();
  });

  it('should interpret a failed verification once without automatically verifying again', async () => {
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const generatedResponse = '```quint\nmodule currentAgreement {}\n```';
    const { provider } = createMockProvider([
      generatedResponse,
      'The generated specification has a counterexample; use this corrected block.',
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfiguration.mockResolvedValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    mockRunFormalSpecVerification.mockResolvedValueOnce({
      verdict: 'failed',
      verificationStarted: true,
      quint: { status: 'failed', message: 'counterexample' },
      alloy: { status: 'skipped' },
    });

    const result = await interactiveMode('/project');

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(2);
    expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
      generatedResponse,
      '/project',
      { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 300 },
    );
  });

  it('should route an enabled task-action /verify through the readline verifier with its task content', async () => {
    mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 300 });
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    setupMockProvider([
      '```quint\nmodule taskActionAgreement {}\n```',
      'The task-action specification passed.',
    ]);

    const plan = createInstructConversationPlan('/project', {
      cwd: '/project',
      branchContext: 'branch context',
      branchName: 'feature/verify',
      taskName: 'verify command',
      taskContent: 'add formal verification',
      retryNote: '',
    });
    const result = await runConversationLoop(
      '/project',
      plan.ctx,
      plan.strategy,
      undefined,
      undefined,
    );

    expect(result.action).toBe('cancel');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(2);
    expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
      '```quint\nmodule taskActionAgreement {}\n```',
      '/project',
      { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 300 },
    );
  });

  it('should route direct instruct /verify through the verifier', async () => {
    const taskContent = '形式仕様検証を追加する';
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    const { provider } = createMockProvider([
      '```quint\nmodule directInstructAgreement {}\n```',
      'The direct instruct specification passed.',
    ]);
    mockGetProvider.mockReturnValue(provider as ReturnType<typeof getProvider>);
    mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({ mode: true, comments: true, modelCheckTimeoutSeconds: 17 });

    const result = await runDirectInstructMode({
      cwd: '/project',
      runSlug: 'direct-instruct-verify',
      taskContent,
      workflowContext: {
        name: 'default',
        description: '',
        workflowStructure: '',
        stepPreviews: [],
      },
      runSessionContext: {
        task: taskContent,
        workflow: 'default',
        status: 'aborted',
        stepLogs: [],
        reports: [],
      },
      previousOrderContent: null,
    });

    expect(result.action).toBe('cancel');
    expect(provider._call).toHaveBeenCalledTimes(2);
    expect(mockRunFormalSpecVerification).toHaveBeenCalledWith(
      '```quint\nmodule directInstructAgreement {}\n```',
      '/project',
      { abortSignal: expect.any(AbortSignal), modelCheckTimeoutSeconds: 17 },
    );
  });

  it('should reject an unavailable task-action /verify before the readline provider or verifier', async () => {
    mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({ mode: false, comments: true, modelCheckTimeoutSeconds: 300 });
    setupRawStdin(toRawInputs(['/verify', '/cancel']));
    setupMockProvider([]);

    const plan = createInstructConversationPlan('/project', {
      cwd: '/project',
      branchContext: 'branch context',
      branchName: 'feature/verify',
      taskName: 'verify command',
      taskContent: 'add formal verification',
      retryNote: '',
    });
    const result = await runConversationLoop(
      '/project',
      plan.ctx,
      plan.strategy,
      undefined,
      undefined,
    );

    expect(result.action).toBe('cancel');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).not.toHaveBeenCalled();
    expect(mockRunFormalSpecVerification).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(getLabel('interactive.ui.verifyUnavailable', 'en'));
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

    it('should reopen the action menu after a cancelled save and keep the confirmed task and attachments', async () => {
      const attachment = {
        placeholder: '[Image #1]',
        tempPath: '/tmp/interactive-image.png',
        fileName: 'image-1.png',
      };
      setupRawStdin(toRawInputs(['/go', '/cancel']));
      setupMockProvider(['Summarized task.']);
      mockSelectOption
        .mockResolvedValueOnce('save_task')
        .mockResolvedValueOnce('save_task')
        .mockResolvedValueOnce('continue');
      const dispatch = vi.fn().mockResolvedValue({ kind: 'cancelled' });
      const dispatchOptions = {
        dispatch,
      } as NonNullable<Parameters<typeof interactiveMode>[5]> & { dispatch: typeof dispatch };

      const result = await interactiveMode(
        '/project',
        { userMessage: 'Confirmed instruction', attachments: [attachment] },
        undefined,
        undefined,
        undefined,
        dispatchOptions,
      );

      try {
        expect(result.action).toBe('cancel');
        expect(mockSelectOption).toHaveBeenCalledTimes(3);
        expect(mockSelectOption.mock.calls[1]?.[0]).toBe(mockSelectOption.mock.calls[0]?.[0]);
        expect(mockSelectOption.mock.calls[1]?.[1]).toEqual(mockSelectOption.mock.calls[0]?.[1]);
        expect(mockSelectOption.mock.calls[2]?.[0]).toBe(mockSelectOption.mock.calls[0]?.[0]);
        expect(mockSelectOption.mock.calls[2]?.[1]).toEqual(mockSelectOption.mock.calls[0]?.[1]);
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
          action: 'save_task',
          task: 'Summarized task.',
          attachments: [attachment],
        }));
        expect(dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
          action: 'save_task',
          task: 'Summarized task.',
          attachments: [attachment],
        }));
      } finally {
        result.cleanupAttachments?.();
      }
    });

    it.each(['execute', 'create_issue'] as const)(
      'should dispatch %s when it is selected after a cancelled save',
      async (action) => {
        const attachment = {
          placeholder: '[Image #1]',
          tempPath: '/tmp/interactive-image.png',
          fileName: 'image-1.png',
        };
        setupRawStdin(toRawInputs(['/go', '/cancel']));
        setupMockProvider(['Summarized task.']);
        mockSelectOption
          .mockResolvedValueOnce('save_task')
          .mockResolvedValueOnce(action);
        const dispatch = vi.fn()
          .mockResolvedValueOnce({ kind: 'cancelled' })
          .mockResolvedValueOnce({ kind: 'dispatched' });
        const dispatchOptions = {
          dispatch,
        } as NonNullable<Parameters<typeof interactiveMode>[5]> & { dispatch: typeof dispatch };

        const result = await interactiveMode(
          '/project',
          { userMessage: 'Confirmed instruction', attachments: [attachment] },
          undefined,
          undefined,
          undefined,
          dispatchOptions,
        );

        try {
          expect(mockSelectOption).toHaveBeenCalledTimes(2);
          expect(dispatch).toHaveBeenCalledTimes(2);
          expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
            action: 'save_task',
            task: 'Summarized task.',
            attachments: [attachment],
          }));
          expect(dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
            action,
            task: 'Summarized task.',
            attachments: [attachment],
          }));
        } finally {
          result.cleanupAttachments?.();
        }
      },
    );

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
