import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { parseParts } from '../core/workflow/engine/task-decomposer.js';
import { detectJudgeIndex } from '../agents/judge-utils.js';
import {
  executeAgent,
  executeIsolatedStructuredInternalAgent,
  generateReport,
  executePart,
  evaluateCondition as evaluateConditionImpl,
  judgeStatus as judgeStatusImpl,
  decomposeTask as decomposeTaskImpl,
  requestMoreParts as requestMorePartsImpl,
  type DecomposeTaskOptions,
} from '../agents/agent-usecases.js';
import type { AgentResponse, CompanionFinding } from '../core/models/index.js';
import { runTagJudgeStage as runTagJudgeStageImpl } from '../agents/judge-status-usecase.js';
import { requestDecompositionRawResponse as requestDecompositionRawResponseImpl } from '../agents/decompose-task-usecase.js';
import { loadEvaluationSchema, loadJudgmentSchema } from '../infra/resources/schema-loader.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import {
  createWorkflowStepDeadline,
  recordWorkflowStepProviderActivity,
  recordWorkflowStepProviderEventActivity,
} from '../core/workflow/engine/step-deadline.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/resources/schema-loader.js')>();
  return {
    ...actual,
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
  };
});

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

function doneResponse(content: string, structuredOutput?: Record<string, unknown>): AgentResponse {
  return {
    persona: 'tester',
    status: 'done' as const,
    content,
    timestamp: new Date('2026-02-12T00:00:00Z'),
    structuredOutput: structuredOutput ?? { content },
  };
}

const judgeOptions = { cwd: '/repo', stepName: 'review' };

const withResolvedMockProvider = <T extends { provider?: unknown; resolvedProvider?: unknown }>(
  options: T,
): T => ({
  ...options,
  ...(options.provider === undefined && options.resolvedProvider === undefined
    ? { resolvedProvider: 'mock' }
    : {}),
});

const evaluateCondition = (...args: Parameters<typeof evaluateConditionImpl>) => evaluateConditionImpl(
  args[0],
  args[1],
  withResolvedMockProvider(args[2]),
);
const judgeStatus = (...args: Parameters<typeof judgeStatusImpl>) => judgeStatusImpl(
  args[0],
  args[1],
  args[2],
  withResolvedMockProvider(args[3]),
);
const decomposeTask = (...args: Parameters<typeof decomposeTaskImpl>) => decomposeTaskImpl(
  args[0],
  args[1],
  withResolvedMockProvider(args[2]),
);
const requestMoreParts = (...args: Parameters<typeof requestMorePartsImpl>) => requestMorePartsImpl(
  args[0],
  args[1],
  args[2],
  withResolvedMockProvider(args[3]),
);
const runTagJudgeStage = (...args: Parameters<typeof runTagJudgeStageImpl>) => runTagJudgeStageImpl(
  args[0],
  args[1],
  withResolvedMockProvider(args[2]),
);
const requestDecompositionRawResponse = (
  ...args: Parameters<typeof requestDecompositionRawResponseImpl>
) => requestDecompositionRawResponseImpl(args[0], args[1], withResolvedMockProvider(args[2]));
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

  it('should execute internal structured agents with a provider-neutral read-only contract', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse(
      'ignored',
      { selected_ids: ['frontend'], rationale: 'UI changed' },
    ));
    const schema = { type: 'object', additionalProperties: false };

    const internalOptions = {
      cwd: '/tmp',
      workflowBundleResourceRoot: '/tmp/workflow-bundle/resources',
      agentName: 'security-reviewer',
      personaPath: '/project/.takt/facets/personas/security-reviewer.md',
      sessionId: 'ambient-session',
      resolution: {
        provider: 'opencode' as const,
        model: 'opencode/model',
        providerOptions: {
          codex: { skills: { repo: true, user: true } },
          opencode: { allowedTools: ['write'] },
          claude: { allowedTools: ['Bash'], skills: { enabled: true } },
        },
      },
    } as unknown as Parameters<typeof executeIsolatedStructuredInternalAgent>[3];

    const response = await executeIsolatedStructuredInternalAgent(
      'selector system prompt',
      'select reviewers',
      schema,
      internalOptions,
    );

    expect(response.structuredOutput).toEqual({
      selected_ids: ['frontend'],
      rationale: 'UI changed',
    });
    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      'select reviewers',
      expect.objectContaining({
        executionProfile: 'isolated-structured',
        internalAgentIsolation: 'strict-readonly',
        internalAgentName: 'security-reviewer',
        personaPath: '/project/.takt/facets/personas/security-reviewer.md',
        workflowBundleResourceRoot: '/tmp/workflow-bundle/resources',
        internalSystemPrompt: 'selector system prompt',
        allowedTools: [],
        mcpServers: {},
        bypassPermissions: false,
        sessionId: undefined,
        outputSchema: schema,
        resolvedExecution: {
          provider: 'opencode',
          model: 'opencode/model',
          permissionMode: 'readonly',
          providerOptions: {
            codex: { skills: { repo: true, user: true } },
            opencode: { allowedTools: ['write'] },
            claude: { allowedTools: ['Bash'], skills: { enabled: true } },
          },
        },
      }),
    );
  });

  it('should resolve runtime MCP assignment for internal agents and forward resolved servers to runAgent (order.md:106,76-80)', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { selected_ids: ['a'] }));
    const mcpAssignment = {
      servers: {
        common: { command: 'common-srv' },
        excluded: { command: 'excluded-srv' },
      },
      defaults: { servers: ['common', 'excluded'] },
      targets: {
        internal_agents: { selector: { exclude: ['excluded'] } },
      },
    } as unknown as import('../infra/config/runtime-provider/mcp-assignment.js').McpAssignmentSection;

    await executeIsolatedStructuredInternalAgent(
      'selector system prompt',
      'select reviewers',
      { type: 'object' },
      {
        cwd: '/tmp',
        resolution: {
          provider: 'mock',
          model: undefined,
          providerOptions: {},
        },
        mcpAssignment,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      'select reviewers',
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          common: expect.objectContaining({ command: 'common-srv' }),
        }),
      }),
    );
    const callOptions = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(callOptions?.mcpServers).not.toHaveProperty('excluded');
  });

  it('should propagate runtime MCP defaults to an isolated structured internal agent', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { selected_ids: ['a'] }));
    const mcpAssignment = {
      servers: { common: { command: 'common-srv' } },
      defaults: { servers: ['common'] },
    } as unknown as import('../infra/config/runtime-provider/mcp-assignment.js').McpAssignmentSection;

    await executeIsolatedStructuredInternalAgent(
      'assistant system prompt',
      'assist',
      { type: 'object' },
      {
        cwd: '/tmp',
        resolution: {
          provider: 'mock',
          model: undefined,
          providerOptions: {},
        },
        mcpAssignment,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      'assist',
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          common: expect.objectContaining({ command: 'common-srv' }),
        }),
      }),
    );
  });

  it('should return empty mcpServers when runtime MCP assignment yields an empty effective set', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { selected_ids: ['a'] }));
    const mcpAssignment = {
      servers: { common: { command: 'common-srv' } },
      defaults: { servers: ['common'] },
      targets: { internal_agents: { selector: { exclude: ['common'] } } },
    } as unknown as import('../infra/config/runtime-provider/mcp-assignment.js').McpAssignmentSection;

    await executeIsolatedStructuredInternalAgent(
      'selector system prompt',
      'select reviewers',
      { type: 'object' },
      {
        cwd: '/tmp',
        resolution: {
          provider: 'mock',
          model: undefined,
          providerOptions: {},
        },
        mcpAssignment,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      'select reviewers',
      expect.objectContaining({ mcpServers: {} }),
    );
  });

  it('routes OpenCode internal structured execution through setupIsolatedStructured', async () => {
    const actualRunner = await vi.importActual<typeof import('../agents/runner.js')>(
      '../agents/runner.js',
    );
    const setupIsolatedStructured = vi.spyOn(OpenCodeProvider.prototype, 'setupIsolatedStructured')
      .mockReturnValue({
        call: vi.fn().mockResolvedValue(doneResponse('ignored', { selected_ids: ['frontend'] })),
      });
    vi.mocked(runAgent).mockImplementation(actualRunner.runAgent);

    try {
      await executeIsolatedStructuredInternalAgent(
        'selector system prompt',
        'select reviewers',
        { type: 'object' },
        {
          cwd: '/tmp',
          resolution: {
            provider: 'opencode',
            model: 'opencode/model',
            providerOptions: {},
          },
        },
      );

      expect(setupIsolatedStructured).toHaveBeenCalledWith(expect.objectContaining({
        name: 'takt-internal',
      }));
    } finally {
      setupIsolatedStructured.mockRestore();
    }
  });

  it.each(['copilot', 'cursor', 'kiro'] as const)(
    'should reject %s before invoking an internal agent without isolated structured execution support',
    async (provider) => {
      await expect(executeIsolatedStructuredInternalAgent(
        'selector system prompt',
        'select reviewers',
        { type: 'object' },
        {
          cwd: '/tmp',
          resolution: {
            provider,
            model: undefined,
            providerOptions: {},
          },
        },
      )).rejects.toThrow(`Provider "${provider}" does not support isolated structured execution`);

      expect(runAgent).not.toHaveBeenCalled();
    },
  );
  it('evaluateCondition は構造化出力の matched_index を優先する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));
    const onStream = vi.fn();
    const onActivity = vi.fn();

    const result = await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
      { index: 1, text: 'second' },
    ], { cwd: '/repo', onStream, onActivity });

    expect(result).toBe(1);
    expect(runAgent).toHaveBeenCalledWith(undefined, expect.stringContaining('judge prompt'), expect.objectContaining({
      cwd: '/repo',
      resolvedExecution: expect.objectContaining({ provider: 'mock' }),
      outputSchema: expect.any(Object),
      onStream,
      onActivity,
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

  it('evaluateCondition は provider 分岐なしで暗黙の maxTurns を付与しない', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 1, reason: 'first condition' }));

    await evaluateCondition('agent output', [
      { index: 0, text: 'first' },
    ], {
      cwd: '/repo',
      resolvedProvider: 'claude-terminal',
    });

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedExecution).toMatchObject({ provider: 'claude-terminal' });
    expect(options).not.toHaveProperty('maxTurns');
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
    expect(runAgent).toHaveBeenCalledWith('conductor', expect.stringContaining('structured'), expect.objectContaining({
      outputSchema: expect.any(Object),
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
    expect(runAgent).toHaveBeenNthCalledWith(1, 'conductor', expect.stringContaining('structured'), expect.objectContaining({
      outputSchema: expect.any(Object),
    }));
    expect(runAgent).toHaveBeenNthCalledWith(2, 'conductor', 'tag', expect.objectContaining({
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

  it('judgeStatus は ai_judge fallback の活動中に親 deadline を生存させる', async () => {
    vi.useFakeTimers();
    const inactivityTimeoutMs = 60_000;
    const deadline = createWorkflowStepDeadline('opencode', {
      opencode: { guards: { callTimeoutMs: inactivityTimeoutMs } },
    }, undefined);
    let resolveAiJudgeStarted: (() => void) | undefined;
    const aiJudgeStarted = new Promise<void>((resolve) => {
      resolveAiJudgeStarted = resolve;
    });
    let releaseStreamActivity: (() => void) | undefined;
    const streamActivity = new Promise<void>((resolve) => {
      releaseStreamActivity = resolve;
    });
    let releaseRetryActivity: (() => void) | undefined;
    const retryActivity = new Promise<void>((resolve) => {
      releaseRetryActivity = resolve;
    });
    let releaseAiJudge: (() => void) | undefined;
    const aiJudgeCompletion = new Promise<void>((resolve) => {
      releaseAiJudge = resolve;
    });
    let providerStage = 0;
    vi.mocked(runAgent).mockImplementation(async (_persona, _instruction, options) => {
      providerStage++;
      if (providerStage === 1) {
        return {
          persona: 'conductor',
          status: 'error',
          content: 'structured stage failed',
          timestamp: new Date('2026-08-15T00:00:00.000Z'),
        };
      }
      if (providerStage === 2) {
        return doneResponse('tag did not match');
      }
      options.onActivity?.({ kind: 'attempt_started' });
      resolveAiJudgeStarted?.();
      await streamActivity;
      options.onStream?.({ type: 'text', data: { text: 'ai judge is still working' } });
      await retryActivity;
      options.onActivity?.({ kind: 'attempt_started' });
      await aiJudgeCompletion;
      return doneResponse('ignored', { matched_index: 2, reason: 'second condition' });
    });

    try {
      const judgment = judgeStatus('structured', 'tag', [
        { label: 'a' },
        { label: 'b' },
      ], {
        ...judgeOptions,
        abortSignal: deadline.signal,
        onStream: (event) => recordWorkflowStepProviderEventActivity(
          deadline.recordActivity,
          'review',
          event,
        ),
        onActivity: () => recordWorkflowStepProviderActivity(
          deadline.recordActivity,
          'review',
        ),
      });
      await aiJudgeStarted;
      await vi.advanceTimersByTimeAsync(40_000);
      releaseStreamActivity?.();
      await vi.advanceTimersByTimeAsync(40_000);
      releaseRetryActivity?.();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(deadline.signal.aborted).toBe(false);
      expect(runAgent).toHaveBeenNthCalledWith(
        3,
        undefined,
        expect.any(String),
        expect.objectContaining({
          onStream: expect.any(Function),
          onActivity: expect.any(Function),
        }),
      );

      releaseAiJudge?.();
      await expect(judgment).resolves.toEqual({ candidateIndex: 1, method: 'ai_judge' });
    } finally {
      deadline.dispose();
      vi.useRealTimers();
    }
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

  it('judgeStatus は provider 分岐なしで全内部ステージに暗黙の maxTurns を付与しない', async () => {
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
    expect(vi.mocked(runAgent).mock.calls.every((call) => !('maxTurns' in (call[2] ?? {}))))
      .toBe(true);
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
      outputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          parts: expect.objectContaining({ maxItems: 3 }),
        }),
      }),
    }));
    const [, , callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(callOptions).not.toHaveProperty('maxTurns');
    expect(callOptions).not.toHaveProperty('allowedTools');
    expect(callOptions).not.toHaveProperty('permissionMode');
  });

  it('Given inspectTools, When decomposeTask runs, Then it passes them to the parent decomposition call', async () => {
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
    }));
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).not.toHaveProperty('permissionMode');
  });

  it('Given inspectGuidance without inspectTools, When decomposeTask runs, Then it reaches the decomposition prompt', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      parts: [
        { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
      ],
    }));

    await decomposeTask('instruction', 3, {
      cwd: '/repo',
      persona: 'team-leader',
      inspectGuidance: true,
    });

    const [, prompt, callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(prompt).toContain('You may use read-only inspection tools only');
    expect(prompt).not.toContain('Do not use any tool');
    expect(callOptions).not.toHaveProperty('allowedTools');
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

  it('decomposition は意味的検証診断付きで全partsを再生成する', async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(doneResponse('invalid', { parts: [] }))
      .mockResolvedValueOnce(doneResponse('valid', {
        parts: [{ id: 'p1', title: 'Part 1', instruction: 'Do 1' }],
      }));

    const result = await decomposeTask('instruction', 2, { cwd: '/repo' });

    expect(result.parts).toEqual([
      { id: 'p1', title: 'Part 1', instruction: 'Do 1' },
    ]);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('decomposition は provider 例外を再試行しない', async () => {
    const providerError = new Error('network unavailable');
    const onAgentError = vi.fn();
    vi.mocked(runAgent).mockRejectedValue(providerError);

    await expect(decomposeTask('instruction', 2, {
      cwd: '/repo',
      onAgentError,
    })).rejects.toBe(providerError);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(onAgentError).toHaveBeenCalledOnce();
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
    const onStream = vi.fn();
    const onActivity = vi.fn();

    const result = await decomposeTask('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onStream,
      onActivity,
      onAgentResponse,
    });

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.objectContaining({
        abortSignal: abortController.signal,
        onStream: expect.any(Function),
        onActivity,
      }),
    );
    expect(onAgentResponse).toHaveBeenCalledWith(response);
    expect(result.providerUsage).toEqual(providerUsage);
  });

  it('decomposeTask は応答待ち中の中断後に遅延応答を採用・通知しない', async () => {
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

    resolveRunAgent?.(doneResponse('valid', {
      parts: [{ id: 'p1', title: 'Part 1', instruction: 'Do 1' }],
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onAgentResponse).not.toHaveBeenCalled();
  });

  it('decomposeTask は再生成attemptの中断後に遅延streamを通知しない', async () => {
    const abortController = new AbortController();
    const onStream = vi.fn();
    const streamPublishers: Array<(text: string) => void> = [];
    vi.mocked(runAgent)
      .mockImplementationOnce((_persona, _prompt, runOptions) => {
        streamPublishers.push(
          (text) => runOptions.onStream?.({ type: 'text', data: { text } }),
        );
        return Promise.resolve(doneResponse('invalid', { parts: [] }));
      })
      .mockImplementationOnce((_persona, _prompt, runOptions) => {
        streamPublishers.push(
          (text) => runOptions.onStream?.({ type: 'text', data: { text } }),
        );
        return new Promise(() => {});
      });

    const result = decomposeTask('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onStream,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));

    streamPublishers.at(-1)?.('before abort');
    expect(onStream).toHaveBeenCalledOnce();
    onStream.mockClear();

    abortController.abort(new Error('cancelled while waiting'));
    await expect(result).rejects.toThrow('cancelled while waiting');
    streamPublishers.forEach((publishStream) => publishStream('after abort'));

    expect(onStream).not.toHaveBeenCalled();
  });

  it('decomposeTask は中断後の遅延 provider error を通知しない', async () => {
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

  it('raw decomposition は中断後の遅延応答を上位境界へ返し、公開通知だけを抑止する', async () => {
    const abortController = new AbortController();
    const onAgentResponse = vi.fn();
    let resolveRunAgent: ((response: ReturnType<typeof doneResponse>) => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRunAgent = resolve;
    }));

    const result = requestDecompositionRawResponse('instruction', 2, {
      cwd: '/repo',
      abortSignal: abortController.signal,
      onAgentResponse,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());

    abortController.abort(new Error('cancelled while waiting'));
    const response = doneResponse('late raw response', {
      parts: [{ id: 'p1', title: 'Part 1', instruction: 'Do 1' }],
    });
    resolveRunAgent?.(response);

    await expect(result).resolves.toStrictEqual(response);
    expect(onAgentResponse).not.toHaveBeenCalled();
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
      cancelPartIds: ['p2'],
      parts: [
        { id: 'p3', title: 'Part 3', instruction: 'Do 3' },
      ],
    }));

    const result = await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1', 'p2'],
      { cwd: '/repo', persona: 'team-leader', cancellablePartIds: ['p2'] },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more part',
      cancelPartIds: ['p2'],
      parts: [{ id: 'p3', title: 'Part 3', instruction: 'Do 3' }],
    });
    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.stringContaining('original instruction'), expect.any(Object));
    const [, , callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(callOptions).not.toHaveProperty('maxTurns');
    expect(callOptions).not.toHaveProperty('allowedTools');
    expect(callOptions).not.toHaveProperty('permissionMode');
  });

  it('requestMoreParts は Team の Companion finding を typed evidence として prompt に渡す', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'No additional part is needed',
      cancelPartIds: [],
      parts: [],
    }));
    const finding: CompanionFinding = {
      companion: 'reviewer',
      reviewedAt: '2026-08-23T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'must_fix',
      file: 'src/value.ts',
      line: 12,
      finding: 'The value must be validated before it is stored.',
    };
    const options = {
      cwd: '/repo',
      persona: 'team-leader',
      cancellablePartIds: [],
      companionFindings: [finding],
    } satisfies Parameters<typeof requestMorePartsImpl>[3];

    await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1'],
      options,
    );

    const [, prompt] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(prompt).toContain(finding.companion);
    expect(prompt).toContain(finding.severity);
    expect(prompt).toContain(finding.file);
    expect(prompt).toContain(String(finding.line));
    expect(prompt).toContain(finding.finding);
  });

  it('requestMoreParts は inspect tools を feedback planning call に渡す', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'Enough',
      cancelPartIds: [],
      parts: [],
    }));

    await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        cancellablePartIds: [],
        inspectTools: ['Read', 'Glob', 'Grep'],
      } as Parameters<typeof requestMoreParts>[3] & { inspectTools: string[] },
    );

    expect(runAgent).toHaveBeenCalledWith('team-leader', expect.any(String), expect.any(Object));
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Glob', 'Grep'],
    }));
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).not.toHaveProperty('permissionMode');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(
      'You may use read-only inspection tools only',
    );
  });

  it('requestMoreParts は inspectGuidance を feedback prompt へ伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'Enough',
      cancelPartIds: [],
      parts: [],
    }));

    await requestMoreParts(
      'original instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'done' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        cancellablePartIds: [],
        inspectGuidance: true,
      },
    );

    const [, prompt, callOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(prompt).toContain('You may use read-only inspection tools only');
    expect(prompt).not.toContain('Do not use any tool');
    expect(callOptions).not.toHaveProperty('allowedTools');
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
      { cwd: '/repo', persona: 'team-leader', cancellablePartIds: [] },
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
      cancelPartIds: [],
      parts: [],
    });
    response.providerUsage = providerUsage;
    vi.mocked(runAgent).mockResolvedValue(response);
    const abortController = new AbortController();
    const onAgentResponse = vi.fn();
    const onStream = vi.fn();
    const onActivity = vi.fn();

    const result = await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        cancellablePartIds: [],
        abortSignal: abortController.signal,
        onStream,
        onActivity,
        onAgentResponse,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.objectContaining({
        abortSignal: abortController.signal,
        onStream: expect.any(Function),
        onActivity,
      }),
    );
    expect(onAgentResponse).toHaveBeenCalledWith(response);
    expect(result.providerUsage).toEqual(providerUsage);
  });

  it('requestMoreParts は workflowMeta を runAgent に伝搬する', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('x', {
      done: true,
      reasoning: 'enough',
      cancelPartIds: [],
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
        cancellablePartIds: [],
        workflowMeta,
      } as Parameters<typeof requestMorePartsImpl>[3],
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
      cancelPartIds: [],
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
        cancellablePartIds: [],
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
      cancelPartIds: [],
      parts: [],
    }));

    await requestMoreParts(
      'instruction',
      [{ id: 'p1', title: 'Part 1', status: 'done', content: 'ok' }],
      ['p1'],
      {
        cwd: '/repo',
        persona: 'team-leader',
        cancellablePartIds: [],
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
    expect(runAgent).toHaveBeenCalledWith('conductor', expect.stringContaining('tag instruction'), expect.objectContaining({
      cwd: '/repo',
      resolvedExecution: expect.objectContaining({ provider: 'cursor' }),
    }));
  });

  it('runTagJudgeStage は provider 分岐なしで暗黙の maxTurns を付与しない', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('[REVIEW:1]'));

    const result = await runTagJudgeStage(
      'tag instruction',
      [{ label: 'done' }, { label: 'fix' }],
      { cwd: '/repo', stepName: 'review', resolvedProvider: 'claude-terminal' },
    );

    expect(result).toEqual({ candidateIndex: 0, method: 'phase3_tag' });
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedExecution).toMatchObject({ provider: 'claude-terminal' });
    expect(options).not.toHaveProperty('maxTurns');
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
