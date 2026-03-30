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
    static triggerIterationLimit = false;
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
      if (MockPieceEngine.triggerIterationLimit) {
        if (!firstStep) {
          throw new Error('Test fixture requires at least one movement');
        }
        const onIterationLimit = this.receivedOptions.onIterationLimit as
          | ((request: { currentIteration: number; maxMovements: number; currentMovement: string }) => Promise<number | null>)
          | undefined;
        if (onIterationLimit) {
          await onIterationLimit({
            currentIteration: 1,
            maxMovements: this.config.maxMovements,
            currentMovement: firstStep.name,
          });
        }
        this.emit('piece:abort', { status: 'aborted', iteration: 1 }, 'Reached max movements');
        return { status: 'aborted', iteration: 1 };
      }
      if (firstStep) {
        this.emit('movement:start', firstStep, 1, firstStep.instruction, { provider: undefined, model: undefined });
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

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import { selectOption } from '../shared/prompt/index.js';
import { error, info } from '../shared/ui/index.js';

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

describe('executePiece AskUserQuestion deny handler wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockPieceEngine.triggerIterationLimit = false;
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

  it('should mark exceeded without prompting even when interactiveUserInput is true', async () => {
    // Given: mock engine reaches iteration limit immediately
    MockPieceEngine.triggerIterationLimit = true;

    // When: executePiece runs in interactive mode
    const result = await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      interactiveUserInput: true,
    });

    // Then: no extension prompt appears; execution is marked as exceeded
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentMovement: 'implement',
      newMaxMovements: 10,
      currentIteration: 1,
    });
  });

  it('should report workflow abort message and session log path when aborted', async () => {
    MockPieceEngine.triggerIterationLimit = true;

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(vi.mocked(error)).toHaveBeenCalledWith(
      expect.stringContaining('Workflow aborted after 1 iterations'),
    );
    expect(vi.mocked(error)).not.toHaveBeenCalledWith(
      expect.stringContaining('Piece aborted after'),
    );
    expect(vi.mocked(info)).toHaveBeenCalledWith('Session log: /tmp/test-log.jsonl');
  });
});
