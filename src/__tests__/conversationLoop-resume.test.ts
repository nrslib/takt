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
  resolveAssistantProviderModelFromConfig as realResolveAssistantProviderModelFromConfig,
  type AssistantCliOverrides,
  type AssistantProviderConfig,
} from '../core/config/provider-resolution.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
  createScenarioProvider,
  type MockProviderCapture,
} from './helpers/stdinSimulator.js';

const { mockResolveAssistantConfigLayers } = vi.hoisted(() => ({
  mockResolveAssistantConfigLayers: vi.fn((_projectDir: string): AssistantProviderConfig => ({
    local: { provider: 'mock' },
    global: {},
  })),
}));

const { mockUpdatePersonaSession } = vi.hoisted(() => ({
  mockUpdatePersonaSession: vi.fn(),
}));

const { mockGetGitProvider, mockRunAssistantRetryCommand, mockRunFormalSpecVerification } = vi.hoisted(() => ({
  mockGetGitProvider: vi.fn(),
  mockRunAssistantRetryCommand: vi.fn(),
  mockRunFormalSpecVerification: vi.fn(),
}));

// --- Infrastructure mocks ---

vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed' })),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(() => ({ language: 'en', provider: 'mock', model: undefined })),
  resolveNonWorkflowProviderOptions: vi.fn(() => ({
    codex: { skills: { repo: false, user: false } },
  })),
  takeSessionState: vi.fn(() => null),
  updatePersonaSession: mockUpdatePersonaSession,
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (projectDir: string) => mockResolveAssistantConfigLayers(projectDir),
  resolveAssistantProviderModel: (projectDir: string, cliOverrides?: AssistantCliOverrides) =>
    realResolveAssistantProviderModelFromConfig(
      mockResolveAssistantConfigLayers(projectDir),
      cliOverrides,
    ),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: (...args: unknown[]) => mockGetGitProvider(...args),
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
  selectOption: vi.fn().mockResolvedValue('execute'),
}));

const mockSelectRecentSession = vi.fn<(cwd: string, lang: 'en' | 'ja') => Promise<string | null>>();

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: [string, 'en' | 'ja']) => mockSelectRecentSession(...args),
}));

vi.mock('../features/interactive/assistantRetryCommand.js', () => ({
  runAssistantRetryCommand: (...args: unknown[]) => mockRunAssistantRetryCommand(...args),
}));

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: (...args: unknown[]) => mockRunFormalSpecVerification(...args),
  cleanupFormalSpecVerificationArtifacts: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string, _lang: string, variables?: Record<string, string>) => (
    key === 'interactive.issueCommand.fetched'
      ? `Fetched Issues: ${variables?.issues ?? ''}. Source Context replaced.`
      : 'Mock label'
  )),
  getLabelObject: vi.fn(() => ({
    intro: 'Intro',
    resume: 'Resume',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue?',
    proposed: 'Proposed:',
    actionPrompt: 'What next?',
    retryNoOrder: 'No previous order found.',
    cancelled: 'Cancelled',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { selectOption } from '../shared/prompt/index.js';
import { error as logError, info as logInfo } from '../shared/ui/index.js';
import { callAIWithRetry, runConversationLoop, type SessionContext } from '../features/interactive/conversationLoop.js';
import * as interactiveModule from '../features/interactive/interactive.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import { SlashCommand } from '../shared/constants.js';
import type { GitProvider, Issue } from '../infra/git/index.js';
import type { SummaryPromptOptions } from '../features/interactive/conversationLoop.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockLogInfo = vi.mocked(logInfo);
const mockLogError = vi.mocked(logError);

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
  formalSpec: false,
  modelCheckTimeoutSeconds: 300,
  transformPrompt: (msg: string) => msg,
  introMessage: 'Test intro',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGitProvider.mockReset();
  mockSelectOption.mockResolvedValue('execute');
  mockSelectRecentSession.mockResolvedValue(null);
  mockRunFormalSpecVerification.mockResolvedValue({
    verdict: 'passed',
    verificationStarted: true,
    quint: { status: 'passed' },
    alloy: { status: 'passed' },
  });
  mockResolveAssistantConfigLayers.mockReturnValue({
    local: { provider: 'mock' },
    global: {},
  });
});

afterEach(() => {
  restoreStdin();
});

function createMissingImageAttachment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-missing-image-'));
  const tempPath = path.join(tempDir, 'missing-image.png');
  fs.rmSync(tempDir, { recursive: true, force: true });
  return {
    placeholder: '[Image #1]',
    tempPath,
    fileName: 'image-1.png',
  };
}

function createIssue(number: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    labels: [],
    comments: [],
  };
}

function formattedIssue(number: number): string {
  return `## Issue #${number}: Issue ${number}\n\nBody ${number}`;
}

function setupIssueProvider(options: {
  cliAvailable?: boolean;
  unavailableError?: string;
  failingIssueNumbers?: readonly number[];
} = {}) {
  const checkCliStatus = vi.fn((_cwd?: string) => options.cliAvailable === false
    ? { available: false as const, error: options.unavailableError ?? 'gh is unavailable' }
    : { available: true as const });
  const fetchIssue = vi.fn((number: number, _cwd?: string): Issue => {
    if (options.failingIssueNumbers?.includes(number)) {
      throw new Error(`Issue #${number} was not found`);
    }
    return createIssue(number);
  });
  mockGetGitProvider.mockReturnValue({
    checkCliStatus,
    fetchIssue,
  } as unknown as GitProvider);
  return { checkCliStatus, fetchIssue };
}

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

describe('callAIWithRetry', () => {
  it('does not persist a returned session when persistence is disabled', async () => {
    const { provider } = createScenarioProvider([
      { content: 'summary', sessionId: 'summary-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'grill-me-interactive',
      sessionId: undefined,
    };

    const { sessionId } = await callAIWithRetry(
      'summarize',
      'summary prompt',
      [],
      '/repo',
      ctx,
      { persistSession: false },
    );

    expect(sessionId).toBe('summary-session');
    expect(mockUpdatePersonaSession).not.toHaveBeenCalled();
  });

  it('passes session provider options to the initial call and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ]);
    const providerOptions = { claude: { effort: 'high' as const } };
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'claude',
      model: 'opus',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
      providerOptions,
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx);

    expect(capture.providerOptions).toEqual([providerOptions, providerOptions]);
    expect(capture.internalAgentIsolations).toEqual([undefined, undefined]);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
  });

  it('passes permission mode to the initial call and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex',
      model: 'gpt-5',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };

    await callAIWithRetry('hello', 'base system prompt', [], '/repo', ctx, {
      permissionMode: 'readonly',
    });

    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
  });

  it('passes strict tool-free isolation to the initial call and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'claude',
      model: 'opus',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };

    await callAIWithRetry('verify', 'formal system prompt', [], '/repo', ctx, {
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    expect(capture.allowedTools).toEqual([[], []]);
    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly', 'strict-readonly']);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
  });

  it('does not drop resumed conversation context after a failed session call', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'session could not be resumed', status: 'error' },
      { content: 'unexpected context-free response', sessionId: 'fresh-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'claude-terminal',
      model: undefined,
      lang: 'en',
      personaName: 'assistant',
      sessionId: 'resumed-session',
      disableSessionRetry: true,
    };

    const { result } = await callAIWithRetry('choose the task', 'selection prompt', [], '/repo', ctx, {
      persistSession: false,
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    expect(result).toMatchObject({ success: false, content: 'session could not be resumed' });
    expect(capture.sessionIds).toEqual(['resumed-session']);
    expect(capture.allowedTools).toEqual([[]]);
    expect(capture.permissionModes).toEqual(['readonly']);
    expect(capture.internalAgentIsolations).toEqual(['strict-readonly']);
  });

  it('forwards explicit DeepSeek tool allowlists to the provider guard', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'done', sessionId: 'deepseek-session' },
    ]);
    const deepseekProvider = provider as SessionContext['provider'] & {
      supportsPermissionControls: () => boolean;
    };
    deepseekProvider.supportsPermissionControls = () => false;
    mockGetProvider.mockReturnValue(deepseekProvider);
    const ctx: SessionContext = {
      provider: deepseekProvider,
      providerType: 'deepseek-harness' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx, {
      permissionMode: 'readonly',
      outputMode: 'silent',
    });

    expect(capture.allowedTools).toEqual([['Read']]);
    expect(capture.permissionModes).toEqual(['readonly']);
  });

  it('retains an explicit session permission mode for an unsupported provider', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'done', sessionId: 'deepseek-session' },
    ]);
    const deepseekProvider = provider as SessionContext['provider'] & {
      supportsPermissionControls: () => boolean;
    };
    deepseekProvider.supportsPermissionControls = () => false;
    mockGetProvider.mockReturnValue(deepseekProvider);
    const ctx: SessionContext = {
      provider: deepseekProvider,
      providerType: 'deepseek-harness' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      permissionMode: 'readonly',
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx, {
      outputMode: 'silent',
    });

    expect(capture.allowedTools).toEqual([['Read']]);
    expect(capture.permissionModes).toEqual(['readonly']);
  });

  it('expands image placeholders and omits native attachments for non-native providers', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: false });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };

    await callAIWithRetry('inspect [Image #1]', 'base system prompt', [], '/repo', ctx, {
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }],
    });

    expect(capture.prompts).toEqual([
      'inspect [Image #1] (`/tmp/takt-image-1.png`)',
      'inspect [Image #1] (`/tmp/takt-image-1.png`)',
    ]);
    expect(capture.imageAttachments).toEqual([undefined, undefined]);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
    expect(mockLogInfo).toHaveBeenCalled();
  });

  it('appends image paths for non-native providers when prompts omit placeholders', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: false });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    await callAIWithRetry('Summarize the completed run.', 'base system prompt', [], '/repo', ctx, {
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }],
    });

    expect(capture.prompts).toEqual([
      'Summarize the completed run.\n\n[Image #1] path: `/tmp/takt-image-1.png`',
    ]);
    expect(capture.imageAttachments).toEqual([undefined]);
    expect(mockLogInfo).toHaveBeenCalled();
  });

  it('keeps local image paths out of prompts for native providers and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex',
      model: 'gpt-5',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };
    const imageAttachments = [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }];

    await callAIWithRetry('inspect [Image #1]', 'base system prompt', [], '/repo', ctx, {
      imageAttachments,
    });

    expect(capture.prompts).toEqual([
      'inspect [Image #1]',
      'inspect [Image #1]',
    ]);
    for (const prompt of capture.prompts) {
      expect(prompt).not.toContain('/tmp/takt-image-1.png');
    }
    expect(capture.imageAttachments).toEqual([imageAttachments, imageAttachments]);
    expect(mockLogInfo).not.toHaveBeenCalled();
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
    expect(mockLogInfo).toHaveBeenCalled();

    // Then: cancelled at the end
    expect(result.action).toBe('cancel');
  });

  it('should not change sessionId when user cancels session selection', async () => {
    // Given: /resume → cancel selection → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    const ctx = createSessionContext();
    const resolveResumedSessionConfiguration = vi.fn();

    // When
    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      resolveResumedSessionConfiguration,
    }, undefined, undefined);

    // Then: selectRecentSession called but returned null
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');
    expect(resolveResumedSessionConfiguration).not.toHaveBeenCalled();

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

  it.each([false, true])(
    'should apply resumed formal specification mode=%s to regular and summary prompts',
    async (formalSpec) => {
      setupRawStdin(toRawInputs(['/resume', 'describe parser states', '/go add rollback plan']));
      mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');
      const resolveResumedSessionConfiguration = vi.fn().mockResolvedValue({
        systemPrompt: `resumed system prompt formalSpec=${formalSpec}`,
        formalSpec,
      });
      const { provider, capture } = createScenarioProvider([
        { content: 'Which transitions can fail?' },
        { content: 'Generated task instruction.' },
      ]);
      const ctx = createSessionContext({
        provider: provider as SessionContext['provider'],
      });

      const result = await runConversationLoop('/test', ctx, {
        ...defaultStrategy,
        formalSpec: !formalSpec,
        resolveResumedSessionConfiguration,
      }, undefined, undefined);

      expect(result.action).toBe('execute');
      expect(resolveResumedSessionConfiguration).toHaveBeenCalledOnce();
      expect(capture.systemPrompts[0]).toBe(`resumed system prompt formalSpec=${formalSpec}`);
      if (formalSpec) {
        expect(capture.prompts[1]).toMatch(/\bQuint\b/);
        expect(capture.prompts[1]).toMatch(/\bAlloy\b/);
      } else {
        expect(capture.prompts[1]).not.toMatch(/\bQuint\b/);
        expect(capture.prompts[1]).not.toMatch(/\bAlloy\b/);
      }
    },
  );

  it('should apply resumed comments=false to the summary prompt while keeping formal specifications enabled', async () => {
    const buildSummaryPromptSpy = vi.spyOn(interactiveModule, 'buildSummaryPrompt');
    setupRawStdin(toRawInputs(['/resume', '/go add rollback plan']));
    mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');
    const resolveResumedSessionConfiguration = vi.fn().mockResolvedValue({
      systemPrompt: 'resumed system prompt',
      formalSpec: true,
      formalSpecComments: false,
    });
    const { provider } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      formalSpec: true,
      formalSpecComments: true,
      resolveResumedSessionConfiguration,
    }, undefined, undefined);

    expect(result.action).toBe('execute');
    expect(resolveResumedSessionConfiguration).toHaveBeenCalledOnce();
    expect(buildSummaryPromptSpy).toHaveBeenCalledWith(
      expect.any(Array),
      true,
      'en',
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      undefined,
      true,
      false,
    );
  });

  it('should keep inline /go text as user note after resuming a session', async () => {
    setupRawStdin(toRawInputs(['/resume', '/go add rollback plan']));
    mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');

    const { provider, capture } = createScenarioProvider([
      { content: 'Summarized resumed task.' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(capture.callCount).toBe(1);
    expect(result).toEqual({
      action: 'execute',
      task: 'Summarized resumed task.',
    });
  });

  it('should treat unavailable /retry as a regular message outside retry mode', async () => {
    setupRawStdin(toRawInputs(['/retry', '/cancel']));
    const { provider, capture } = createScenarioProvider([{ content: 'regular response' }]);

    const ctx = createSessionContext({ provider: provider as SessionContext['provider'] });
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(capture.prompts).toEqual(['/retry']);
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
    expect(mockLogInfo).toHaveBeenCalled();
    expect(mockSelectRecentSession).not.toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });

  it('passes the assistant /retry context to the shared handler and continues the conversation', async () => {
    setupRawStdin(toRawInputs(['The diagnostics task fails in review.', '/retry restart from the beginning', '/cancel']));
    const { provider, capture } = createScenarioProvider([
      { content: 'The task is fix-quint-diagnostics.' },
    ]);
    mockRunAssistantRetryCommand.mockResolvedValue('The task was queued.');

    const ctx = createSessionContext({ provider: provider as SessionContext['provider'] });
    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enableAssistantRetryCommands: true,
    }, undefined, undefined);

    expect(capture.callCount).toBe(1);
    expect(mockRunAssistantRetryCommand).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/test',
      lang: 'en',
      command: 'retry',
      inlineText: 'restart from the beginning',
      history: [
        { role: 'user', content: 'The diagnostics task fails in review.' },
        { role: 'assistant', content: 'The task is fix-quint-diagnostics.' },
      ],
      sessionContext: expect.objectContaining(ctx),
      formalSpec: false,
    }));
    expect(mockLogInfo).toHaveBeenCalledWith('The task was queued.');
    expect(result.action).toBe('cancel');
  });

  it('passes a resumed session and the /requeue command to the shared handler', async () => {
    setupRawStdin(toRawInputs(['/resume', '/requeue start from the beginning', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue('resumed-cli-session');
    mockRunAssistantRetryCommand.mockResolvedValue('The task was queued.');

    const ctx = createSessionContext();
    await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enableAssistantRetryCommands: true,
    }, undefined, undefined);

    expect(mockRunAssistantRetryCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'requeue',
      inlineText: 'start from the beginning',
      history: [],
      sessionContext: expect.objectContaining({ sessionId: 'resumed-cli-session' }),
    }));
  });
});

describe('/issue command', () => {
  it('should replace Source Context after /issue while retaining the conversation and AI session', async () => {
    setupRawStdin(toRawInputs([
      'before the Issue change',
      '/issue #456',
      'after the first Issue',
      '/issue 12 34',
      'after the multiple-Issue change',
      '/issue 789',
      'after the latest Issue',
      '/go',
    ]));
    const gitProvider = setupIssueProvider();
    const { provider, capture } = createScenarioProvider([
      { content: 'Answer before the Issue change', sessionId: 'ai-session' },
      { content: 'Answer after the first Issue', sessionId: 'ai-session' },
      { content: 'Answer after multiple Issues', sessionId: 'ai-session' },
      { content: 'Answer after the latest Issue', sessionId: 'ai-session' },
      { content: 'Generated task instruction' },
    ]);
    const sourceContexts: Array<string | undefined> = [];
    const summaryOptions: SummaryPromptOptions[] = [];
    const summaryPromptBuilder = vi.fn((options: SummaryPromptOptions) => {
      summaryOptions.push(options);
      return `Summary source:\n${options.sourceContext ?? ''}`;
    });
    const ctx = createSessionContext({ provider: provider as SessionContext['provider'] });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      transformPrompt: (message, sourceContext) => {
        sourceContexts.push(sourceContext);
        return `${message}\n${sourceContext ?? ''}`;
      },
      summaryPromptBuilder,
    }, undefined, {
      sourceContext: formattedIssue(123),
    });

    const multiIssueContext = [formattedIssue(12), formattedIssue(34)].join('\n\n---\n\n');
    expect(gitProvider.checkCliStatus).toHaveBeenCalledTimes(3);
    expect(gitProvider.checkCliStatus.mock.calls).toEqual([['/test'], ['/test'], ['/test']]);
    expect(gitProvider.fetchIssue.mock.calls).toEqual([
      [456, '/test'],
      [12, '/test'],
      [34, '/test'],
      [789, '/test'],
    ]);
    expect(sourceContexts).toEqual([
      formattedIssue(123),
      formattedIssue(456),
      multiIssueContext,
      formattedIssue(789),
    ]);
    expect(summaryOptions[0]?.sourceContext).toBe(formattedIssue(789));
    expect(summaryPromptBuilder).toHaveBeenCalledOnce();
    expect(summaryOptions[0]?.history.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([
        'before the Issue change',
        'after the first Issue',
        'after the multiple-Issue change',
        'after the latest Issue',
      ]);
    expect(capture.callCount).toBe(5);
    expect(capture.sessionIds.slice(0, 4)).toEqual([
      undefined,
      'ai-session',
      'ai-session',
      'ai-session',
    ]);
    expect(capture.prompts[1]).toContain(formattedIssue(456));
    expect(capture.prompts[1]).not.toContain(formattedIssue(123));
    expect(capture.prompts[2]).toContain(multiIssueContext);
    expect(capture.prompts[2]).not.toContain(formattedIssue(456));
    expect(capture.prompts[3]).toContain(formattedIssue(789));
    expect(capture.prompts[3]).not.toContain(formattedIssue(12));
    expect(capture.prompts[3]).not.toContain(formattedIssue(34));
    expect(capture.prompts[4]).toContain(formattedIssue(789));
    expect(capture.prompts[4]).not.toContain(formattedIssue(123));
    expect(mockLogInfo.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('#456') && message.includes('Issue 456')),
    ).toBe(true);
    expect(result).toMatchObject({ action: 'execute', task: 'Generated task instruction' });
  });

  it('should treat inline /issue text and /issueX as ordinary messages without fetching Issues', async () => {
    setupRawStdin(toRawInputs([
      'この /issue #456 を説明して',
      '/issueX 456',
      '/go',
    ]));
    const gitProvider = setupIssueProvider();
    const { provider, capture } = createScenarioProvider([
      { content: 'Answer to inline command text', sessionId: 'ai-session' },
      { content: 'Answer to the similar command name', sessionId: 'ai-session' },
      { content: 'Generated task instruction' },
    ]);
    const sourceContexts: Array<string | undefined> = [];
    const summaryOptions: SummaryPromptOptions[] = [];
    const summaryPromptBuilder = vi.fn((options: SummaryPromptOptions) => {
      summaryOptions.push(options);
      return 'Summary of the unchanged context';
    });

    const result = await runConversationLoop('/test', createSessionContext({
      provider: provider as SessionContext['provider'],
    }), {
      ...defaultStrategy,
      transformPrompt: (message, sourceContext) => {
        sourceContexts.push(sourceContext);
        return `${message}\n${sourceContext ?? ''}`;
      },
      summaryPromptBuilder,
    }, undefined, {
      sourceContext: formattedIssue(123),
    });

    expect(gitProvider.checkCliStatus).not.toHaveBeenCalled();
    expect(gitProvider.fetchIssue).not.toHaveBeenCalled();
    expect(sourceContexts).toEqual([formattedIssue(123), formattedIssue(123)]);
    expect(summaryOptions[0]?.sourceContext).toBe(formattedIssue(123));
    expect(summaryOptions[0]?.history.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['この /issue #456 を説明して', '/issueX 456']);
    expect(capture.callCount).toBe(3);
    expect(capture.prompts[0]).toContain('この /issue #456 を説明して');
    expect(capture.prompts[1]).toContain('/issueX 456');
    expect(result.action).toBe('execute');
  });

  it.each([
    {
      name: 'without arguments',
      command: '/issue',
      cliAvailable: true,
      failingIssueNumbers: [],
      fetchedNumbers: [],
    },
    {
      name: 'when the GitHub CLI is unavailable',
      command: '/issue 456',
      cliAvailable: false,
      failingIssueNumbers: [],
      fetchedNumbers: [],
    },
    {
      name: 'when an Issue cannot be fetched',
      command: '/issue 999999',
      cliAvailable: true,
      failingIssueNumbers: [999999],
      fetchedNumbers: [999999],
    },
    {
      name: 'when one requested Issue cannot be fetched',
      command: '/issue 12 34',
      cliAvailable: true,
      failingIssueNumbers: [34],
      fetchedNumbers: [12, 34],
    },
  ])('should keep the prior Source Context and continue $name', async ({
    command,
    cliAvailable,
    failingIssueNumbers,
    fetchedNumbers,
  }) => {
    setupRawStdin(toRawInputs([
      'before the failed Issue change',
      command,
      'after the failed Issue change',
      '/go',
    ]));
    const gitProvider = setupIssueProvider({ cliAvailable, failingIssueNumbers });
    const { provider, capture } = createScenarioProvider([
      { content: 'Answer before failure', sessionId: 'ai-session' },
      { content: 'Answer after failure', sessionId: 'ai-session' },
      { content: 'Generated task instruction' },
    ]);
    const sourceContexts: Array<string | undefined> = [];
    const summaryOptions: SummaryPromptOptions[] = [];
    const summaryPromptBuilder = vi.fn((options: SummaryPromptOptions) => {
      summaryOptions.push(options);
      return 'Summary of the original context';
    });

    const result = await runConversationLoop('/test', createSessionContext({
      provider: provider as SessionContext['provider'],
    }), {
      ...defaultStrategy,
      transformPrompt: (message, sourceContext) => {
        sourceContexts.push(sourceContext);
        return `${message}\n${sourceContext ?? ''}`;
      },
      summaryPromptBuilder,
    }, undefined, {
      sourceContext: formattedIssue(123),
    });

    expect(gitProvider.fetchIssue.mock.calls).toEqual(fetchedNumbers.map((number) => [number, '/test']));
    expect(gitProvider.checkCliStatus).toHaveBeenCalledTimes(command === '/issue' ? 0 : 1);
    if (command !== '/issue') {
      expect(gitProvider.checkCliStatus).toHaveBeenCalledWith('/test');
    }
    expect(sourceContexts).toEqual([formattedIssue(123), formattedIssue(123)]);
    expect(summaryOptions[0]?.sourceContext).toBe(formattedIssue(123));
    expect(summaryOptions[0]?.history.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['before the failed Issue change', 'after the failed Issue change']);
    expect(capture.callCount).toBe(3);
    expect(capture.sessionIds.slice(0, 2)).toEqual([undefined, 'ai-session']);
    expect(mockLogError).toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'execute', task: 'Generated task instruction' });
  });
});

// =================================================================
// /verify command: seeded initial input handling
// =================================================================
describe('/verify command', () => {
  it.each([
    { verificationStarted: false, expectedCalls: 2 },
    { verificationStarted: true, expectedCalls: 3 },
  ])('should not resend the seeded input after /verify when verificationStarted=$verificationStarted', async ({ verificationStarted, expectedCalls }) => {
    setupRawStdin(toRawInputs(['/verify', 'follow up', '/cancel']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Generated specification', sessionId: 'verify-session' },
      ...(verificationStarted ? [{ content: 'Verification interpretation', sessionId: 'verify-session' }] : []),
      { content: 'Follow-up answer', sessionId: 'chat-session' },
    ]);
    mockRunFormalSpecVerification.mockResolvedValueOnce({
      verdict: verificationStarted ? 'passed' : 'error',
      verificationStarted,
      quint: { status: verificationStarted ? 'passed' : 'skipped' },
      alloy: { status: verificationStarted ? 'passed' : 'skipped' },
    });

    await runConversationLoop('/test', createSessionContext({
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
    }), {
      ...defaultStrategy,
      formalSpec: true,
    }, undefined, { userMessage: 'Seeded initial request' });

    expect(capture.callCount).toBe(expectedCalls);
    expect(capture.prompts[0]).toContain('Seeded initial request');
    expect(capture.prompts.at(-1)).toContain('follow up');
    expect(capture.prompts.at(-1)).not.toContain('Seeded initial request');
  });
});

// =================================================================
// /go command: summary AI session isolation
// =================================================================
describe('/go command', () => {
  it('does not turn a disabled /accept into an execution result in a guarded mode', async () => {
    setupRawStdin(toRawInputs(['/accept', '/go']));
    const { provider } = createScenarioProvider([
      { content: 'Assistant response to accept text' },
      { content: 'Revised order body' },
    ]);
    const ctx = createSessionContext({ provider: provider as SessionContext['provider'] });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enabledCommands: [SlashCommand.Go, SlashCommand.Cancel],
      trackResultSource: true,
    }, undefined, undefined);

    expect(result).toMatchObject({
      action: 'execute',
      task: 'Revised order body',
      source: 'go',
    });
  });

  it.each([false, true])('should apply resolved formal specification mode=%s to the real summary prompt', async (formalSpec) => {
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      formalSpec,
    }, undefined, undefined);

    expect(result.action).toBe('execute');
    expect(capture.prompts[0]).toContain("Gherkin");
    if (formalSpec) {
      expect(capture.prompts[0]).toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).toMatch(/\bAlloy\b/);
    } else {
      expect(capture.prompts[0]).not.toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).not.toMatch(/\bAlloy\b/);
    }
  });

  it('should pass the resolved formal specification mode to the summary builder', async () => {
    const buildSummaryPromptSpy = vi.spyOn(interactiveModule, 'buildSummaryPrompt');
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock',
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      formalSpec: true,
    }, undefined, undefined);

    expect(result.action).toBe('execute');
    expect(buildSummaryPromptSpy).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      'en',
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      undefined,
      true,
      true,
    );
  });

  it('should keep the session value instead of re-resolving project config inside the conversation loop', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-formal-spec-session-value-'));
    fs.mkdirSync(path.join(projectDir, '.takt'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.takt', 'config.yaml'),
      ['assistant:', '  formal_spec: false'].join('\n'),
      'utf-8',
    );
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    try {
      const result = await runConversationLoop(projectDir, ctx, {
        ...defaultStrategy,
        formalSpec: true,
      }, undefined, undefined);

      expect(result.action).toBe('execute');
      expect(capture.prompts[0]).toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).toMatch(/\bAlloy\b/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should isolate the summary AI without replacing the resumable conversation session', async () => {
    // Given: send message (AI responds with sessionId) → /go triggers summary
    setupRawStdin(toRawInputs(['hello', '/go']));

    const { provider, capture } = createScenarioProvider([
      // Call 0: user message → AI responds and sets sessionId
      { content: 'AI response', sessionId: 'session-abc' },
      // Call 1: /go summary → should NOT inherit sessionId
      { content: '## Fix broken title\nDetails here', sessionId: 'summary-session' },
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
    expect(mockUpdatePersonaSession).toHaveBeenCalledTimes(1);
    expect(mockUpdatePersonaSession).toHaveBeenCalledWith(
      '/test',
      'interactive',
      'session-abc',
      'mock',
    );
    expect(result.action).toBe('execute');
  });

  it('should return a rejected /go draft to the conversation history', async () => {
    setupRawStdin(toRawInputs(['hello', '/go', 'revise this draft', '/go']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Initial assistant response' },
      { content: 'First generated order' },
      { content: 'Revised assistant response' },
      { content: 'Second generated order' },
    ]);
    const selectGoAction = vi.fn()
      .mockResolvedValueOnce('continue')
      .mockResolvedValueOnce('execute');
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    const result = await runConversationLoop(
      '/test',
      ctx,
      { ...defaultStrategy, selectGoAction },
      undefined,
      undefined,
    );

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Second generated order');
    expect(capture.prompts[3]).toContain('First generated order');
  });

  it('should report missing stored images in regular input and continue without calling AI', async () => {
    setupRawStdin(toRawInputs(['inspect [Image #1]', '/cancel']));
    const missingAttachment = createMissingImageAttachment();
    const { provider, capture } = createScenarioProvider([], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, {
      attachments: [missingAttachment],
    });

    expect(capture.callCount).toBe(0);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('missing-image.png'));
    expect(result.action).toBe('cancel');
  });

  it('should report missing stored images in /go summary and continue without calling AI', async () => {
    setupRawStdin(toRawInputs(['/go inspect [Image #1]', '/cancel']));
    const missingAttachment = createMissingImageAttachment();
    const { provider, capture } = createScenarioProvider([], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, {
      attachments: [missingAttachment],
    });

    expect(capture.callCount).toBe(0);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('missing-image.png'));
    expect(result.action).toBe('cancel');
  });

  it('should include assistant init context only in the first regular AI prompt', async () => {
    setupRawStdin(toRawInputs(['hello', 'follow up', '/cancel']));

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response' },
      { content: 'Second AI response' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        initialPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      undefined,
    );

    expect(capture.callCount).toBe(2);
    expect(result.action).toBe('cancel');
  });

  it('should include assistant init context in summary prompts', async () => {
    setupRawStdin(toRawInputs(['/go']));

    const { provider, capture } = createScenarioProvider([
      { content: 'Summarized task.' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        summaryPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      {
        userMessage: 'Implement explicit assistant init files',
      },
    );

    expect(capture.callCount).toBe(1);
    expect(result).toEqual({
      action: 'execute',
      task: 'Summarized task.',
    });
  });

  it('should not allow /go with assistant init context only', async () => {
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    const { provider, capture } = createScenarioProvider([]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        initialPromptContext: '## Assistant Init Context\nconfigured project context',
        summaryPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      undefined,
    );

    expect(capture.callCount).toBe(0);
    expect(mockLogInfo).toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});

describe('conversation logging', () => {
  it('should log only non-sensitive metadata for initial input and session state', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupProvider([]);

    const ctx = createSessionContext({ sessionId: 'sensitive-session-id' });

    const result = await runConversationLoop(
      '/test',
      ctx,
      defaultStrategy,
      undefined,
      { sourceContext: 'secret prefilled input' },
    );

    expect(result).toEqual({ action: 'cancel', task: '' });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.any(String),
      {
        hasInitialInput: true,
        initialInputLength: 'secret prefilled input'.length,
        hasSession: true,
      },
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.any(String),
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
  });
});
