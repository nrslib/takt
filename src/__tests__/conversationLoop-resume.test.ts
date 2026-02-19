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

// --- Infrastructure mocks ---

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
import { initializeSession, runConversationLoop, type SessionContext } from '../features/interactive/conversationLoop.js';

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
});
