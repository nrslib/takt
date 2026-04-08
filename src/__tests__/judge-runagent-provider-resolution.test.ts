import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import {
  evaluateCondition,
  judgeStatus,
  runTagJudgeStage,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type TagJudgeRunOptions,
} from '../agents/judge-status-usecase.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadJudgmentSchema: vi.fn(() => ({ type: 'judgment' })),
  loadEvaluationSchema: vi.fn(() => ({ type: 'evaluation' })),
}));

vi.mock('../agents/judge-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/judge-utils.js')>();
  return {
    ...actual,
    buildJudgePrompt: vi.fn(() => 'judge prompt'),
    detectJudgeIndex: vi.fn(() => -1),
  };
});

function doneResponse(content: string, structuredOutput?: Record<string, unknown>) {
  return {
    persona: 'tester',
    status: 'done' as const,
    content,
    timestamp: new Date('2026-02-12T00:00:00Z'),
    structuredOutput,
  };
}

type WithResolved = {
  resolvedProvider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
  resolvedModel?: string;
};

describe('judge runAgent provider/model resolution (#556)', () => {
  const judgeBase: JudgeStatusOptions & WithResolved = {
    cwd: '/repo',
    stepName: 'review',
    provider: 'codex',
    resolvedProvider: 'codex',
    resolvedModel: 'gpt-5.2-codex',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('evaluateCondition', () => {
    it('Given resolvedProvider and resolvedModel When evaluateCondition runs Then runAgent receives them on RunAgentOptions', async () => {
      vi.mocked(runAgent).mockResolvedValue(doneResponse('x', { matched_index: 1 }));

      const opts: EvaluateConditionOptions & WithResolved = {
        cwd: '/repo',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      };
      await evaluateCondition('agent output', [{ index: 0, text: 'a' }], opts);

      expect(runAgent).toHaveBeenCalledWith(
        undefined,
        'judge prompt',
        expect.objectContaining({
          cwd: '/repo',
          provider: 'codex',
          resolvedProvider: 'codex',
          resolvedModel: 'gpt-5.2-codex',
        }),
      );
    });
  });

  describe('runTagJudgeStage', () => {
    it('Given resolvedProvider and resolvedModel When tag stage runs Then runAgent receives them', async () => {
      vi.mocked(runAgent).mockResolvedValue(doneResponse('[REVIEW:1]'));

      const runOpts: TagJudgeRunOptions & WithResolved = {
        cwd: '/repo',
        stepName: 'review',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      };
      await runTagJudgeStage(
        'tag instruction',
        [{ condition: 'done', next: 'COMPLETE' }],
        false,
        runOpts,
      );

      expect(runAgent).toHaveBeenCalledWith(
        'conductor',
        'tag instruction',
        expect.objectContaining({
          cwd: '/repo',
          provider: 'codex',
          resolvedProvider: 'codex',
          resolvedModel: 'gpt-5.2-codex',
        }),
      );
    });
  });

  describe('judgeStatus', () => {
    it('Given resolvedProvider and resolvedModel When all three stages invoke runAgent Then each call includes them', async () => {
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no structured step'));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2 }));

      await judgeStatus('structured', 'tag', [
        { condition: 'a', next: 'one' },
        { condition: 'b', next: 'two' },
      ], judgeBase);

      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(runAgent).toHaveBeenNthCalledWith(
        1,
        'conductor',
        'structured',
        expect.objectContaining({
          resolvedProvider: 'codex',
          resolvedModel: 'gpt-5.2-codex',
          provider: 'codex',
        }),
      );
      expect(runAgent).toHaveBeenNthCalledWith(
        2,
        'conductor',
        'tag',
        expect.objectContaining({
          resolvedProvider: 'codex',
          resolvedModel: 'gpt-5.2-codex',
          provider: 'codex',
        }),
      );
      expect(runAgent).toHaveBeenNthCalledWith(
        3,
        undefined,
        'judge prompt',
        expect.objectContaining({
          resolvedProvider: 'codex',
          resolvedModel: 'gpt-5.2-codex',
          provider: 'codex',
        }),
      );
    });
  });
});
