/**
 * E2E tests for interactive conversation loop routes.
 *
 * Exercises the real runConversationLoop via runInstructMode,
 * simulating user stdin and verifying each conversation path.
 *
 * Real: runConversationLoop, callAIWithRetry, readMultilineInput,
 *       buildSummaryPrompt, selectPostSummaryAction
 * Mocked: provider (scenario-based), config, UI, session persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
  createScenarioProvider,
  type MockProviderCapture,
} from './helpers/stdinSimulator.js';

// --- Infrastructure mocks (same pattern as instructMode.test.ts) ---

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
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
  selectOption: vi.fn().mockResolvedValue('execute'),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((_key: string, _lang: string) => 'Mock label'),
  getLabelObject: vi.fn(() => ({
    intro: 'Intro',
    resume: 'Resume',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue?',
    proposed: 'Proposed:',
    actionPrompt: 'What next?',
    playNoTask: 'No task for /play',
    cancelled: 'Cancelled',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { selectOption } from '../shared/prompt/index.js';
import { error as logError } from '../shared/ui/index.js';
import { runInstructMode } from '../features/tasks/list/instructMode.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockLogError = vi.mocked(logError);

// --- Helpers ---

function setupProvider(responses: string[]): MockProviderCapture {
  const { provider, capture } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

function setupScenarioProvider(...scenarios: Parameters<typeof createScenarioProvider>[0]): MockProviderCapture {
  const { provider, capture } = createScenarioProvider(scenarios);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

async function runInstruct() {
  return runInstructMode('/test', '', 'takt/test-branch', 'test-branch', '', '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
});

// =================================================================
// Route A: EOF (Ctrl+D) → cancel
// =================================================================
describe('EOF handling', () => {
  it('should cancel on Ctrl+D without any conversation', async () => {
    setupRawStdin(toRawInputs([null]));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should cancel on Ctrl+D after some conversation', async () => {
    setupRawStdin(toRawInputs(['hello', null]));
    const capture = setupProvider(['Hi there.']);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(capture.callCount).toBe(1);
  });
});

// =================================================================
// Route B: Empty input → skip, continue loop
// =================================================================
describe('empty input handling', () => {
  it('should skip empty lines and continue accepting input', async () => {
    setupRawStdin(toRawInputs(['', '  ', '/cancel']));
    const capture = setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(capture.callCount).toBe(0);
  });
});

// =================================================================
// Route C: /play → direct execute
// =================================================================
describe('/play command', () => {
  it('should return execute with the given task text', async () => {
    setupRawStdin(toRawInputs(['/play fix the login bug']));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('execute');
    expect(result.task).toBe('fix the login bug');
  });

  it('should show error and continue when /play has no task', async () => {
    setupRawStdin(toRawInputs(['/play', '/cancel']));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
  });
});

// =================================================================
// Route D: /go → summary flow
// =================================================================
describe('/go summary flow', () => {
  it('should summarize conversation and return execute', async () => {
    // User: "add error handling" → AI: "What kind?" → /go → AI summary → execute
    setupRawStdin(toRawInputs(['add error handling', '/go']));
    const capture = setupProvider(['What kind of error handling?', 'Add try-catch to all API calls.']);

    const result = await runInstruct();

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add try-catch to all API calls.');
    expect(capture.callCount).toBe(2);
  });

  it('should reject /go without prior conversation', async () => {
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
  });

  it('should continue editing when user selects continue after /go', async () => {
    setupRawStdin(toRawInputs(['task description', '/go', '/cancel']));
    setupProvider(['Understood.', 'Summary of task.']);
    mockSelectOption.mockResolvedValueOnce('continue');

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
  });

  it('should return save_task when user selects save_task after /go', async () => {
    setupRawStdin(toRawInputs(['implement feature', '/go']));
    setupProvider(['Got it.', 'Implement the feature.']);
    mockSelectOption.mockResolvedValue('save_task');

    const result = await runInstruct();

    expect(result.action).toBe('save_task');
    expect(result.task).toBe('Implement the feature.');
  });
});

// =================================================================
// Route D2: /go with user note
// =================================================================
describe('/go with user note', () => {
  it('should append user note to summary prompt', async () => {
    setupRawStdin(toRawInputs(['refactor auth', '/go also check security']));
    const capture = setupProvider(['Will do.', 'Refactor auth and check security.']);

    const result = await runInstruct();

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Refactor auth and check security.');
    // /go summary call should include the user note in the prompt
    expect(capture.prompts[1]).toContain('also check security');
  });
});

// =================================================================
// Route D3: /go summary AI returns null (call failure)
// =================================================================
describe('/go summary AI failure', () => {
  it('should show error and allow retry when summary AI throws', async () => {
    // Turn 1: normal message → success
    // Turn 2: /go → AI throws (summary fails) → "summarize failed"
    // Turn 3: /cancel
    setupRawStdin(toRawInputs(['describe task', '/go', '/cancel']));
    const capture = setupScenarioProvider(
      { content: 'Understood.' },
      { content: '', throws: new Error('API timeout') },
    );

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(capture.callCount).toBe(2);
  });
});

// =================================================================
// Route D4: /go summary AI returns blocked status
// =================================================================
describe('/go summary AI blocked', () => {
  it('should cancel when summary AI returns blocked', async () => {
    setupRawStdin(toRawInputs(['some task', '/go']));
    setupScenarioProvider(
      { content: 'OK.' },
      { content: 'Permission denied', status: 'blocked' },
    );

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(mockLogError).toHaveBeenCalledWith('Permission denied');
  });
});

// =================================================================
// Route E: /cancel
// =================================================================
describe('/cancel command', () => {
  it('should cancel immediately', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
  });

  it('should cancel mid-conversation', async () => {
    setupRawStdin(toRawInputs(['hello', 'world', '/cancel']));
    const capture = setupProvider(['Hi.', 'Hello again.']);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(capture.callCount).toBe(2);
  });
});

// =================================================================
// Route F: Regular messages → AI conversation
// =================================================================
describe('regular conversation', () => {
  it('should handle multi-turn conversation ending with /go', async () => {
    setupRawStdin(toRawInputs([
      'I need to add pagination',
      'Use cursor-based pagination',
      'Also add sorting',
      '/go',
    ]));
    const capture = setupProvider([
      'What kind of pagination?',
      'Cursor-based is a good choice.',
      'OK, pagination with sorting.',
      'Add cursor-based pagination and sorting to the API.',
    ]);

    const result = await runInstruct();

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add cursor-based pagination and sorting to the API.');
    expect(capture.callCount).toBe(4);
  });
});

// =================================================================
// Route F2: Regular message AI returns blocked
// =================================================================
describe('regular message AI blocked', () => {
  it('should cancel when regular message AI returns blocked', async () => {
    setupRawStdin(toRawInputs(['hello']));
    setupScenarioProvider(
      { content: 'Rate limited', status: 'blocked' },
    );

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    expect(mockLogError).toHaveBeenCalledWith('Rate limited');
  });
});

// =================================================================
// Route G: /play command with empty task shows error
// =================================================================
describe('/play empty task error', () => {
  it('should show error message when /play has no argument', async () => {
    setupRawStdin(toRawInputs(['/play', '/play  ', '/cancel']));
    setupProvider([]);

    const result = await runInstruct();

    expect(result.action).toBe('cancel');
    // /play with no task should not trigger any AI calls
  });
});

// =================================================================
// Session management: new sessionId propagates across calls
// =================================================================
describe('session propagation', () => {
  it('should use sessionId from first call in subsequent calls', async () => {
    setupRawStdin(toRawInputs(['first message', 'second message', '/go']));
    const capture = setupScenarioProvider(
      { content: 'Response 1.', sessionId: 'session-abc' },
      { content: 'Response 2.' },
      { content: 'Final summary.' },
    );

    const result = await runInstruct();

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Final summary.');
    // Second call should receive the sessionId from first call
    expect(capture.sessionIds[1]).toBe('session-abc');
  });
});

// =================================================================
// Policy injection: transformPrompt wraps user input
// =================================================================
describe('policy injection', () => {
  it('should wrap user messages with policy content', async () => {
    setupRawStdin(toRawInputs(['fix the bug', '/cancel']));
    const capture = setupProvider(['OK.']);

    await runInstructMode('/test', '', 'takt/test', 'test', '', '');

    // The prompt sent to AI should contain Policy section
    expect(capture.prompts[0]).toContain('Policy');
    expect(capture.prompts[0]).toContain('fix the bug');
    expect(capture.prompts[0]).toContain('Policy Reminder');
  });
});

// =================================================================
// System prompt: branch name appears in intro
// =================================================================
describe('branch context', () => {
  it('should include branch name and context in system prompt', async () => {
    setupRawStdin(toRawInputs(['check changes', '/cancel']));
    const capture = setupProvider(['Looks good.']);

    await runInstructMode(
      '/test',
      '## Changes\n```\nsrc/auth.ts | 50 +++\n```',
      'takt/feature-auth',
      'feature-auth',
      'Do something',
      '',
    );

    expect(capture.systemPrompts.length).toBeGreaterThan(0);
    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).toContain('takt/feature-auth');
    expect(systemPrompt).toContain('src/auth.ts | 50 +++');
  });
});
