/**
 * Integration tests: debug prompt log wiring in executePiece().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PieceConfig } from '../core/models/index.js';

const { mockIsDebugEnabled, mockWritePromptLog, MockPieceEngine } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockIsDebugEnabled = vi.fn().mockReturnValue(true);
  const mockWritePromptLog = vi.fn();

  class MockPieceEngine extends EE {
    private config: PieceConfig;

    constructor(config: PieceConfig, _cwd: string, _task: string, _options: unknown) {
      super();
      this.config = config;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const step = this.config.movements[0]!;
      const timestamp = new Date('2026-02-07T00:00:00.000Z');

      this.emit('movement:start', step, 1, 'movement instruction');
      this.emit('phase:start', step, 1, 'execute', 'phase prompt');
      this.emit('phase:complete', step, 1, 'execute', 'phase response', 'done');
      this.emit(
        'movement:complete',
        step,
        {
          persona: step.personaDisplayName,
          status: 'done',
          content: 'movement response',
          timestamp,
        },
        'movement instruction'
      );
      this.emit('piece:complete', { status: 'completed', iteration: 1 });

      return { status: 'completed', iteration: 1 };
    }
  }

  return { mockIsDebugEnabled, mockWritePromptLog, MockPieceEngine };
});

vi.mock('../core/piece/index.js', () => ({
  PieceEngine: MockPieceEngine,
}));

vi.mock('../infra/claude/index.js', () => ({
  callAiJudge: vi.fn(),
  detectRuleIndex: vi.fn(),
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  loadGlobalConfig: vi.fn().mockReturnValue({ provider: 'claude' }),
  saveSessionState: vi.fn(),
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
  updateLatestPointer: vi.fn(),
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
  isDebugEnabled: mockIsDebugEnabled,
  writePromptLog: mockWritePromptLog,
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

describe('executePiece debug prompts logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeConfig(): PieceConfig {
    return {
      name: 'test-piece',
      maxIterations: 5,
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

  it('should write prompt log record when debug is enabled', async () => {
    mockIsDebugEnabled.mockReturnValue(true);

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockWritePromptLog).toHaveBeenCalledTimes(1);
    const record = mockWritePromptLog.mock.calls[0]?.[0] as {
      movement: string;
      phase: number;
      iteration: number;
      prompt: string;
      response: string;
      timestamp: string;
    };
    expect(record.movement).toBe('implement');
    expect(record.phase).toBe(1);
    expect(record.iteration).toBe(1);
    expect(record.prompt).toBe('phase prompt');
    expect(record.response).toBe('phase response');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should not write prompt log record when debug is disabled', async () => {
    mockIsDebugEnabled.mockReturnValue(false);

    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockWritePromptLog).not.toHaveBeenCalled();
  });
});
