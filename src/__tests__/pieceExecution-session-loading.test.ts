/**
 * Tests: session loading behavior in executePiece().
 *
 * Normal runs pass empty sessions to PieceEngine;
 * retry runs (startMovement / retryNote) load persisted sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { PieceConfig } from '../core/models/index.js';

const {
  MockPieceEngine,
  mockLoadPersonaSessions,
  mockLoadWorktreeSessions,
  mockCreateUsageEventLogger,
  mockUsageLogger,
  mockMovementResponse,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockLoadPersonaSessions = vi.fn().mockReturnValue({ coder: 'saved-session-id' });
  const mockLoadWorktreeSessions = vi.fn().mockReturnValue({ coder: 'worktree-session-id' });
  const mockUsageLogger = {
    filepath: '/tmp/test-usage-events.jsonl',
    setMovement: vi.fn(),
    setProvider: vi.fn(),
    logUsage: vi.fn(),
  };
  const mockCreateUsageEventLogger = vi.fn().mockReturnValue(mockUsageLogger);
  const mockMovementResponse: {
    providerUsage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      usageMissing: boolean;
      reason?: string;
    } | undefined;
  } = {
    providerUsage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    },
  };

  type PersonaProviderMap = Record<string, { provider?: string; model?: string }>;

  function resolveProviderInfo(
    step: { personaDisplayName?: string; provider?: string; model?: string },
    opts: Record<string, unknown>,
  ): { provider: string | undefined; model: string | undefined } {
    const personaProviders = opts.personaProviders as PersonaProviderMap | undefined;
    const personaEntry = personaProviders?.[step.personaDisplayName ?? ''];
    const provider = personaEntry?.provider ?? step.provider ?? opts.provider as string | undefined;
    const model = personaEntry?.model ?? step.model ?? opts.model as string | undefined;
    return { provider, model };
  }

  class MockPieceEngine extends EE {
    static lastInstance: MockPieceEngine;
    readonly receivedOptions: Record<string, unknown>;
    private readonly config: PieceConfig;

    constructor(config: PieceConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.config = config;
      this.receivedOptions = options;
      MockPieceEngine.lastInstance = this;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const firstStep = this.config.movements[0];
      if (firstStep) {
        const providerInfo = resolveProviderInfo(firstStep, this.receivedOptions);
        this.emit('movement:start', firstStep, 1, firstStep.instructionTemplate, providerInfo);
        this.emit('movement:complete', firstStep, {
          persona: firstStep.personaDisplayName,
          status: 'done',
          content: 'ok',
          timestamp: new Date('2026-03-04T00:00:00.000Z'),
          sessionId: 'movement-session',
          providerUsage: mockMovementResponse.providerUsage,
        }, firstStep.instructionTemplate);
      }
      this.emit('piece:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return {
    MockPieceEngine,
    mockLoadPersonaSessions,
    mockLoadWorktreeSessions,
    mockCreateUsageEventLogger,
    mockUsageLogger,
    mockMovementResponse,
  };
});

vi.mock('../core/piece/index.js', async () => {
  const errorModule = await import('../core/piece/ask-user-question-error.js');
  return {
    PieceEngine: MockPieceEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../agents/ai-judge.js', () => ({
  callAiJudge: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: mockLoadPersonaSessions,
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: mockLoadWorktreeSessions,
  updateWorktreeSession: vi.fn(),
  resolvePieceConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
  }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  getDebugPromptsLogFile: vi.fn().mockReturnValue(null),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));
vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: mockCreateUsageEventLogger,
  isUsageEventsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import { resolvePieceConfigValues } from '../infra/config/index.js';
import { info } from '../shared/ui/index.js';

const defaultResolvedConfigValues = {
  notificationSound: true,
  notificationSoundEvents: {},
  provider: 'claude',
  runtime: undefined,
  preventSleep: false,
  model: undefined,
  logging: undefined,
  analytics: undefined,
};

function makeConfig(): PieceConfig {
  return {
    name: 'test-piece',
    maxMovements: 5,
    initialMovement: 'implement',
    movements: [
      {
        name: 'implement',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instructionTemplate: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

function makeConfigWithMovement(overrides: Record<string, unknown>): PieceConfig {
  const baseMovement = makeConfig().movements[0];
  if (!baseMovement) {
    throw new Error('Base movement is required');
  }
  return {
    ...makeConfig(),
    movements: [{ ...baseMovement, ...overrides }],
  };
}

describe('executePiece session loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateUsageEventLogger.mockReturnValue(mockUsageLogger);
    vi.mocked(resolvePieceConfigValues).mockReturnValue({ ...defaultResolvedConfigValues });
    mockLoadPersonaSessions.mockReturnValue({ coder: 'saved-session-id' });
    mockLoadWorktreeSessions.mockReturnValue({ coder: 'worktree-session-id' });
    mockMovementResponse.providerUsage = {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    };
  });

  it('should pass empty initialSessions on normal run', async () => {
    // Given: normal execution (no startMovement, no retryNote)
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: PieceEngine receives empty sessions
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
    expect(MockPieceEngine.lastInstance.receivedOptions.initialSessions).toEqual({});
  });

  it('should log usage events on movement completion when usage logging is enabled', async () => {
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockCreateUsageEventLogger).toHaveBeenCalledOnce();
    expect(mockUsageLogger.setMovement).toHaveBeenCalledWith('implement', 'normal');
    expect(mockUsageLogger.setProvider).toHaveBeenCalledWith('claude', '(default)');
    expect(mockUsageLogger.logUsage).toHaveBeenCalledWith({
      success: true,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        usageMissing: false,
      },
    });
  });

  it('should log usage_missing reason when provider usage is unavailable', async () => {
    mockMovementResponse.providerUsage = undefined;

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.logUsage).toHaveBeenCalledWith({
      success: true,
      usage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
      },
    });
  });

  it('should load persisted sessions when startMovement is set (retry)', async () => {
    // Given: retry execution with startMovement
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load persisted sessions when retryNote is set (retry)', async () => {
    // Given: retry execution with retryNote
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      retryNote: 'Fix the failing test',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load worktree sessions on retry when cwd differs from projectCwd', async () => {
    // Given: retry execution in a worktree (cwd !== projectCwd)
    await executePiece(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
    });

    // Then: loadWorktreeSessions is called instead of loadPersonaSessions
    expect(mockLoadWorktreeSessions).toHaveBeenCalledWith('/tmp/project', '/tmp/worktree', 'claude');
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
  });

  it('should not load sessions for worktree normal run', async () => {
    // Given: normal execution in a worktree (no retry)
    await executePiece(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
    });

    // Then: neither session loader is called
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
  });

  it('should load sessions when both startMovement and retryNote are set', async () => {
    // Given: retry with both flags
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
      retryNote: 'Fix issue',
    });

    // Then: sessions are loaded
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should log provider and model per movement with global defaults', async () => {
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: claude');
    expect(mockInfo).toHaveBeenCalledWith('Model: (default)');
  });

  it('should resolve logging config from piece config values', async () => {
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const calls = vi.mocked(resolvePieceConfigValues).mock.calls;
    expect(calls).toHaveLength(1);
    const keys = calls[0]?.[1];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys).toContain('logging');
    expect(keys).not.toContain('observability');
  });

  it('should log configured model from global/project settings when movement model is unresolved', async () => {
    vi.mocked(resolvePieceConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      model: 'gpt-4.1',
    });

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-4.1');
  });

  it('should log provider and model per movement with overrides', async () => {
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'gpt-5',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: opencode');
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-5');
  });

  it('should pass movement type to usage logger for parallel movement', async () => {
    await executePiece(makeConfigWithMovement({ parallel: { branches: [] } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.setMovement).toHaveBeenCalledWith('implement', 'parallel');
  });

  it('should pass movement type to usage logger for arpeggio movement', async () => {
    await executePiece(makeConfigWithMovement({ arpeggio: { source: './items.csv' } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.setMovement).toHaveBeenCalledWith('implement', 'arpeggio');
  });

  it('should pass movement type to usage logger for team leader movement', async () => {
    await executePiece(
      makeConfigWithMovement({ teamLeader: { output: { mode: 'summary' } } }),
      'task',
      '/tmp/project',
      {
        projectCwd: '/tmp/project',
      },
    );

    expect(mockUsageLogger.setMovement).toHaveBeenCalledWith('implement', 'team_leader');
  });
});
