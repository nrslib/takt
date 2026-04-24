/**
 * Tests for /resume command and initializeSession changes.
 *
 * Verifies:
 * - initializeSession returns sessionId: undefined (no implicit auto-load)
 * - /resume command calls selectRecentSession and updates sessionId
 * - /resume with cancel does not change sessionId
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

const { mockResolveAssistantConfigLayers } = vi.hoisted(() => ({
  mockResolveAssistantConfigLayers: vi.fn(() => ({
    local: { provider: 'mock' },
    global: {},
  })),
}));

// --- Infrastructure mocks ---

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(() => ({ language: 'en', provider: 'mock', model: undefined })),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => mockLogger,
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

const mockSelectRecentSession = vi.fn<(cwd: string, lang: 'en' | 'ja') => Promise<string | null>>();

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: [string, 'en' | 'ja']) => mockSelectRecentSession(...args),
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
    retryNoOrder: 'No previous order found.',
    retryUnavailable: '/retry is not available in this mode.',
    cancelled: 'Cancelled',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { selectOption } from '../shared/prompt/index.js';
import { info as logInfo } from '../shared/ui/index.js';
import { runConversationLoop, type SessionContext } from '../features/interactive/conversationLoop.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockLogInfo = vi.mocked(logInfo);

// --- Helpers ---

function setupProvider(responses: string[]): MockProviderCapture {
  const { provider, capture } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

function createSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  const { provider } = createMockProvider([]);
  mockGetProvider.mockReturnValue(provider);
  return {
    provider: provider as SessionContext['provider'],
    providerType: 'mock' as SessionContext['providerType'],
    model: undefined,
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
    ...overrides,
  };
}

const defaultStrategy = {
  systemPrompt: 'test system prompt',
  allowedTools: ['Read'],
  transformPrompt: (msg: string) => msg,
  introMessage: 'Test intro',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
  mockSelectRecentSession.mockResolvedValue(null);
  mockResolveAssistantConfigLayers.mockReturnValue({
    local: { provider: 'mock' },
    global: {},
  });
});

afterEach(() => {
  restoreStdin();
});

// =================================================================
// initializeSession: no implicit session auto-load
// =================================================================
describe('initializeSession', () => {
  it('should return sessionId as undefined (no implicit auto-load)', () => {
    const ctx = initializeSession('/test/cwd', 'interactive');

    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.personaName).toBe('interactive');
  });
});

// =================================================================
// /resume command
// =================================================================
describe('/resume command', () => {
  it('should call selectRecentSession and update sessionId when session selected', async () => {
    // Given: /resume → select session → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue('selected-session-abc');

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: selectRecentSession called
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');

    // Then: info about loaded session displayed
    expect(mockLogInfo).toHaveBeenCalledWith('Mock label');

    // Then: cancelled at the end
    expect(result.action).toBe('cancel');
  });

  it('should not change sessionId when user cancels session selection', async () => {
    // Given: /resume → cancel selection → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: selectRecentSession called but returned null
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');

    // Then: cancelled
    expect(result.action).toBe('cancel');
  });

  it('should use resumed session for subsequent AI calls', async () => {
    // Given: /resume → select session → send message → /cancel
    setupRawStdin(toRawInputs(['/resume', 'hello world', '/cancel']));
    mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: AI call should use the resumed session ID
    expect(capture.sessionIds[0]).toBe('resumed-session-xyz');
    expect(result.action).toBe('cancel');
  });

  it('should reject /retry in non-retry mode', async () => {
    setupRawStdin(toRawInputs(['/retry', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(mockLogInfo).toHaveBeenCalledWith('/retry is not available in this mode.');
    expect(result.action).toBe('cancel');
  });

  it('should complete /r to /resume when retry and replay are unavailable', async () => {
    // Given: /r → Tab → Enter completes to /resume, then /cancel exits
    setupRawStdin(toRawInputs(['/r\t', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');
    expect(result.action).toBe('cancel');
  });

  it('should complete /r to /retry when retry is available', async () => {
    // Given: /r → Tab → Enter completes to /retry, then /cancel exits
    setupRawStdin(toRawInputs(['/r\t', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enableRetryCommand: true,
    }, undefined, undefined);

    // Then
    expect(mockLogInfo).toHaveBeenCalledWith('No previous order found.');
    expect(mockSelectRecentSession).not.toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});

// =================================================================
// /go command: summary AI session isolation
// =================================================================
describe('/go command', () => {
  it('should pass sessionId as undefined to summary AI even when conversation has an active session', async () => {
    // Given: send message (AI responds with sessionId) → /go triggers summary
    setupRawStdin(toRawInputs(['hello', '/go']));

    const { provider, capture } = createScenarioProvider([
      // Call 0: user message → AI responds and sets sessionId
      { content: 'AI response', sessionId: 'session-abc' },
      // Call 1: /go summary → should NOT inherit sessionId
      { content: '## Fix broken title\nDetails here' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: first AI call had no session (initial state)
    expect(capture.sessionIds[0]).toBeUndefined();
    // Then: summary call must NOT inherit the conversation session
    expect(capture.sessionIds[1]).toBeUndefined();
    expect(result.action).toBe('execute');
  });
});

describe('conversation logging', () => {
  it('should log only non-sensitive metadata for initial input, session state, and play task', async () => {
    setupRawStdin(toRawInputs(['/play secret implementation details']));
    setupProvider([]);

    const ctx = createSessionContext({ sessionId: 'sensitive-session-id' });

    const result = await runConversationLoop(
      '/test',
      ctx,
      defaultStrategy,
      undefined,
      { sourceContext: 'secret prefilled input' },
    );

    expect(result).toEqual({
      action: 'execute',
      task: 'secret implementation details',
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Loaded initial input as source context without auto-submitting to AI',
      {
        hasInitialInput: true,
        initialInputLength: 'secret prefilled input'.length,
        hasSession: true,
      },
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Play command', {
      hasTaskText: true,
      taskLength: 'secret implementation details'.length,
    });
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'Loaded initial input as source context without auto-submitting to AI',
      expect.objectContaining({
        initialInput: 'secret prefilled input',
      }),
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'Sending to AI',
      expect.objectContaining({
        sessionId: 'sensitive-session-id',
      }),
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'Play command',
      expect.objectContaining({
        task: 'secret implementation details',
      }),
    );
  });
});
