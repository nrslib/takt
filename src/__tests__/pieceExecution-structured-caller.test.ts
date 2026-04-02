import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PieceConfig } from '../core/models/index.js';
import {
  DefaultStructuredCaller,
  PromptBasedStructuredCaller,
  type StructuredCaller,
} from '../agents/structured-caller.js';

const {
  MockPieceEngine,
  mockGetProvider,
  mockRunAgent,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

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
      const step = this.config.movements[0];
      if (step) {
        this.emit('movement:start', step, 1, step.instruction, { provider: 'cursor', model: undefined });
        this.emit('movement:complete', step, {
          persona: step.personaDisplayName,
          status: 'done',
          content: 'ok',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        }, step.instruction);
      }
      this.emit('piece:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return {
    MockPieceEngine,
    mockGetProvider: vi.fn(),
    mockRunAgent: vi.fn(),
  };
});

vi.mock('../core/piece/index.js', async () => {
  const errorModule = await import('../core/piece/ask-user-question-error.js');
  return {
    PieceEngine: MockPieceEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/providers/index.js', () => ({
  getProvider: mockGetProvider,
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: mockRunAgent,
}));

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  resolvePieceConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'cursor',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
    analytics: undefined,
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

vi.mock('../shared/utils/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn().mockReturnValue({
    filepath: '/tmp/provider-events.jsonl',
    wrapCallback: vi.fn((callback) => callback),
    setMovement: vi.fn(),
    setProvider: vi.fn(),
  }),
  isProviderEventsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn().mockReturnValue({
    filepath: '/tmp/usage-events.jsonl',
    setMovement: vi.fn(),
    setProvider: vi.fn(),
    logUsage: vi.fn(),
  }),
  isUsageEventsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

import { executePiece } from '../features/tasks/execute/pieceExecution.js';

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
        instruction: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

function expectStructuredCallerShape(value: unknown): void {
  expect(value).toEqual(
    expect.objectContaining({
      judgeStatus: expect.any(Function),
      evaluateCondition: expect.any(Function),
      decomposeTask: expect.any(Function),
      requestMoreParts: expect.any(Function),
    }),
  );
}

function getInjectedStructuredCaller(): StructuredCaller {
  const structuredCaller = MockPieceEngine.lastInstance.receivedOptions.structuredCaller;
  expectStructuredCallerShape(structuredCaller);
  return structuredCaller as StructuredCaller;
}

describe('executePiece structuredCaller injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
  });

  it('global provider が cursor のとき prompt-based caller へ委譲できること', async () => {
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
    const { resolvePieceConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolvePieceConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:6]',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(PromptBasedStructuredCaller);
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [{ index: 5, text: 'approved' }],
      { cwd: '/tmp/project', provider: MockPieceEngine.lastInstance.receivedOptions.provider as 'cursor' },
    );

    expect(result).toBe(5);
    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect(MockPieceEngine.lastInstance.receivedOptions.callAiJudge).toBeUndefined();
    expect(MockPieceEngine.lastInstance.receivedOptions.provider).toBe('cursor');
    expect(MockPieceEngine.lastInstance.receivedOptions.model).toBeUndefined();
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'cursor',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('global provider が claude のとき structured output caller へ委譲できること', async () => {
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: true });
    const { resolvePieceConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolvePieceConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      structuredOutput: { matched_index: 2 },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(DefaultStructuredCaller);
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'approved' },
        { index: 5, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: MockPieceEngine.lastInstance.receivedOptions.provider as 'claude' },
    );

    expect(result).toBe(5);
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(MockPieceEngine.lastInstance.receivedOptions.callAiJudge).toBeUndefined();
    expect(MockPieceEngine.lastInstance.receivedOptions.provider).toBe('claude');
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'claude',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });

  it('should pass the effective model from global config to PieceEngine when no override is provided', async () => {
    const { resolvePieceConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolvePieceConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: 'cursor-fast',
      logging: undefined,
      analytics: undefined,
    });

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(MockPieceEngine.lastInstance.receivedOptions.provider).toBe('cursor');
    expect(MockPieceEngine.lastInstance.receivedOptions.model).toBe('cursor-fast');
  });

  it('should prefer provider override over global config when selecting the structured caller', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'mock',
    }));
    const { resolvePieceConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolvePieceConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(DefaultStructuredCaller);
    expect(MockPieceEngine.lastInstance.receivedOptions.provider).toBe('mock');
    expect(mockGetProvider).toHaveBeenCalledWith('mock');
  });
});
