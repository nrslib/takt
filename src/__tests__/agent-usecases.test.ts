import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { parseParts } from '../core/workflow/engine/task-decomposer.js';
import { detectJudgeIndex } from '../agents/judge-utils.js';
import {
  executeAgent,
  generateReport,
  executePart,
  evaluateCondition,
  judgeStatus,
  decomposeTask,
  requestMoreParts,
  type DecomposeTaskOptions,
} from '../agents/agent-usecases.js';
import { runTagJudgeStage } from '../agents/judge-status-usecase.js';
import { loadEvaluationSchema, loadJudgmentSchema } from '../infra/resources/schema-loader.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadJudgmentSchema: vi.fn(() => ({
    type: 'object',
    required: ['step', 'reason'],
    properties: { step: { type: 'integer' }, reason: { type: 'string' } },
    additionalProperties: false,
  })),
  loadEvaluationSchema: vi.fn(() => ({
    type: 'object',
    required: ['matched_index', 'reason'],
    properties: { matched_index: { type: 'integer' }, reason: { type: 'string' } },
    additionalProperties: false,
  })),
  loadDecompositionSchema: vi.fn((maxInitialParts?: number) => ({ type: 'decomposition', maxInitialParts })),
  loadMorePartsSchema: vi.fn(() => ({ type: 'more-parts' })),
}));

vi.mock('../core/workflow/engine/task-decomposer.js', () => ({
  parseParts: vi.fn(),
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

const judgeOptions = { cwd: '/repo', stepName: 'review' };
type JudgeStageLog = {
  stage: 1 | 2 | 3;
  method: 'structured_output' | 'phase3_tag' | 'ai_judge';
  status: 'done' | 'error' | 'skipped';
  instruction: string;
  response: string;
};

describe('agent-usecases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executeAgent/generateReport/executePart は runAgent に委譲する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ok'));

    await executeAgent('coder', 'do work', { cwd: '/tmp' });
    await generateReport('coder', 'write report', { cwd: '/tmp' });
    await executePart('coder', 'part work', { cwd: '/tmp' });

    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenNthCalledWith(1, 'coder', 'do work', { cwd: '/tmp' });
    expect(runAgent).toHaveBeenNthCalledWith(2, 'coder', 'write report', { cwd: '/tmp' });
    expect(runAgent).toHaveBeenNthCalledWith(3, 'coder', 'part work', { cwd: '/tmp' });
  });

  it('evaluateCondition は構造化出力の matched_index を優先する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
      { index: 1, text: 'second' },
    ], { cwd: '/repo' });

    expect(result).toBe(1);
    expect(runAgent).toHaveBeenCalledWith(undefined, 'judge prompt', expect.objectContaining({
      cwd: '/repo',
      outputSchema: expect.objectContaining({
        required: ['matched_index', 'reason'],
      }),
    }));
  });

  it('evaluateCondition は構造化出力が使えない場合にタグ検出へフォールバックする', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('[JUDGE:2]'));
    vi.mocked(detectJudgeIndex).mockReturnValue(1);

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
      { index: 1, text: 'second' },
    ], { cwd: '/repo' });

    expect(result).toBe(1);
    expect(detectJudgeIndex).toHaveBeenCalledWith('[JUDGE:2]');
  });

  it.each([
    ['reason missing', { matched_index: 1 }],
    ['matched_index has wrong type', { matched_index: '1', reason: 'wrong type' }],
    ['additional property', { matched_index: 1, reason: 'first condition', extra: true }],
  ])('evaluateCondition は不正な構造化出力（$0）の後にタグ検出を続行する', async (_name, structuredOutput) => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('[JUDGE:1]', structuredOutput));
    vi.mocked(detectJudgeIndex).mockReturnValue(0);

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
    ], { cwd: '/repo' });

    expect(result).toBe(0);
    expect(detectJudgeIndex).toHaveBeenCalledWith('[JUDGE:1]');
  });

  it.each([
    ['schema is not an object', []],
    ['schema compilation fails', { type: 'not-a-json-schema-type' }],
  ])('evaluateCondition は不正なschema（$0）をフォールバックせず送出する', async (_name, invalidSchema) => {
    vi.mocked(loadEvaluationSchema).mockReturnValueOnce(invalidSchema as never);

    await expect(evaluateCondition('agent output', [{ index: 0, text: 'first' }], { cwd: '/repo' }))
      .rejects.toThrow('Structured output schema');
    expect(runAgent).not.toHaveBeenCalled();
    expect(detectJudgeIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['schema is not an object', []],
    ['schema compilation fails', { type: 'not-a-json-schema-type' }],
  ])('judgeStatus は不正なschema（$0）を次のjudge候補へフォールバックせず送出する', async (_name, invalidSchema) => {
    vi.mocked(loadJudgmentSchema).mockReturnValueOnce(invalidSchema as never);
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { step: 1, reason: 'first rule' }));

    await expect(judgeStatus('structured', 'tag', [
      { label: 'first' },
      { label: 'second' },
    ], judgeOptions)).rejects.toThrow('Structured output schema');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('evaluateCondition は runAgent が done 以外なら -1 を返す', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'tester',
      status: 'error',
      content: 'failed',
      timestamp: new Date('2026-02-12T00:00:00Z'),
    });

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
    ], { cwd: '/repo' });

    expect(result).toBe(-1);
    expect(detectJudgeIndex).not.toHaveBeenCalled();
  });

  it('evaluateCondition は maxTurns 非対応 provider では内部 maxTurns を渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 1, reason: 'first condition' }));

    await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
    ], {
      cwd: '/repo',
      resolvedProvider: 'claude-terminal',
    });

    expect(runAgent).toHaveBeenCalledWith(undefined, 'judge prompt', expect.not.objectContaining({
      maxTurns: expect.anything(),
    }));
  });

  // --- judgeStatus: 3-stage fallback ---

  it.each([
    ['候補が空', []],
    ['候補が1件', [{ label: 'always' }]],
  ])('judgeStatus は%sなら Phase 3 境界で拒否する', async (_case, candidates) => {
    await expect(judgeStatus('structured', 'tag', candidates, judgeOptions))
      .rejects.toThrow('judgeStatus requires at least two semantic candidates');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('judgeStatus は Stage 1 で構造化出力 step を採用する', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('x', { step: 2, reason: 'matched rule' }));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], judgeOptions);

    expect(result).toEqual({ candidateIndex: 1, method: 'structured_output' });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith('conductor', 'structured', expect.objectContaining({
      outputSchema: expect.objectContaining({
        required: ['step', 'reason'],
      }),
    }));
  });

  it('judgeStatus は Stage 2 でタグ検出を使う', async () => {
    // Stage 1: structured output fails (no structuredOutput)
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection succeeds
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], judgeOptions);

    expect(result).toEqual({ candidateIndex: 1, method: 'phase3_tag' });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(1, 'conductor', 'structured', expect.objectContaining({
      outputSchema: expect.objectContaining({
        required: ['step', 'reason'],
      }),
    }));
    expect(runAgent).toHaveBeenNthCalledWith(2, 'conductor', 'tag', expect.not.objectContaining({
      outputSchema: expect.anything(),
    }));
  });

  it.each([
    ['reason missing', { step: 1 }],
    ['step has wrong type', { step: '1', reason: 'wrong type' }],
    ['additional property', { step: 1, reason: 'matched rule', extra: true }],
  ])('judgeStatus は不正なStage 1構造化出力（$0）の後にStage 2を続行する', async (_name, structuredOutput) => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(doneResponse('not used', structuredOutput))
      .mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], judgeOptions);

    expect(result).toEqual({ candidateIndex: 1, method: 'phase3_tag' });
  });

  it('judgeStatus は Stage 3 で AI Judge を使う', async () => {
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition succeeds
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], judgeOptions);

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it('judgeStatus passes childProcessEnv to all Phase 3 internal agent calls', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], {
      ...judgeOptions,
      childProcessEnv,
    });

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(runAgent).mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ childProcessEnv }));
    }
  });

  it('judgeStatus passes abortSignal to all Phase 3 internal agent calls', async () => {
    const abortController = new AbortController();
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], {
      ...judgeOptions,
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    for (const call of vi.mocked(runAgent).mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ abortSignal: abortController.signal }));
    }
  });

  it('judgeStatus rejects a pre-aborted signal without starting a provider stage', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('cancelled before judgment'));

    await expect(judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], {
      ...judgeOptions,
      abortSignal: abortController.signal,
    })).rejects.toThrow('cancelled before judgment');

    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    'judgeStatus records provider stage %i before stopping when the signal is aborted',
    async (abortStage) => {
      const abortController = new AbortController();
      const onJudgeStage = vi.fn();
      const providerUsages = [1, 2, 3].map((stage) => ({
        inputTokens: stage,
        outputTokens: stage,
        totalTokens: stage * 2,
        usageMissing: false,
      }));
      let stage = 0;
      vi.mocked(runAgent).mockImplementation(async () => {
        stage++;
        if (stage === abortStage) {
          abortController.abort(new Error(`cancelled during stage ${stage}`));
        }
        const response = stage === 1
          ? doneResponse('no structured match')
          : stage === 2
            ? doneResponse('no tag match')
            : doneResponse('ignored', { matched_index: 2, reason: 'second condition' });
        response.providerUsage = providerUsages[stage - 1];
        return response;
      });

      await expect(judgeStatus('structured', 'tag', [
        { label: 'a' },
        { label: 'b' },
      ], {
        ...judgeOptions,
        abortSignal: abortController.signal,
        onJudgeStage,
      })).rejects.toThrow(`cancelled during stage ${abortStage}`);

      expect(runAgent).toHaveBeenCalledTimes(abortStage);
      expect(onJudgeStage).toHaveBeenCalledTimes(abortStage);
      for (let index = 0; index < abortStage; index++) {
        expect(onJudgeStage).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
          stage: index + 1,
          status: index + 1 === abortStage ? 'error' : 'done',
          providerUsage: providerUsages[index],
        }));
      }
    },
  );

  it('judgeStatus は maxTurns 非対応 provider では全内部ステージで maxTurns を渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await judgeStatus('structured', 'tag', [
      { label: 'done' },
      { label: 'fix' },
    ], {
      ...judgeOptions,
      resolvedProvider: 'claude-terminal',
    });

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(runAgent).mock.calls) {
      expect(call[2]).not.toHaveProperty('maxTurns');
    }
  });

  it('judgeStatus は Phase 3 の内部ステージログを順序どおりに通知する', async () => {
    const onJudgeStage = vi.fn();
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection succeeds
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    await judgeStatus(
      'structured',
      'tag',
      [
        { label: 'a' },
        { label: 'b' },
      ],
      {
        ...judgeOptions,
        onJudgeStage,
      } as typeof judgeOptions & { onJudgeStage: (entry: JudgeStageLog) => void },
    );

    expect(onJudgeStage).toHaveBeenCalledTimes(2);
    expect(onJudgeStage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      stage: 1,
      method: 'structured_output',
      status: 'done',
      instruction: 'structured',
      response: 'no match',
    }));
    expect(onJudgeStage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: 2,
      method: 'phase3_tag',
      status: 'done',
      instruction: 'tag',
      response: '[REVIEW:2]',
    }));
  });

  it('judgeStatus は全ステージ失敗時にも Stage 3 までログ通知する', async () => {
    const onJudgeStage = vi.fn();
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('still no match'));
    vi.mocked(detectJudgeIndex).mockReturnValue(-1);

    await expect(
      judgeStatus(
        'structured',
        'tag',
        [
          { label: 'a' },
          { label: 'b' },
        ],
        {
          ...judgeOptions,
          onJudgeStage,
        } as typeof judgeOptions & { onJudgeStage: (entry: JudgeStageLog) => void },
      ),
    ).rejects.toThrow('Status not found for step "review"');

    expect(onJudgeStage).toHaveBeenCalledTimes(3);
    expect(onJudgeStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 3,
      method: 'ai_judge',
    }));
  });

  it('judgeStatus Stage 3 は候補配列の位置を candidateIndex として返す', async () => {
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition - matched_index:2 means candidate position 1
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

    const result = await judgeStatus(
      'structured',
      'tag',
      [
        { label: 'done' },
        { label: 'fix' },
      ],
      judgeOptions,
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
  });

  it('judgeStatus は全ての判定に失敗したらエラー', async () => {
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('still no match'));
    vi.mocked(detectJudgeIndex).mockReturnValue(-1);

    await expect(judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], judgeOptions)).rejects.toThrow('Status not found for step "review"');
  });

  it('judgeStatus Stage 3 では onJudgeStage は evaluateCondition の応答状態が error でも必ず呼ばれる（dead code なし）', async () => {
    // dead code 再発防止: stage3Status === 'skipped' チェックは不要で、
    // onJudgeResponse が呼ばれれば stage3Status は 'done' か 'error' になる。
    const onJudgeStage = vi.fn();
    // Stage 1: fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition returns error response
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'tester',
      status: 'error' as const,
      content: 'agent error',
      timestamp: new Date('2026-02-12T00:00:00Z'),
    });
    vi.mocked(detectJudgeIndex).mockReturnValue(-1);

    await expect(
      judgeStatus('structured', 'tag', [
        { label: 'a' },
        { label: 'b' },
      ], {
        ...judgeOptions,
        onJudgeStage,
      } as typeof judgeOptions & { onJudgeStage: (entry: JudgeStageLog) => void }),
    ).rejects.toThrow('Status not found for step "review"');

    // Stage 3 の onJudgeStage は必ず呼ばれる（'skipped' での早期 throw はない）
    expect(onJudgeStage).toHaveBeenCalledTimes(3);
    expect(onJudgeStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 3,
      method: 'ai_judge',
      status: 'error',
    }));
  });

  it('judgeStatus Stage 3 の provider rejection でも error stage を通知する', async () => {
    const onJudgeStage = vi.fn();
    vi.mocked(runAgent)
      .mockResolvedValueOnce(doneResponse('no match'))
      .mockResolvedValueOnce(doneResponse('no tag'))
      .mockRejectedValueOnce(new Error('stage 3 rejected'));

    await expect(judgeStatus('structured', 'tag', [
      { label: 'a' },
      { label: 'b' },
    ], {
      ...judgeOptions,
      onJudgeStage,
    } as typeof judgeOptions & { onJudgeStage: (entry: JudgeStageLog) => void }))
      .rejects.toThrow('stage 3 rejected');

    expect(onJudgeStage).toHaveBeenCalledTimes(3);
    expect(onJudgeStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 3,
      method: 'ai_judge',
      status: 'error',
      response: 'stage 3 rejected',
    }));
  });

  // --- decomposeTask ---

  it('decomposeTask は構造化出力 parts を返す', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));

    const result = await decomposeTask('instruction', 3, { cwd: '/repo', persona: 'team-leader' });

    expect(result.parts).toEqual([
      { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
    ]);
    expect(parseParts).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.any(String), expect.objectContaining({
      allowedTools: [],
      permissionMode: 'readonly',
      outputSchema: { type: 'decomposition', maxInitialParts: 3 },
      structuredOutputRetryCount: 0,
    }));
    const [, , callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(callOptions).not.toHaveProperty('maxTurns');
  });

  it('Given inspectTools, When decomposeTask runs, Then it passes them to the parent decomposition call only', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));

    await decomposeTask('instruction', 3, {
      cwd: '/repo',
      persona: 'team-leader',
      inspectTools: ['Read', 'Glob', 'Grep'],
    } as DecomposeTaskOptions & { inspectTools: string[] });

    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.any(String), expect.objectContaining({
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'readonly',
      outputSchema: { type: 'decomposition', maxInitialParts: 3 },
    }));
  });

  it('decomposeTask は構造化出力がない場合 parseParts にフォールバックする', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('```json [] ```'));
    vi.mocked(parseParts).mockReturnValue([
      { id: 'p1', title: 'Part 1', instruction: 'fallback' },
    ]);

    const result = await decomposeTask('instruction', 2, { cwd: '/repo' });

    expect(parseParts).toHaveBeenCalledWith('```json [] ```', 2);
    expect(result.parts).toEqual([
      { id: 'p1', title: 'Part 1', instruction: 'fallback' },
    ]);
  });

  it('Finding Contract decomposition は構造化出力がない場合に汎用parserへフォールバックしない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('```json [] ```'));

    await expect(decomposeTask('instruction', 2, {
      cwd: '/repo',
      findingContract: {
        targetFindingIds: ['F-0001'],
        actionableFindings: '{"open":[{"id":"F-0001"}]}',
      },
    })).rejects.toThrow('requires structured output');

    expect(parseParts).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it('Finding Contract decomposition は無効な初回分解を検証feedback付きで再生成する', async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(doneResponse('invalid', {
        parts: [{
          id: 'invalid',
          title: 'Invalid',
          instruction: 'Invalid',
          findingContract: {
            findingIds: [],
            role: 'repair',
            writePaths: ['src/a.ts'],
            readPaths: [],
          },
        }],
      }))
      .mockResolvedValueOnce(doneResponse('valid', {
        parts: [{
          id: 'repair',
          title: 'Repair',
          instruction: 'Repair F-0001',
          findingContract: {
            findingIds: ['F-0001'],
            role: 'repair',
            writePaths: ['src/a.ts'],
            readPaths: [],
          },
        }],
      }));

    const result = await decomposeTask('instruction', 2, {
      cwd: '/repo',
      findingContract: {
        targetFindingIds: ['F-0001'],
        actionableFindings: '{"open":[{"id":"F-0001"}]}',
      },
    });

    expect(result.parts).toHaveLength(1);
    expect(runAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];
    expect(secondPrompt).toContain('Previously rejected decomposition');
    expect(secondPrompt).toContain('decomposition.parts_invalid');
    expect(secondPrompt).not.toContain('"content"');
  });

  it('Finding Contract decomposition は repair 所有重複も part 実行前に再生成する', async () => {
    const makePart = (id: string, findingId: string) => ({
      id,
      title: id,
      instruction: id,
      findingContract: {
        findingIds: [findingId],
        role: 'repair',
        writePaths: [`src/${id}.ts`],
        readPaths: [],
      },
    });
    vi.mocked(runAgent)
      .mockResolvedValueOnce(doneResponse('duplicate', {
        parts: [makePart('first', 'F-0001'), makePart('second', 'F-0001')],
      }))
      .mockResolvedValueOnce(doneResponse('valid', {
        parts: [makePart('repair', 'F-0001')],
      }));

    const result = await decomposeTask('instruction', 2, {
      cwd: '/repo',
      findingContract: {
        targetFindingIds: ['F-0001'],
        actionableFindings: '{"open":[{"id":"F-0001"}]}',
      },
    });

    expect(result.parts.map((part) => part.id)).toEqual(['repair']);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('multiple repair parts');
  });

  it('decomposeTask は provider 例外を再試行しない', async () => {
    const providerError = new Error('network unavailable');
    vi.mocked(runAgent).mockRejectedValue(providerError);
    const onAgentError = vi.fn();

    await expect(decomposeTask('instruction', 2, {
      cwd: '/repo',
      onAgentError,
    })).rejects.toBe(providerError);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(onAgentError).toHaveBeenCalledWith(providerError);
  });

  it('decomposeTask は done 以外をエラーにする', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: 'failure',
      error: 'bad output',
      timestamp: new Date('2026-02-12T00:00:00Z'),
    });

    await expect(decomposeTask('instruction', 2, { cwd: '/repo' }))
      .rejects.toThrow('Team leader failed: bad output');
  });

  it('decomposeTask は onPromptResolved を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));
    const onPromptResolved = vi.fn();

    await decomposeTask('instruction', 2, {
      cwd: '/repo',
      persona: 'team-leader',
      onPromptResolved,
    });

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.objectContaining({ onPromptResolved }),
    );
  });

  it('decomposeTask は AbortSignal と provider usage を呼び出し境界へ伝搬する', async () => {
    const providerUsage = {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      usageMissing: false,
    };
    const response = doneResponse('x', {
      parts: [{ id: 'p1', title: 'Part 1', instruction: 'Do 1' }],
    });
    response.providerUsage = providerUsage;
    vi.mocked(runAgent).mockResolvedValue(response);
    const abortController = new AbortController();
    const onAgentResponse = vi.fn();

    const result = await decomposeTask('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onAgentResponse,
    });

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(onAgentResponse).toHaveBeenCalledWith(response);
    expect(result.providerUsage).toEqual(providerUsage);
  });

  it('decomposeTask は応答待ち中の中断後に成功 callback を通知しない', async () => {
    const abortController = new AbortController();
    const onAgentResponse = vi.fn();
    let resolveRunAgent: ((response: ReturnType<typeof doneResponse>) => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRunAgent = resolve;
    }));

    const result = decomposeTask('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onAgentResponse,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());

    abortController.abort(new Error('cancelled while waiting'));
    await expect(result).rejects.toThrow('cancelled while waiting');

    resolveRunAgent?.(doneResponse('x', {
      parts: [{ id: 'p1', title: 'Part 1', instruction: 'Do 1' }],
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onAgentResponse).not.toHaveBeenCalled();
  });

  it('decomposeTask は中断後に遅延した provider error を通知しない', async () => {
    const abortController = new AbortController();
    const onAgentError = vi.fn();
    let rejectRunAgent: ((error: Error) => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectRunAgent = reject;
    }));

    const result = decomposeTask('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onAgentError,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());

    abortController.abort(new Error('cancelled while waiting'));
    await expect(result).rejects.toThrow('cancelled while waiting');

    rejectRunAgent?.(new Error('late provider cleanup failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onAgentError).not.toHaveBeenCalled();
  });

  it('decomposeTask は workflowMeta を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    await decomposeTask('instruction', 2, {
      cwd: '/repo',
      persona: 'team-leader',
      workflowMeta,
    } as DecomposeTaskOptions & { workflowMeta: typeof workflowMeta });

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.objectContaining({ workflowMeta }),
    );
  });

  it('decomposeTask は mcpServers を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));
    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-mcp' },
    };

    await decomposeTask('instruction', 2, {
      cwd: '/repo',
      persona: 'team-leader',
      mcpServers,
    });

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.objectContaining({ mcpServers }),
    );
  });

  it('decomposeTask は maxTurns 非対応 provider では内部 maxTurns を渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));

    await decomposeTask('instruction', 2, {
      cwd: '/repo',
      persona: 'team-leader',
      resolvedProvider: 'claude-terminal',
    });

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.not.objectContaining({ maxTurns: expect.anything() }),
    );
  });

  it('requestMoreParts は構造化出力をパースして返す', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: false,
      reasoning: 'Need one more part',
      parts: [
        { id: 'p3', title: 'Part 3', instruction: 'Do 3' },
      ],
    }));

    const result = await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1', 'p2'],
      { cwd: '/repo', persona: 'team-leader' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more part',
      parts: [{ id: 'p3', title: 'Part 3', instruction: 'Do 3' }],
    });
    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.stringContaining('original instruction'), expect.objectContaining({
      allowedTools: [],
      outputSchema: { type: 'more-parts' },
      permissionMode: 'readonly',
    }));
    const [, , callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(callOptions).not.toHaveProperty('maxTurns');
  });

  it('requestMoreParts は inspect tools を feedback planning call に渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'Enough',
      parts: [],
    }));

    await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        inspectTools: ['Read', 'Glob', 'Grep'],
      } as Parameters<typeof requestMoreParts>[3] & { inspectTools: string[] },
    );

    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.any(String), expect.objectContaining({
      allowedTools: [],
      outputSchema: { type: 'more-parts' },
      permissionMode: 'readonly',
    }));
  });

  it('requestMoreParts は done 以外をエラーにする', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: 'feedback failed',
      error: 'timeout',
      timestamp: new Date('2026-02-12T00:00:00Z'),
    });

    await expect(requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      { cwd: '/repo', persona: 'team-leader' },
    )).rejects.toThrow('Team leader feedback failed: timeout');
  });

  it('requestMoreParts は AbortSignal と provider usage を呼び出し境界へ伝搬する', async () => {
    const providerUsage = {
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      usageMissing: false,
    };
    const response = doneResponse('x', {
      done: true,
      reasoning: 'enough',
      parts: [],
    });
    response.providerUsage = providerUsage;
    vi.mocked(runAgent).mockResolvedValue(response);
    const abortController = new AbortController();
    const onAgentResponse = vi.fn();

    const result = await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        abortSignal: abortController.signal,
        onAgentResponse,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(onAgentResponse).toHaveBeenCalledWith(response);
    expect(result.providerUsage).toEqual(providerUsage);
  });

  it('requestMoreParts は workflowMeta を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'enough',
      parts: [],
    }));
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        workflowMeta,
      } as DecomposeTaskOptions & { workflowMeta: typeof workflowMeta },
    );

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.objectContaining({ workflowMeta }),
    );
  });

  it('requestMoreParts は mcpServers を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'enough',
      parts: [],
    }));
    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-mcp' },
    };

    await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        mcpServers,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.objectContaining({ mcpServers }),
    );
  });

  it('requestMoreParts は maxTurns 非対応 provider では内部 maxTurns を渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'enough',
      parts: [],
    }));

    await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        resolvedProvider: 'claude-terminal',
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.any(String),
      expect.not.objectContaining({ maxTurns: expect.anything() }),
    );
  });

  // --- runTagJudgeStage (ARCH-NEW-DRY-Stage2-judgeStatus 再発防止) ---

  it('runTagJudgeStage はタグ検出成功時に JudgeStatusResult を返す', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:1]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ label: 'done' }, { label: 'fix' }],
      { cwd: '/repo', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ candidateIndex: 0, method: 'phase3_tag' });
    expect(runAgent).toHaveBeenCalledWith('conductor', 'tag instruction', expect.objectContaining({
      cwd: '/repo',
      provider: 'cursor',
      maxTurns: 3,
      permissionMode: 'readonly',
    }));
  });

  it('runTagJudgeStage は maxTurns 非対応 provider では内部 maxTurns を渡さない', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:1]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ label: 'done' }, { label: 'fix' }],
      { cwd: '/repo', stepName: 'review', resolvedProvider: 'claude-terminal' },
    );

    expect(result).toEqual({ candidateIndex: 0, method: 'phase3_tag' });
    expect(runAgent).toHaveBeenCalledWith('conductor', 'tag instruction', expect.not.objectContaining({
      maxTurns: expect.anything(),
    }));
  });

  it('runTagJudgeStage はタグ不一致時に undefined を返す', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no matching tag'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ label: 'done' }],
      { cwd: '/repo', stepName: 'review' },
    );

    expect(result).toBeUndefined();
  });

  it('runTagJudgeStage は候補範囲外のタグを拒否する', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [
        { label: 'done' },
      ],
      { cwd: '/repo', stepName: 'review' },
    );

    expect(result).toBeUndefined();
  });

  // --- DecomposeTaskOptions.provider 型契約（ARCH-NEW-BoySCout-ProviderType-DecomposeTask 再発防止） ---

  it('DecomposeTaskOptions.provider は cursor/copilot を受け入れる（ProviderType 型契約）', () => {
    // ProviderType の全値が DecomposeTaskOptions.provider に代入できることを確認。
    // TypeScript コンパイルが通ることで型の一致を保証。
    const optionsCursor: DecomposeTaskOptions = { cwd: '/repo', provider: 'cursor' };
    const optionsCopilot: DecomposeTaskOptions = { cwd: '/repo', provider: 'copilot' };
    const optionsClaude: DecomposeTaskOptions = { cwd: '/repo', provider: 'claude' };
    expect(optionsCursor.provider).toBe('cursor');
    expect(optionsCopilot.provider).toBe('copilot');
    expect(optionsClaude.provider).toBe('claude');
  });
});
