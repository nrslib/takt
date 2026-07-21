/**
 * codex 対策#4 の配線バグ回帰テスト（ParallelRunner 側）。
 *
 * ParallelRunner が finding-contract の instruction context を inline で
 * 組み立てていたため、WorkflowEngineSetup.buildFindingContractInstructionContext
 * が唯一セットする reviewScopeSnapshotId が並列レビュアーの instruction には
 * 一切渡っていなかった（finding-contract-instruction.ts の `?? ''` がこれを
 * サイレントに空文字へ落とし、バグを不可視にしていた）。
 *
 * ここでは ParallelRunner が optionsBuilder.buildFindingContractInstructionContext
 * （WorkflowEngineSetup と同じヘルパ）をラウンドに1回だけ呼び、その結果
 * （reviewScopeSnapshotId を含む）を全 sub-step instruction へ配ることを固定する。
 * その reviewScopeSnapshotId が実際に admission の結果を左右することは
 * finding-review-scope-snapshot-admission.test.ts で別途確認する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { AgentResponse, FindingContractConfig, WorkflowState, WorkflowStep } from '../core/models/types.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';
import { makeRule, makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

// manager 検証（runFindingManagerForStep 経由の突合）は
// finding-review-scope-snapshot-admission.test.ts が別途 cover するため、
// ここでは ingestFindingContractResults を空振りさせ、instruction 組み立てだけを見る。
vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: vi.fn().mockResolvedValue(undefined),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'reviewers',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeAgentResponse(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    persona: 'test-agent',
    status: 'done',
    content: '[STEP:1] approved',
    timestamp: new Date('2026-07-13T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReviewStep(name: string): WorkflowStep {
  return makeStep({
    name,
    persona: name,
    instruction: `Run ${name}`,
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });
}

function makeParallelStep(): WorkflowStep {
  return makeStep({
    name: 'reviewers',
    instruction: 'Run parallel reviewers',
    parallel: [
      makeReviewStep('ai-antipattern-review'),
      makeReviewStep('security-review'),
    ],
    rules: [
      makeRule('all("approved")', 'COMPLETE', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
      makeRule('any("needs_fix")', 'fix', {
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateConditionText: 'needs_fix',
      }),
    ],
  });
}

const FINDING_CONTRACT: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile findings.',
    outputContract: 'Return JSON.',
  },
};

function makeFindingContractContext(
  overrides: Partial<FindingContractInstructionContext> = {},
): FindingContractInstructionContext {
  return {
    ledgerCopyPath: '.takt/runs/test/reports/findings-ledger.json',
    ledgerSummary: '{"findings":[]}',
    reportLedgerSummary: '{"ids":[]}',
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    rawFindingsJsonSchema: { type: 'object' },
    reviewScopeSnapshotId: 'round-snapshot-abc123',
    ...overrides,
  };
}

function makeRunner(options: { withFindingContract?: boolean } = {}): {
  runner: ParallelRunner;
  deps: ParallelRunnerDeps;
} {
  const withFindingContract = options.withFindingContract ?? true;
  const deps: ParallelRunnerDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      buildFindingContractInstructionContext: vi.fn().mockReturnValue(makeFindingContractContext()),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step: WorkflowStep, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      })),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: {
      projectCwd: '/tmp/project',
    },
    getCwd: () => '/tmp/project',
    getReportDir: () => '.takt/runs/test/reports',
    getWorkflowName: () => 'test-workflow',
    getInteractive: () => false,
    observabilityEnabled: false,
    detectRuleIndex: vi.fn(),
    structuredCaller: {
      evaluateCondition: vi.fn(),
      judgeStatus: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    refreshFindingsState: vi.fn(),
    emitEvent: vi.fn(),
    ...(withFindingContract ? { findingContract: FINDING_CONTRACT } : {}),
    findingLedgerStore: {
      workflowName: 'test-workflow',
      loadLedger: vi.fn().mockReturnValue({
        version: 1,
        workflowName: 'test-workflow',
        nextId: 1,
        updatedAt: '2026-07-13T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
      }),
      saveLedger: vi.fn(),
      updateLedger: vi.fn(),
      createRunCopy: vi.fn().mockReturnValue('.takt/runs/test/reports/findings-ledger.json'),
      saveRawFindings: vi.fn(),
      saveManagerValidationReport: vi.fn(),
      saveConflictAdjudicationReport: vi.fn(),
      saveNeedsAdjudicationReport: vi.fn(),
    } as unknown as ParallelRunnerDeps['findingLedgerStore'],
    runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    updateMaxSteps: vi.fn(),
    setActiveResumePoint: vi.fn(),
    getRunId: () => 'test-run',
    getFindingCallNamespace: () => '',
  };
  return { runner: new ParallelRunner(deps), deps };
}

function queueAgentResponse(response: AgentResponse): void {
  vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    return response;
  });
}

describe('ParallelRunner finding-contract instruction wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(detectMatchedRule).mockResolvedValue({ index: 0, method: 'phase1_tag' });
  });

  it('builds the finding-contract context once per round via optionsBuilder and shares the same non-empty reviewScopeSnapshotId across every reviewer instruction', async () => {
    const { runner, deps } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review', content: '[STEP:1] approved' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review', content: '[STEP:1] approved' }));

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    // WorkflowEngineSetup と同じヘルパ経由で、ラウンドに1回だけ呼ばれる
    // （sub-step ごとに独立して呼ぶと、間に working tree が変化した場合に
    // reviewer ごとに異なる snapshotId を配ってしまう — 並行実行の semaphore
    // 直列化時に特に問題になる）。
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledTimes(1);
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledWith(step, true);

    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    expect(buildInstructionCalls).toHaveLength(2);
    for (const call of buildInstructionCalls) {
      const findingContractArg = call[6] as FindingContractInstructionContext | undefined;
      expect(findingContractArg?.reviewScopeSnapshotId).toBe('round-snapshot-abc123');
      expect(findingContractArg?.ledgerCopyPath).toBe('.takt/runs/test/reports/findings-ledger.json');
    }
  });

  it('does not call optionsBuilder.buildFindingContractInstructionContext when the workflow has no finding_contract configured', async () => {
    const { runner, deps } = makeRunner({ withFindingContract: false });
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review', content: '[STEP:1] approved' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review', content: '[STEP:1] approved' }));

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(deps.optionsBuilder.buildFindingContractInstructionContext).not.toHaveBeenCalled();
    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    for (const call of buildInstructionCalls) {
      expect(call[6]).toBeUndefined();
    }
  });
});
