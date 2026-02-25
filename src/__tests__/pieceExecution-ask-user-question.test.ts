/**
 * Tests: executePiece() wires a deny handler for AskUserQuestion
 * to PieceEngine during piece execution.
 *
 * This ensures that the agent cannot prompt the user interactively
 * during automated piece runs — AskUserQuestion is always blocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PieceConfig } from '../core/models/index.js';
import { AskUserQuestionDeniedError } from '../core/piece/ask-user-question-error.js';

const { MockPieceEngine } = vi.hoisted(() => {
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
      const firstStep = this.config.movements[0];
      if (firstStep) {
        this.emit('movement:start', firstStep, 1, firstStep.instructionTemplate);
      }
      this.emit('piece:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return { MockPieceEngine };
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
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  resolvePieceConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    observability: undefined,
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
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
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
        instructionTemplate: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('executePiece AskUserQuestion deny handler wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass onAskUserQuestion handler to PieceEngine', async () => {
    // Given: normal piece execution
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: PieceEngine receives an onAskUserQuestion handler
    const handler = MockPieceEngine.lastInstance.receivedOptions.onAskUserQuestion;
    expect(typeof handler).toBe('function');
  });

  it('should provide a handler that throws AskUserQuestionDeniedError', async () => {
    // Given: piece execution completed
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // When: the handler is invoked (as PieceEngine would when agent calls AskUserQuestion)
    const handler = MockPieceEngine.lastInstance.receivedOptions.onAskUserQuestion as () => never;

    // Then: it throws AskUserQuestionDeniedError
    expect(() => handler()).toThrow(AskUserQuestionDeniedError);
  });

  it('should complete successfully despite deny handler being present', async () => {
    // Given/When: normal piece execution with deny handler wired
    const result = await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: piece completes successfully
    expect(result.success).toBe(true);
  });
});
