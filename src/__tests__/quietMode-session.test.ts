/**
 * Tests for quietMode summary AI session isolation.
 *
 * Verifies that the summary AI call in quietMode does not inherit the
 * conversation session (sessionId must be undefined), even when ctx
 * carries an active sessionId. This matches the fix already applied to
 * conversationLoop.ts's /go command.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../features/interactive/conversationLoop.js', () => ({
  initializeSession: vi.fn(),
  callAIWithRetry: vi.fn(),
}));

vi.mock('../features/interactive/interactive.js', () => ({
  DEFAULT_INTERACTIVE_TOOLS: ['Read'],
  buildSummaryPrompt: vi.fn(),
  selectPostSummaryAction: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((_key: string, _lang: string) => 'Mock label'),
  getLabelObject: vi.fn(() => ({
    intro: 'Intro',
    proposed: 'Proposed:',
    cancelled: 'Cancelled',
  })),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { quietMode } from '../features/interactive/quietMode.js';
import { initializeSession, callAIWithRetry } from '../features/interactive/conversationLoop.js';
import { buildSummaryPrompt, selectPostSummaryAction } from '../features/interactive/interactive.js';
import type { SessionContext } from '../features/interactive/conversationLoop.js';

const mockInitializeSession = vi.mocked(initializeSession);
const mockCallAIWithRetry = vi.mocked(callAIWithRetry);
const mockBuildSummaryPrompt = vi.mocked(buildSummaryPrompt);
const mockSelectPostSummaryAction = vi.mocked(selectPostSummaryAction);

// ── Helpers ───────────────────────────────────────────────────────────

function createMockSessionContext(sessionId: string | undefined): SessionContext {
  return {
    provider: {} as SessionContext['provider'],
    providerType: 'mock' as SessionContext['providerType'],
    model: undefined,
    lang: 'en',
    personaName: 'interactive',
    sessionId,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// =================================================================
// quietMode: summary AI session isolation
// =================================================================

describe('quietMode: summary AI session isolation', () => {
  it('should pass sessionId as undefined to callAIWithRetry even when ctx carries an active sessionId', async () => {
    // Given: initializeSession returns a ctx with an active session
    const ctxWithSession = createMockSessionContext('active-session-123');
    mockInitializeSession.mockReturnValue(ctxWithSession);

    // Given: buildSummaryPrompt returns a non-null prompt
    mockBuildSummaryPrompt.mockReturnValue('Summary prompt for task');

    // Given: callAIWithRetry returns a successful result
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: '## Fix the bug\nDetails here', success: true, sessionId: undefined },
      sessionId: undefined,
    });

    // Given: user selects execute action
    mockSelectPostSummaryAction.mockResolvedValue('execute');

    // When
    const result = await quietMode('/test/cwd', 'fix the bug');

    // Then: callAIWithRetry was called exactly once
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();

    // Then: 5th argument (ctx) must NOT inherit the conversation sessionId
    const calledCtx = mockCallAIWithRetry.mock.calls[0]![4] as SessionContext;
    expect(calledCtx.sessionId).toBeUndefined();

    // Then: result is as expected
    expect(result.action).toBe('execute');
  });

  it('should preserve other ctx fields while clearing sessionId', async () => {
    // Given: ctx with active session and specific lang
    const ctxWithSession = createMockSessionContext('session-xyz');
    ctxWithSession.lang = 'ja';
    mockInitializeSession.mockReturnValue(ctxWithSession);
    mockBuildSummaryPrompt.mockReturnValue('要約プロンプト');
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: '## タスク\n詳細', success: true, sessionId: undefined },
      sessionId: undefined,
    });
    mockSelectPostSummaryAction.mockResolvedValue('execute');

    // When
    await quietMode('/test/cwd', 'バグを修正する');

    // Then: sessionId is cleared but other fields are preserved
    const calledCtx = mockCallAIWithRetry.mock.calls[0]![4] as SessionContext;
    expect(calledCtx.sessionId).toBeUndefined();
    expect(calledCtx.lang).toBe('ja');
    expect(calledCtx.personaName).toBe('interactive');
  });

  it('should return cancel when callAIWithRetry returns null result', async () => {
    // Given
    mockInitializeSession.mockReturnValue(createMockSessionContext('session-abc'));
    mockBuildSummaryPrompt.mockReturnValue('Summary prompt');
    mockCallAIWithRetry.mockResolvedValue({ result: null, sessionId: undefined });

    // When
    const result = await quietMode('/test/cwd', 'some input');

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return cancel when buildSummaryPrompt returns null', async () => {
    // Given: no conversation history leads to null prompt
    mockInitializeSession.mockReturnValue(createMockSessionContext(undefined));
    mockBuildSummaryPrompt.mockReturnValue(null);

    // When
    const result = await quietMode('/test/cwd', 'some input');

    // Then: short-circuits before callAIWithRetry
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});
