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

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadJudgmentSchema: vi.fn(() => ({ type: 'judgment' })),
  loadEvaluationSchema: vi.fn(() => ({ type: 'evaluation' })),
  loadDecompositionSchema: vi.fn((maxParts: number) => ({ type: 'decomposition', maxParts })),
  loadMorePartsSchema: vi.fn((maxAdditionalParts: number) => ({ type: 'more-parts', maxAdditionalParts })),
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
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 2 }));

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
      { index: 1, text: 'second' },
    ], { cwd: '/repo' });

    expect(result).toBe(1);
    expect(runAgent).toHaveBeenCalledWith(undefined, 'judge prompt', expect.objectContaining({
      cwd: '/repo',
      outputSchema: { type: 'evaluation' },
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

  // --- judgeStatus: 3-stage fallback ---

  it('judgeStatus は単一ルール時に auto_select を返す', async () => {
    const result = await judgeStatus('structured', 'tag', [{ condition: 'always', next: 'done' }], judgeOptions);

    expect(result).toEqual({ ruleIndex: 0, method: 'auto_select' });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('judgeStatus はルールが空ならエラー', async () => {
    await expect(judgeStatus('structured', 'tag', [], judgeOptions))
      .rejects.toThrow('judgeStatus requires at least one rule');
  });

  it('judgeStatus は Stage 1 で構造化出力 step を採用する', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('x', { step: 2 }));

    const result = await judgeStatus('structured', 'tag', [
      { condition: 'a', next: 'one' },
      { condition: 'b', next: 'two' },
    ], judgeOptions);

    expect(result).toEqual({ ruleIndex: 1, method: 'structured_output' });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith('conductor', 'structured', expect.objectContaining({
      outputSchema: { type: 'judgment' },
    }));
  });

  it('judgeStatus は Stage 2 でタグ検出を使う', async () => {
    // Stage 1: structured output fails (no structuredOutput)
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection succeeds
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    const result = await judgeStatus('structured', 'tag', [
      { condition: 'a', next: 'one' },
      { condition: 'b', next: 'two' },
    ], judgeOptions);

    expect(result).toEqual({ ruleIndex: 1, method: 'phase3_tag' });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(1, 'conductor', 'structured', expect.objectContaining({
      outputSchema: { type: 'judgment' },
    }));
    expect(runAgent).toHaveBeenNthCalledWith(2, 'conductor', 'tag', expect.not.objectContaining({
      outputSchema: expect.anything(),
    }));
  });

  it('judgeStatus は Stage 3 で AI Judge を使う', async () => {
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition succeeds
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2 }));

    const result = await judgeStatus('structured', 'tag', [
      { condition: 'a', next: 'one' },
      { condition: 'b', next: 'two' },
    ], judgeOptions);

    expect(result).toEqual({ ruleIndex: 1, method: 'ai_judge' });
    expect(runAgent).toHaveBeenCalledTimes(3);
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
        { condition: 'a', next: 'one' },
        { condition: 'b', next: 'two' },
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
          { condition: 'a', next: 'one' },
          { condition: 'b', next: 'two' },
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

  it('judgeStatus Stage 3 で interactiveOnly フィルタリング後の非連続インデックスが正しく返る', async () => {
    // rules = [done(0), blocked(1, interactiveOnly), fix(2)]
    // interactive=false → conditions = [{index:0}, {index:2}]
    // AI が fix (matched_index=2) を選択 → position 1 → originalIndex = 2
    // Stage 1: structured output fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no match'));
    // Stage 2: tag detection fails
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no tag'));
    // Stage 3: evaluateCondition - matched_index:2 means position 1 in normalized conditions
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2 }));

    const result = await judgeStatus(
      'structured',
      'tag',
      [
        { condition: 'done', next: 'COMPLETE' },
        { condition: 'blocked', next: 'ABORT', interactiveOnly: true },
        { condition: 'fix', next: 'fix' },
      ],
      { ...judgeOptions, interactive: false },
    );

    expect(result).toEqual({ ruleIndex: 2, method: 'ai_judge' });
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
      { condition: 'a', next: 'one' },
      { condition: 'b', next: 'two' },
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
        { condition: 'a', next: 'one' },
        { condition: 'b', next: 'two' },
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

  // --- decomposeTask ---

  it('decomposeTask は構造化出力 parts を返す', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));

    const result = await decomposeTask('instruction', 3, { cwd: '/repo', persona: 'team-leader' });

    expect(result).toEqual([
      { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
    ]);
    expect(parseParts).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.any(String), expect.objectContaining({
      allowedTools: [],
      permissionMode: 'readonly',
      maxTurns: 5,
      outputSchema: { type: 'decomposition', maxParts: 3 },
    }));
  });

  it('decomposeTask は構造化出力がない場合 parseParts にフォールバックする', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('```json [] ```'));
    vi.mocked(parseParts).mockReturnValue([
      { id: 'p1', title: 'Part 1', instruction: 'fallback' },
    ]);

    const result = await decomposeTask('instruction', 2, { cwd: '/repo' });

    expect(parseParts).toHaveBeenCalledWith('```json [] ```', 2);
    expect(result).toEqual([
      { id: 'p1', title: 'Part 1', instruction: 'fallback' },
    ]);
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
      2,
      { cwd: '/repo', persona: 'team-leader' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more part',
      parts: [{ id: 'p3', title: 'Part 3', instruction: 'Do 3' }],
    });
    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.stringContaining('original instruction'), expect.objectContaining({
      allowedTools: [],
      outputSchema: { type: 'more-parts', maxAdditionalParts: 2 },
      permissionMode: 'readonly',
      maxTurns: 5,
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
      1,
      { cwd: '/repo', persona: 'team-leader' },
    )).rejects.toThrow('Team leader feedback failed: timeout');
  });

  // --- runTagJudgeStage (ARCH-NEW-DRY-Stage2-judgeStatus 再発防止) ---

  it('runTagJudgeStage はタグ検出成功時に JudgeStatusResult を返す', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:1]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ condition: 'done', next: 'COMPLETE' }, { condition: 'fix', next: 'fix' }],
      false,
      { cwd: '/repo', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'phase3_tag' });
    expect(runAgent).toHaveBeenCalledWith('conductor', 'tag instruction', expect.objectContaining({
      cwd: '/repo',
      provider: 'cursor',
      maxTurns: 3,
      permissionMode: 'readonly',
    }));
  });

  it('runTagJudgeStage はタグ不一致時に undefined を返す', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no matching tag'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ condition: 'done', next: 'COMPLETE' }],
      false,
      { cwd: '/repo', stepName: 'review' },
    );

    expect(result).toBeUndefined();
  });

  it('runTagJudgeStage は interactiveOnly ルールを interactive=false 時にスキップする', async () => {
    // [REVIEW:2] → index 1 → interactiveOnly ルール → isValidRuleIndex が false → undefined
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:2]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [
        { condition: 'done', next: 'COMPLETE' },
        { condition: 'blocked', next: 'ABORT', interactiveOnly: true },
      ],
      false,
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
