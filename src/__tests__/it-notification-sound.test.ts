/**
 * Integration test: notification sound ON/OFF in executePiece().
 *
 * Verifies that:
 * - notificationSound: undefined (default) → playWarningSound / notifySuccess / notifyError are called
 * - notificationSound: true → playWarningSound / notifySuccess / notifyError are called
 * - notificationSound: false → playWarningSound / notifySuccess / notifyError are NOT called
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Hoisted mocks (must be before vi.mock calls) ---

const {
  MockPieceEngine,
  mockInterruptAllQueries,
  mockLoadGlobalConfig,
  mockNotifySuccess,
  mockNotifyError,
  mockPlayWarningSound,
  mockSelectOption,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockInterruptAllQueries = vi.fn().mockReturnValue(0);
  const mockLoadGlobalConfig = vi.fn().mockReturnValue({ provider: 'claude' });
  const mockNotifySuccess = vi.fn();
  const mockNotifyError = vi.fn();
  const mockPlayWarningSound = vi.fn();
  const mockSelectOption = vi.fn().mockResolvedValue('stop');

  // Mock PieceEngine that can simulate complete / abort / iteration-limit
  class MockPieceEngine extends EE {
    static latestInstance: MockPieceEngine | null = null;

    private runResolve: ((value: { status: string; iteration: number }) => void) | null = null;
    private onIterationLimit: ((req: unknown) => Promise<number | null>) | undefined;

    constructor(
      _config: unknown,
      _cwd: string,
      _task: string,
      options: { onIterationLimit?: (req: unknown) => Promise<number | null> },
    ) {
      super();
      this.onIterationLimit = options?.onIterationLimit;
      MockPieceEngine.latestInstance = this;
    }

    abort(): void {
      const state = { status: 'aborted', iteration: 1 };
      this.emit('piece:abort', state, 'user_interrupted');
      if (this.runResolve) {
        this.runResolve(state);
        this.runResolve = null;
      }
    }

    complete(): void {
      const state = { status: 'completed', iteration: 3 };
      this.emit('piece:complete', state);
      if (this.runResolve) {
        this.runResolve(state);
        this.runResolve = null;
      }
    }

    async triggerIterationLimit(): Promise<void> {
      if (this.onIterationLimit) {
        await this.onIterationLimit({
          currentIteration: 10,
          maxIterations: 10,
          currentMovement: 'step1',
        });
      }
    }

    async run(): Promise<{ status: string; iteration: number }> {
      return new Promise((resolve) => {
        this.runResolve = resolve;
      });
    }
  }

  return {
    MockPieceEngine,
    mockInterruptAllQueries,
    mockLoadGlobalConfig,
    mockNotifySuccess,
    mockNotifyError,
    mockPlayWarningSound,
    mockSelectOption,
  };
});

// --- Module mocks ---

vi.mock('../core/piece/index.js', () => ({
  PieceEngine: MockPieceEngine,
}));

vi.mock('../infra/claude/index.js', () => ({
  detectRuleIndex: vi.fn(),
  interruptAllQueries: mockInterruptAllQueries,
}));

vi.mock('../agents/ai-judge.js', () => ({
  callAiJudge: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  loadGlobalConfig: mockLoadGlobalConfig,
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
  finalizeSessionLog: vi.fn().mockImplementation((log, _status) => ({
    ...log,
    status: _status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    notifySuccess: mockNotifySuccess,
    notifyError: mockNotifyError,
    playWarningSound: mockPlayWarningSound,
    preventSleep: vi.fn(),
    isDebugEnabled: vi.fn().mockReturnValue(false),
    writePromptLog: vi.fn(),
    generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
    isValidReportDirName: vi.fn().mockImplementation((value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
  };
});

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

// --- Import under test (after mocks) ---

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import type { PieceConfig } from '../core/models/index.js';

// --- Helpers ---

function makeConfig(): PieceConfig {
  return {
    name: 'test-notify',
    maxIterations: 10,
    initialMovement: 'step1',
    movements: [
      {
        name: 'step1',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instructionTemplate: 'Do something',
        passPreviousResponse: true,
        rules: [
          { condition: 'done', next: 'COMPLETE' },
          { condition: 'fail', next: 'ABORT' },
        ],
      },
    ],
  };
}

// --- Tests ---

describe('executePiece: notification sound behavior', () => {
  let tmpDir: string;
  let savedSigintListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    vi.clearAllMocks();
    MockPieceEngine.latestInstance = null;
    tmpDir = join(tmpdir(), `takt-notify-it-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, '.takt', 'reports'), { recursive: true });

    savedSigintListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    process.removeAllListeners('SIGINT');
    for (const listener of savedSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }
    process.removeAllListeners('uncaughtException');
  });

  describe('notifySuccess on piece:complete', () => {
    it('should call notifySuccess when notificationSound is undefined (default)', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude' });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.complete();
      await resultPromise;

      expect(mockNotifySuccess).toHaveBeenCalledOnce();
    });

    it('should call notifySuccess when notificationSound is true', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: true });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.complete();
      await resultPromise;

      expect(mockNotifySuccess).toHaveBeenCalledOnce();
    });

    it('should NOT call notifySuccess when notificationSound is false', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: false });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.complete();
      await resultPromise;

      expect(mockNotifySuccess).not.toHaveBeenCalled();
    });

    it('should NOT call notifySuccess when piece_complete event is disabled', async () => {
      mockLoadGlobalConfig.mockReturnValue({
        provider: 'claude',
        notificationSound: true,
        notificationSoundEvents: { pieceComplete: false },
      });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.complete();
      await resultPromise;

      expect(mockNotifySuccess).not.toHaveBeenCalled();
    });
  });

  describe('notifyError on piece:abort', () => {
    it('should call notifyError when notificationSound is undefined (default)', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude' });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockNotifyError).toHaveBeenCalledOnce();
    });

    it('should call notifyError when notificationSound is true', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: true });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockNotifyError).toHaveBeenCalledOnce();
    });

    it('should NOT call notifyError when notificationSound is false', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: false });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockNotifyError).not.toHaveBeenCalled();
    });

    it('should NOT call notifyError when piece_abort event is disabled', async () => {
      mockLoadGlobalConfig.mockReturnValue({
        provider: 'claude',
        notificationSound: true,
        notificationSoundEvents: { pieceAbort: false },
      });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockNotifyError).not.toHaveBeenCalled();
    });
  });

  describe('playWarningSound on iteration limit', () => {
    it('should call playWarningSound when notificationSound is undefined (default)', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude' });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await MockPieceEngine.latestInstance!.triggerIterationLimit();
      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockPlayWarningSound).toHaveBeenCalledOnce();
    });

    it('should call playWarningSound when notificationSound is true', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: true });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await MockPieceEngine.latestInstance!.triggerIterationLimit();
      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockPlayWarningSound).toHaveBeenCalledOnce();
    });

    it('should NOT call playWarningSound when notificationSound is false', async () => {
      mockLoadGlobalConfig.mockReturnValue({ provider: 'claude', notificationSound: false });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await MockPieceEngine.latestInstance!.triggerIterationLimit();
      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockPlayWarningSound).not.toHaveBeenCalled();
    });

    it('should NOT call playWarningSound when iteration_limit event is disabled', async () => {
      mockLoadGlobalConfig.mockReturnValue({
        provider: 'claude',
        notificationSound: true,
        notificationSoundEvents: { iterationLimit: false },
      });

      const resultPromise = executePiece(makeConfig(), 'test task', tmpDir, { projectCwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await MockPieceEngine.latestInstance!.triggerIterationLimit();
      MockPieceEngine.latestInstance!.abort();
      await resultPromise;

      expect(mockPlayWarningSound).not.toHaveBeenCalled();
    });
  });
});
