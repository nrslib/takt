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
 * また、実 intake を通す回帰ケースは一時 Git fixture 上で独立して検証し、
 * 配線検証を共有 checkout や manager の詳細へ依存させない。
 * その reviewScopeSnapshotId が実際に admission の結果を左右することは
 * finding-review-scope-snapshot-admission.test.ts で別途確認する。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { AgentResponse, FindingContractConfig, WorkflowState, WorkflowStep } from '../core/models/types.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type {
  AutoRoutingConfig,
  FindingIntakeNormalizeConfig,
} from '../core/models/config-types.js';
import type { StepProviderInfo } from '../core/workflow/types.js';
import type {
  FindingContractInstructionContext,
  FindingContractInstructionPolicy,
} from '../core/workflow/instruction/instruction-context.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import type { FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { makeRule, makeStep } from './test-helpers.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import {
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import {
  createPendingFindingReviewNormalization,
  persistPendingFindingReviewNormalization,
} from '../core/workflow/findings/review-publication.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

// 配線ケースでは intake を空振りさせる。実 intake を確認する専用ケースだけが
// vi.importActual でこの mock を一時的に差し替える。
vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: vi.fn().mockResolvedValue(undefined),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { ingestFindingContractResults } from '../core/workflow/findings/contract-intake.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';

const DEFAULT_PROJECT_CWD = mkdtempSync(join(tmpdir(), 'takt-snapshot-wiring-default-'));
const DEFAULT_REPORT_DIR = mkdtempSync(join(tmpdir(), 'takt-snapshot-wiring-reports-'));

afterAll(() => {
  rmSync(DEFAULT_PROJECT_CWD, { recursive: true, force: true });
  rmSync(DEFAULT_REPORT_DIR, { recursive: true, force: true });
});

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
    structuredOutput: { rawFindings: [] },
    timestamp: new Date('2026-07-13T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReviewStep(name: string): WorkflowStep {
  return makeStep({
    name,
    persona: name,
    instruction: `Run ${name}`,
    outputContracts: [{
      name: `${name}.md`,
      format: 'review',
      formatRef: 'review-finding-contract',
    }],
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
      makeRule('all("approved")', 'COMPLETE'),
      makeRule('any("needs_fix")', 'fix'),
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

function makeReviewerAutoRouting(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: { provider: 'mock', model: 'router-model' },
    candidates: [{
      name: 'routed-reviewer',
      provider: 'opencode',
      model: 'openrouter/routed-reviewer-model',
      routingTier: 'medium',
    }],
    defaultPool: 'reviewers',
    candidatePools: {
      reviewers: {
        candidates: ['routed-reviewer'],
        fallback: 'routed-reviewer',
      },
    },
    rules: {
      steps: {
        'ai-antipattern-review': 'routed-reviewer',
        'security-review': 'routed-reviewer',
      },
    },
  };
}

function makeFindingContractContext(
  overrides: Partial<FindingContractInstructionContext> = {},
): FindingContractInstructionContext {
  return {
    ledgerSummary: '{"findings":[]}',
    reportLedgerSummary: '{"ids":[]}',
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    reviewer: {
      mode: 'structured',
      rawFindingsStructuredOutput: createRawFindingsStructuredOutput('round-snapshot-abc123'),
      reviewScopeSnapshotId: 'round-snapshot-abc123',
    },
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getFileQuoteSnapshotIdConst(context: FindingContractInstructionContext): unknown {
  const properties = context.reviewer?.mode === 'structured'
    ? context.reviewer.rawFindingsStructuredOutput.schema.properties
    : undefined;
  if (!isRecord(properties) || !isRecord(properties.rawFindings)) {
    return undefined;
  }
  const items = properties.rawFindings.items;
  if (!isRecord(items) || !isRecord(items.properties) || !isRecord(items.properties.evidence)) {
    return undefined;
  }
  const evidenceItems = items.properties.evidence.items;
  if (!isRecord(evidenceItems) || !Array.isArray(evidenceItems.anyOf)) {
    return undefined;
  }
  const fileQuote = evidenceItems.anyOf.find((branch) => (
    isRecord(branch)
    && isRecord(branch.properties)
    && isRecord(branch.properties.kind)
    && Array.isArray(branch.properties.kind.enum)
    && branch.properties.kind.enum.length === 1
    && branch.properties.kind.enum[0] === 'file_quote'
  ));
  if (!isRecord(fileQuote) || !isRecord(fileQuote.properties) || !isRecord(fileQuote.properties.snapshotId)) {
    return undefined;
  }
  const snapshotIdEnum = fileQuote.properties.snapshotId.enum;
  return Array.isArray(snapshotIdEnum) && snapshotIdEnum.length === 1
    ? snapshotIdEnum[0]
    : undefined;
}

function makeRunner(options: {
  withFindingContract?: boolean;
  projectCwd?: string;
  reportDir?: string;
  findingContractContext?: FindingContractInstructionContext;
  intakeNormalize?: FindingIntakeNormalizeConfig;
  reviewerProviderInfoByStep?: Readonly<Record<string, StepProviderInfo>>;
  reportAttempt?: {
    readonly providerInfo: StepProviderInfo;
    readonly success: boolean;
    readonly usage?: ProviderUsageSnapshot;
  };
  autoRouting?: AutoRoutingConfig;
} = {}): {
  runner: ParallelRunner;
  deps: ParallelRunnerDeps;
} {
  const withFindingContract = options.withFindingContract ?? true;
  const projectCwd = options.projectCwd ?? DEFAULT_PROJECT_CWD;
  const reportDir = options.reportDir ?? DEFAULT_REPORT_DIR;
  const validationReportWriter = vi.fn(
    (report: FindingManagerValidationReport) => (
      join(reportDir, `findings-manager-validation.${report.stepName}.json`)
    ),
  );
  const ledgerRepository = new RevisionedFindingLedgerTestRepository({
    workflowName: 'test-workflow',
    nextId: 1,
    updatedAt: '2026-07-13T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    ...emptyFindingAuthorityProjection(),
  });
  let findingLedgerStore: NonNullable<ParallelRunnerDeps['findingLedgerStore']>;
  findingLedgerStore = {
    runId: 'test-run',
    ledgerIdentity: '/test/finding-review-scope-snapshot-wiring/ledger.json',
    workflowName: 'test-workflow',
    loadLedger: vi.fn(() => ledgerRepository.loadLedger()),
    updateLedger: vi.fn((mutator) => ledgerRepository.updateLedger(mutator)),
    saveLedgerSnapshot: vi.fn(),
    saveRawFindings: vi.fn(),
    saveManagerValidationReport: validationReportWriter,
    ...createFindingManagerPublicationDouble(
      (report) => validationReportWriter(report),
      ledgerRepository,
    ),
    saveConflictAdjudicationReport: vi.fn(),
  } as unknown as NonNullable<ParallelRunnerDeps['findingLedgerStore']>;
  const stepExecutor = {
    buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
    buildPhase1Instruction: vi.fn((instruction: string) => instruction),
    emitStepReports: vi.fn(),
    persistPreviousResponseSnapshot: vi.fn(),
    normalizeStructuredOutputWithDiagnostics: vi.fn(
      (_step: WorkflowStep, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      }),
    ),
    resumeFindingReviewPublication: vi.fn(() => undefined),
    applyPostExecutionRulesOnly: vi.fn(
      async (_step: WorkflowStep, _state: WorkflowState, response: AgentResponse) => ({
        ...response,
        matchedRuleIndex: 0,
        matchedRuleMethod: 'phase3_tag' as const,
      }),
    ),
  };
  Object.assign(stepExecutor, {
    prepareFindingReviewPublication: vi.fn(async (input: {
      step: WorkflowStep;
      parentStepName: string;
      stepIteration: number;
      phase1Response: AgentResponse;
      onProviderAttempt: (
        providerInfo: StepProviderInfo,
        success: boolean,
        usage: ProviderUsageSnapshot | undefined,
      ) => void;
    }) => {
      if (options.reportAttempt !== undefined) {
        input.onProviderAttempt(
          options.reportAttempt.providerInfo,
          options.reportAttempt.success,
          options.reportAttempt.usage,
        );
      }
      const normalized = stepExecutor.normalizeStructuredOutputWithDiagnostics(
        input.step,
        input.phase1Response,
      );
      const rawFindings = normalized.response.structuredOutput?.rawFindings;
      if (!Array.isArray(rawFindings)) {
        throw new Error(`Test reviewer "${input.step.name}" has no rawFindings`);
      }
      const reportName = input.step.outputContracts?.[0]?.name;
      if (reportName === undefined) {
        throw new Error(`Test reviewer "${input.step.name}" has no report`);
      }
      return {
        publication: {
          publicationId: `publication-${input.step.name}`,
          scopeIdentity: findingLedgerStore.ledgerIdentity,
          callNamespace: '',
          parentStepName: input.parentStepName,
          stepIteration: input.stepIteration,
          reviewerStepName: input.step.name,
          reportName,
          reportContent: input.phase1Response.content,
          reportDigest: `digest-${input.step.name}`,
          rawFindings,
        },
        response: normalized.response,
      };
    }),
  });
  const deps: ParallelRunnerDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn((_step, runtime) => ({
        resolvedProvider: runtime?.providerInfo?.provider,
        resolvedModel: runtime?.providerInfo?.model,
      })),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
      resolveStepProviderModel: vi.fn((resolvedStep, runtime) => (
        runtime?.providerInfo
        ?? options.reviewerProviderInfoByStep?.[resolvedStep.name]
        ?? { provider: 'claude', model: 'claude-sonnet' }
      )),
      resolveStepProviderModelBeforeAutoRouting: vi.fn((_step, runtime) => (
        runtime?.providerInfo
        ?? options.reviewerProviderInfoByStep?.[_step.name]
        ?? (
          options.autoRouting === undefined
            ? { provider: 'claude', model: 'claude-sonnet' }
            : { provider: undefined, model: undefined }
        )
      )),
      buildFindingContractInstructionContext: vi.fn().mockReturnValue(
        options.findingContractContext ?? makeFindingContractContext(),
      ),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: stepExecutor as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: {
      projectCwd,
      ...(options.autoRouting !== undefined
        ? { autoRouting: options.autoRouting }
        : {}),
    },
    getCwd: () => projectCwd,
    getReportDir: () => reportDir,
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'test task',
    getInteractive: () => false,
    observabilityEnabled: false,
    structuredCaller: {
      evaluateCondition: vi.fn(),
      judgeStatus: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    refreshFindingsState: vi.fn(),
    emitEvent: vi.fn(),
    onPhaseComplete: vi.fn(),
    ...(withFindingContract ? { findingContract: FINDING_CONTRACT } : {}),
    ...(options.intakeNormalize !== undefined
      ? { intakeNormalize: options.intakeNormalize }
      : {}),
    findingLedgerStore,
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
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
  });

  it('builds one snapshot context per round and shares it with every parallel reviewer', async () => {
    const { runner, deps } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review' }));

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    // WorkflowEngineSetup と同じヘルパ経由で、ラウンドに1回だけ呼ばれる
    // （sub-step ごとに独立して呼ぶと、間に working tree が変化した場合に
    // reviewer ごとに異なる snapshotId を配ってしまう — 並行実行の semaphore
    // 直列化時に特に問題になる）。
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledTimes(1);
    expect(deps.optionsBuilder.buildFindingContractInstructionContext)
      .toHaveBeenCalledWith(
        step.parallel![0],
        { kind: 'structured', reportGeneration: 'structured', intake: 'reviewer_structured' },
      );

    const builtContext = vi.mocked(deps.optionsBuilder.buildFindingContractInstructionContext).mock.results[0]?.value;
    expect(builtContext).toBeDefined();
    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    expect(buildInstructionCalls).toHaveLength(2);
    for (const call of buildInstructionCalls) {
      const findingContractPolicy = call[6] as FindingContractInstructionPolicy | undefined;
      expect(findingContractPolicy?.mode).toBe('explicit');
      if (findingContractPolicy?.mode !== 'explicit') throw new Error('Expected explicit Finding Contract context');
      expect(findingContractPolicy.context).toBe(builtContext);
      expect(findingContractPolicy.context.reviewer?.reviewScopeSnapshotId).toBe('round-snapshot-abc123');
      expect(getFileQuoteSnapshotIdConst(findingContractPolicy.context)).toBeUndefined();
    }

    const outputContract = builtContext?.reviewer?.mode === 'structured'
      ? builtContext.reviewer.rawFindingsStructuredOutput
      : undefined;
    expect(outputContract).toBeDefined();
    for (const call of vi.mocked(deps.optionsBuilder.buildAgentOptions).mock.calls) {
      const executableStep = call[0] as WorkflowStep;
      expect(executableStep.structuredOutput).toBe(outputContract);
      expect(executableStep.structuredOutput?.schema).toBe(outputContract?.schema);
    }
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ingestFindingContractResults).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deps.stepExecutor.applyPostExecutionRulesOnly)
        .mock.invocationCallOrder[0]!,
    );
  });

  it('shares one snapshot across structured and normalized reviewers', async () => {
    const { runner, deps } = makeRunner({
      intakeNormalize: {
        provider: 'codex',
        model: 'gpt-5.6-terra',
        targets: [{
          provider: 'opencode',
          model: 'ollama-cloud/gemma4:31b',
        }],
      },
      reviewerProviderInfoByStep: {
        'ai-antipattern-review': {
          provider: 'opencode',
          model: 'ollama-cloud/gemma4:31b',
        },
        'security-review': {
          provider: 'codex',
          model: 'gpt-5.6-sol',
        },
      },
    });
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review',
      content: '## Finding A\nIssue: A',
      sessionId: 'session-a',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '## Finding B\nIssue: B',
      sessionId: 'session-b',
    }));

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledTimes(1);
    expect(deps.optionsBuilder.buildFindingContractInstructionContext)
      .toHaveBeenCalledWith(
        step.parallel![0],
        { kind: 'structured', reportGeneration: 'structured', intake: 'reviewer_structured' },
      );
    const instructionPolicies = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls
      .map((call) => call[6] as FindingContractInstructionPolicy);
    expect(instructionPolicies.map((policy) => policy.context.reviewer?.mode)).toEqual([
      'plain_text_normalized',
      'structured',
    ]);
    expect(instructionPolicies.map(
      (policy) => policy.context.reviewer?.reviewScopeSnapshotId,
    )).toEqual([
      'round-snapshot-abc123',
      'round-snapshot-abc123',
    ]);
    const executableSteps = vi.mocked(deps.optionsBuilder.buildAgentOptions).mock.calls
      .map((call) => call[0] as WorkflowStep);
    expect(executableSteps[0]?.structuredOutput).toBeUndefined();
    expect(executableSteps[1]?.structuredOutput).toBeDefined();
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
  });

  it('records parallel Phase 1 and report attempts once with their actual providers', async () => {
    const phase1UsageA: ProviderUsageSnapshot = {
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      usageMissing: false,
    };
    const phase1UsageB: ProviderUsageSnapshot = {
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      usageMissing: false,
    };
    const reportUsage: ProviderUsageSnapshot = {
      inputTokens: 17,
      outputTokens: 7,
      totalTokens: 24,
      usageMissing: false,
    };
    const onDelegatedAgentUsage = vi.fn();
    const { runner, deps } = makeRunner({
      reportAttempt: {
        providerInfo: {
          provider: 'claude',
          model: 'fallback-review-model',
        },
        success: true,
        usage: reportUsage,
      },
    });
    deps.engineOptions.onDelegatedAgentUsage = onDelegatedAgentUsage;
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review',
      providerUsage: phase1UsageA,
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      providerUsage: phase1UsageB,
    }));

    await runner.runParallelStep(
      makeParallelStep(),
      makeState(),
      'test task',
      5,
      vi.fn(),
    );

    expect(onDelegatedAgentUsage).toHaveBeenCalledTimes(4);
    expect(onDelegatedAgentUsage.mock.calls).toEqual(expect.arrayContaining([
      [
        {
          step: 'ai-antipattern-review',
          stepType: 'parallel',
          provider: 'claude',
          providerModel: 'claude-sonnet',
        },
        { success: true, usage: phase1UsageA },
      ],
      [
        {
          step: 'security-review',
          stepType: 'parallel',
          provider: 'claude',
          providerModel: 'claude-sonnet',
        },
        { success: true, usage: phase1UsageB },
      ],
      [
        {
          step: 'ai-antipattern-review',
          stepType: 'parallel',
          provider: 'claude',
          providerModel: 'fallback-review-model',
        },
        { success: true, usage: reportUsage },
      ],
      [
        {
          step: 'security-review',
          stepType: 'parallel',
          provider: 'claude',
          providerModel: 'fallback-review-model',
        },
        { success: true, usage: reportUsage },
      ],
    ]));
  });

  it('does not run manager intake when one normalized reviewer publication fails', async () => {
    const { runner, deps } = makeRunner({
      intakeNormalize: {
        provider: 'codex',
        model: 'gpt-5.6-terra',
      },
    });
    vi.mocked(deps.stepExecutor.prepareFindingReviewPublication)
      .mockRejectedValueOnce(new Error('invalid normalized report'));
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review' }));

    const result = await runner.runParallelStep(
      makeParallelStep(),
      makeState(),
      'test task',
      5,
      vi.fn(),
    );

    expect(result.response.status).toBe('error');
    expect(vi.mocked(deps.onPhaseComplete!).mock.calls.map(([phaseStep]) => phaseStep.name).sort())
      .toEqual(['ai-antipattern-review', 'security-review']);
    expect(ingestFindingContractResults).not.toHaveBeenCalled();
    expect(deps.stepExecutor.applyPostExecutionRulesOnly).not.toHaveBeenCalled();
  });

  it('reuses an already persisted sibling publication without rerunning that reviewer', async () => {
    const { runner, deps } = makeRunner();
    vi.mocked(deps.stepExecutor.resumeFindingReviewPublication)
      .mockImplementation(({ step: reviewerStep }) => (
        reviewerStep.name === 'ai-antipattern-review'
          ? {
              publication: {
                publicationId: 'publication-ai-antipattern-review',
                scopeIdentity: deps.findingLedgerStore!.ledgerIdentity,
                callNamespace: '',
                parentStepName: 'reviewers',
                stepIteration: 1,
                reviewerStepName: reviewerStep.name,
                reportName: 'ai-antipattern-review.md',
                reportContent: '**APPROVE**',
                reportDigest: 'digest-ai-antipattern-review',
                rawFindings: [],
              },
              response: makeAgentResponse({
                persona: reviewerStep.name,
                content: '**APPROVE**',
                structuredOutput: { rawFindings: [] },
              }),
            }
          : undefined
      ));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '**APPROVE**',
    }));

    const result = await runner.runParallelStep(
      makeParallelStep(),
      makeState(),
      'test task',
      5,
      vi.fn(),
    );

    expect(result.response.status).toBe('done');
    expect(executeAgent).toHaveBeenCalledOnce();
    expect(deps.stepExecutor.prepareFindingReviewPublication)
      .toHaveBeenCalledOnce();
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
  });

  it('parallelのreviewer fallback後にnormalizer fallbackしても保存済みidentityで再開する', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-parallel-pending-project-'));
    const sourcePaths = buildRunPaths(projectCwd, 'source-run');
    const targetPaths = buildRunPaths(projectCwd, 'target-run');
    const reportDir = targetPaths.reportsAbs;
    try {
      mkdirSync(sourcePaths.runRootAbs, { recursive: true });
      const intakeNormalize: FindingIntakeNormalizeConfig = {
        provider: 'mock',
        model: 'normalizer-model',
        targets: [{
          provider: 'opencode',
          model: 'openrouter/routed-reviewer-model',
        }],
      };
      const { runner, deps } = makeRunner({
        projectCwd,
        reportDir,
        intakeNormalize,
      });
      const reportContent = [
        '# AI Antipattern Review',
        '',
        'Issue: the module boundary couples unrelated responsibilities.',
      ].join('\n');
      const rawFinding = {
        rawExcerpt: 'Issue: the module boundary couples unrelated responsibilities.',
        candidate: {
          rawFindingId: null,
          familyTag: 'architecture',
          severity: 'high',
          title: 'Module boundary is too broad',
          description: 'The module boundary couples unrelated responsibilities.',
          suggestion: null,
          relation: 'new',
          targetFindingIds: [],
          target: null,
          evidenceRequests: [],
        },
      };
      persistPendingFindingReviewNormalization(
        sourcePaths.reportsAbs,
        createPendingFindingReviewNormalization({
          identity: {
            scopeIdentity: 'source-sqlite-scope',
            callNamespace: '',
            parentStepName: 'reviewers',
            stepIteration: 1,
            reviewerStepName: 'ai-antipattern-review',
            reportName: 'ai-antipattern-review.md',
          },
          workflowName: 'test-workflow',
          reportContent,
          reviewerExecutionIdentity: {
            provider: 'opencode',
            model: 'openrouter/routed-reviewer-model',
            providerOptions: {
              opencode: {
                variant: 'reviewer-fallback',
              },
            },
          },
        }),
      );
      inheritResumeReportSnapshot({
        cwd: projectCwd,
        sourceRunSlug: 'source-run',
        targetRunSlug: 'target-run',
      });
      const normalizeFindingIntake = vi.fn().mockResolvedValue(
        makeAgentResponse({
          persona: 'finding-intake-normalizer',
          content: '{"rawFindings":[]}',
          structuredOutput: { rawFindings: [rawFinding] },
        }),
      );
      const resumeExecutor = new StepExecutor({
        optionsBuilder: {
          ...deps.optionsBuilder,
          resolveStepProviderModel: vi.fn((resolvedStep, runtime) => (
            runtime?.providerInfo ?? {
              provider: resolvedStep.provider,
              model: resolvedStep.model,
              providerOptions: resolvedStep.providerOptions,
            }
          )),
        } as unknown as StepExecutorDeps['optionsBuilder'],
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
        structuredCaller: { normalizeFindingIntake },
        intakeNormalize,
        findingContract: FINDING_CONTRACT,
        getRunPaths: () => ({ reportsAbs: reportDir }),
        getFindingCallNamespace: () => '',
        getLanguage: () => 'en',
        getWorkflowName: () => 'test-workflow',
        recordSynthesizedAgentUsage: vi.fn(),
        findingLedgerStore: deps.findingLedgerStore,
      } as unknown as StepExecutorDeps);
      vi.mocked(deps.stepExecutor.resumeFindingReviewPublication)
        .mockImplementation((input) => (
          resumeExecutor.resumeFindingReviewPublication(input)
        ));
      queueAgentResponse(makeAgentResponse({
        persona: 'security-review',
        content: '**APPROVE**',
      }));

      const result = await runner.runParallelStep(
        makeParallelStep(),
        makeState(),
        'test task',
        5,
        vi.fn(),
        {
          fallback: {
            reason: 'rate_limited',
            reasonDetail: 'normalizer rate limited',
            originalIteration: 1,
            previousProvider: 'mock',
            previousModel: 'normalizer-model',
            currentProvider: 'mock',
            currentModel: 'fallback-normalizer-model',
            stepName: 'reviewers',
            reportDir,
            origin: {
              stage: 'finding_intake_normalizer',
              reviewerStepName: 'ai-antipattern-review',
            },
          },
        },
      );

      expect(result.response.status, result.response.content).toBe('done');
      expect(executeAgent).toHaveBeenCalledOnce();
      expect(normalizeFindingIntake).toHaveBeenCalledOnce();
      expect(normalizeFindingIntake.mock.calls[0]?.[0]).toBe(reportContent);
      expect(normalizeFindingIntake.mock.calls[0]?.[1]).toMatchObject({
        provider: 'mock',
        model: 'fallback-normalizer-model',
      });
      expect(deps.stepExecutor.prepareFindingReviewPublication)
        .toHaveBeenCalledOnce();
      expect(vi.mocked(deps.stepExecutor.prepareFindingReviewPublication)
        .mock.calls[0]?.[0].step.name).toBe('security-review');
      expect(vi.mocked(deps.stepExecutor.applyPostExecutionRulesOnly).mock.calls)
        .toHaveLength(2);
      expect(vi.mocked(deps.stepExecutor.applyPostExecutionRulesOnly).mock.calls
        .map((call) => call[4]?.providerInfo?.model)).toEqual([
        'openrouter/routed-reviewer-model',
        'claude-sonnet',
      ]);
      expect(vi.mocked(deps.stepExecutor.applyPostExecutionRulesOnly)
        .mock.calls[0]?.[4]?.providerInfo?.providerOptions).toEqual({
        opencode: {
          variant: 'reviewer-fallback',
        },
      });
      expect(vi.mocked(deps.stepExecutor.buildInstruction).mock.calls
        .map((call) => call[5])).toEqual([undefined, undefined]);
      expect(ingestFindingContractResults).toHaveBeenCalledOnce();
      expect(vi.mocked(ingestFindingContractResults).mock.calls[0]?.[0]
        .subResults.find(({ subStep }) => subStep.name === 'ai-antipattern-review')
        ?.publication.reportContent).toBe(reportContent);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it.each(['blocked', 'rate_limited'] as const)(
    'pending publication resumeが%sならそのreviewerを再実行せずmanager intakeへ進まない',
    async (status) => {
      const { runner, deps } = makeRunner();
      vi.mocked(deps.stepExecutor.resumeFindingReviewPublication)
        .mockImplementation(({ step: reviewerStep }) => (
          reviewerStep.name === 'ai-antipattern-review'
            ? {
                terminalResponse: makeAgentResponse({
                  persona: reviewerStep.name,
                  status,
                  content: `normalizer ${status}`,
                }),
              }
            : undefined
        ));
      queueAgentResponse(makeAgentResponse({
        persona: 'security-review',
        content: '**APPROVE**',
      }));

      const result = await runner.runParallelStep(
        makeParallelStep(),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe(status);
      expect(executeAgent).toHaveBeenCalledOnce();
      expect(deps.stepExecutor.prepareFindingReviewPublication)
        .toHaveBeenCalledOnce();
      expect(ingestFindingContractResults).not.toHaveBeenCalled();
    },
  );

  it('resolves an open finding from a structured parallel lifecycle confirmation', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-parallel-normalized-confirmation-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-parallel-normalized-reports-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/fixed.ts'), 'const fixed = true;\n');
      initializeGitFixture(projectCwd, ['src/fixed.ts']);
      const evidence = verifiedSourceQuoteFields(projectCwd, 'src/fixed.ts', 1);
      const confirmation = reviewerRawExtractionFixture({
        rawFindingId: 'confirmation-open',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'The open issue is fixed.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        evidence: [evidence],
      });
      const structuredContext = makeFindingContractContext({
        hasOpenFindings: true,
        reviewer: {
          mode: 'structured',
          rawFindingsStructuredOutput: createRawFindingsStructuredOutput(evidence.snapshotId),
          reviewScopeSnapshotId: evidence.snapshotId,
        },
      });
      const { runner, deps } = makeRunner({
        projectCwd,
        reportDir,
        findingContractContext: structuredContext,
      });
      const ledgerStore = deps.findingLedgerStore!;
      await ledgerStore.updateLedger(() => ({
        ledger: authorizeFindingLedgerFixture({
          workflowName: 'test-workflow',
          nextId: 2,
          updatedAt: '2026-07-13T00:00:00.000Z',
          findings: [{
            id: 'F-0001',
            status: 'open',
            lifecycle: 'new',
            revision: 1,
            severity: 'high',
            title: 'Open issue',
            evidenceIds: [],
            reviewers: ['ai-antipattern-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'old-run', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
            lastSeen: { runId: 'old-run', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
          }],
          rawFindings: [{
            rawFindingId: 'raw-existing',
            stepName: 'reviewers',
            reviewer: 'ai-antipattern-review',
            familyTag: 'bug',
            severity: 'high',
            title: 'Open issue',
            description: 'Previously reported issue.',
            suggestion: null,
            relation: 'new',
            targetFindingId: null,
            evidence: [evidence],
          }],
          evidenceRecords: [],
          conflicts: [],
          interpretations: [],
          ...emptyFindingAuthorityProjection(),
        }),
        result: undefined,
      }));
      queueAgentResponse(makeAgentResponse({
        persona: 'ai-antipattern-review',
        content: confirmation.rawExcerpt,
        structuredOutput: { rawFindings: [confirmation] },
      }));
      queueAgentResponse(makeAgentResponse({
        persona: 'security-review',
        content: '**APPROVE**',
      }));
      const actualContractIntake = await vi.importActual<typeof import('../core/workflow/findings/contract-intake.js')>(
        '../core/workflow/findings/contract-intake.js',
      );
      vi.mocked(ingestFindingContractResults).mockImplementationOnce(
        actualContractIntake.ingestFindingContractResults,
      );

      await runner.runParallelStep(makeParallelStep(), makeState(), 'test task', 5, vi.fn());

      expect(ledgerStore.loadLedger().findings.find(
        (finding) => finding.id === 'F-0001',
      )?.status).toBe('resolved');
      expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('preserves a non-open confirmation as audit-only through the actual parallel intake path', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-parallel-snapshot-wiring-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-parallel-snapshot-reports-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/fixed.ts'), 'const fixed = true;\n');
      initializeGitFixture(projectCwd, ['src/fixed.ts']);
      const evidence = verifiedSourceQuoteFields(projectCwd, 'src/fixed.ts', 1);
      const findingContractContext = makeFindingContractContext({
        reviewer: {
          mode: 'structured',
          rawFindingsStructuredOutput: createRawFindingsStructuredOutput(evidence.snapshotId),
          reviewScopeSnapshotId: evidence.snapshotId,
        },
      });
      const { runner, deps } = makeRunner({
        projectCwd,
        reportDir,
        findingContractContext,
      });
      const reviewerRawFindings = [reviewerRawExtractionFixture({
        rawFindingId: 'confirmation-resolved',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'The previously reported issue remains fixed.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        evidence: [evidence],
      })];
      let ledger: FindingLedger = authorizeFindingLedgerFixture({
        workflowName: 'test-workflow',
        nextId: 2,
        updatedAt: '2026-07-13T00:00:00.000Z',
        findings: [{
          id: 'F-0001',
          status: 'resolved',
          lifecycle: 'resolved',
          revision: 1,
          severity: 'high',
          title: 'Fixed issue',
          evidenceIds: [],
          reviewers: ['ai-antipattern-review'],
          rawFindingIds: ['raw-existing'],
          firstSeen: { runId: 'old-run', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
          lastSeen: { runId: 'old-run', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
        }],
        rawFindings: [{
          rawFindingId: 'raw-existing',
          stepName: 'reviewers',
          reviewer: 'ai-antipattern-review',
          familyTag: 'bug',
          severity: 'high',
          title: 'Fixed issue',
          description: 'Previously reported issue.',
          suggestion: null,
          relation: 'new',
          targetFindingId: null,
          evidence: [evidence],
        }],
        evidenceRecords: [],
        conflicts: [],
        interpretations: [],
        ...emptyFindingAuthorityProjection(),
      });
      const ledgerStore = deps.findingLedgerStore!;
      await ledgerStore.updateLedger(() => ({ ledger, result: undefined }));
      vi.mocked(ledgerStore.saveRawFindings).mockReturnValue(join(projectCwd, 'raw-findings.json'));
      queueAgentResponse(makeAgentResponse({
        persona: 'ai-antipattern-review',
        content: reviewerRawFindings[0]!.rawExcerpt,
        structuredOutput: { rawFindings: reviewerRawFindings },
      }));
      queueAgentResponse(makeAgentResponse({
        persona: 'security-review',
        structuredOutput: { rawFindings: [] },
      }));
      const actualContractIntake = await vi.importActual<typeof import('../core/workflow/findings/contract-intake.js')>(
        '../core/workflow/findings/contract-intake.js',
      );
      vi.mocked(ingestFindingContractResults).mockImplementationOnce(actualContractIntake.ingestFindingContractResults);

      await runner.runParallelStep(makeParallelStep(), makeState(), 'test task', 5, vi.fn());

      ledger = ledgerStore.loadLedger();
      const reports = vi.mocked(ledgerStore.saveManagerValidationReport).mock.calls
        .map(([report]) => report);
      expect(executeAgent).toHaveBeenCalledTimes(2);
      expect(ingestFindingContractResults).toHaveBeenCalledOnce();
      const intake = vi.mocked(ingestFindingContractResults).mock.calls[0]![0];
      expect(intake.subResults[0]?.relationClarification).toBeUndefined();
      expect(intake.subResults[0]?.publication.rawFindings).toEqual(reviewerRawFindings);
      expect(ledger.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
      expect(ledger.findings.every((finding) => finding.provisional === undefined)).toBe(true);
      expect(reports.at(-1)?.unsupportedRawFindings?.some(
        (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
      )).toBe(true);
      expect(reports.at(-1)?.rawNormalizations?.find(
        (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
      )?.ambiguityCodes).toContain('confirmation-target-not-open');
      expect(reports.at(-1)?.interpretationStats?.managerCalls).toBe(0);
      expect(existsSync(
        join(projectCwd, 'findings-manager-validation.reviewers.json'),
      )).toBe(false);
      expect(existsSync(
        join(reportDir, 'findings-manager-validation.reviewers.json'),
      )).toBe(true);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('keeps the engine snapshot out of the reviewer schema', async () => {
    const { runner, deps } = makeRunner();
    vi.mocked(deps.optionsBuilder.buildFindingContractInstructionContext).mockReturnValue(
      makeFindingContractContext({ reviewScopeSnapshotId: 'prompt-snapshot-B' }),
    );
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review' }));

    const result = await runner.runParallelStep(
      makeParallelStep(),
      makeState(),
      'test task',
      5,
      vi.fn(),
    );

    expect(result.response.status).toBe('done');
    expect(getFileQuoteSnapshotIdConst(
      vi.mocked(deps.optionsBuilder.buildFindingContractInstructionContext).mock.results[0]!.value,
    )).toBeUndefined();
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it('does not call optionsBuilder.buildFindingContractInstructionContext when the workflow has no finding_contract configured', async () => {
    const { runner, deps } = makeRunner({ withFindingContract: false });
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review', content: '[STEP:1] approved' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review', content: '[STEP:1] approved' }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('done');
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).not.toHaveBeenCalled();
    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    for (const call of buildInstructionCalls) {
      expect(call[6]).toBeUndefined();
    }
  });
});
