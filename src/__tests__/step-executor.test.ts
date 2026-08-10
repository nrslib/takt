import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import {
  createStructuredOutputNormalizerRegistry,
  type StructuredOutputNormalizerRegistry,
} from '../core/workflow/engine/structured-output-normalizer.js';
import type { AgentResponse, WorkflowState } from '../core/models/types.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import {
  makeStep,
  makeWorkflowResumePointEntry,
} from './test-helpers.js';
import { createTeamLeaderPlanningStep } from '../core/workflow/engine/team-leader-common.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { PHASE1_EMPTY_OUTPUT_ERROR } from '../core/workflow/engine/phase1-empty-recovery.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: vi.fn().mockResolvedValue({ status: 'updated' }),
  };
});

// slot 本体の反復は finding-fc-restatement-slot.test.ts が持つ。ここで固定するのは
// 単独ステップ経路が slot へ渡す配線（owner / 提示予算 / 取り込み契約 / terminal 置換）。
vi.mock('../core/workflow/findings/restatement-slot-runner.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../core/workflow/findings/restatement-slot-runner.js')
  >();
  return {
    ...actual,
    runFindingRestatementSlot: vi.fn().mockResolvedValue(undefined),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { ingestFindingContractResults } from '../core/workflow/findings/contract-intake.js';
import {
  runFindingRestatementSlot,
  type FindingRestatementSlotInput,
} from '../core/workflow/findings/restatement-slot-runner.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import { RawFindingsOutputValidationJsonSchema } from '../core/models/finding-schemas.js';
import type { FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import type { CanonicalFindingReviewPublication } from '../core/workflow/findings/review-publication.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  createPendingFindingReviewNormalization,
  createFindingReviewPublication,
  loadPendingFindingReviewNormalization,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  persistPendingFindingReviewNormalization,
  persistFindingReviewPublication,
  publishFindingReviewPublication,
} from '../core/workflow/findings/review-publication.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'implement',
    iteration: 3,
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

describe('StepExecutor', () => {
  let cwd: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'step-executor-'));
    runPaths = {
      slug: 'test-run',
      runRootRel: '.takt/runs/test-run',
      reportsRel: '.takt/runs/test-run/reports',
      contextRel: '.takt/runs/test-run/context',
      contextKnowledgeRel: '.takt/runs/test-run/context/knowledge',
      contextPolicyRel: '.takt/runs/test-run/context/policy',
      contextPreviousResponsesRel: '.takt/runs/test-run/context/previous_responses',
      logsRel: '.takt/runs/test-run/logs',
      metaRel: '.takt/runs/test-run/meta.json',
      runRootAbs: join(cwd, '.takt/runs/test-run'),
      reportsAbs: join(cwd, '.takt/runs/test-run/reports'),
      contextAbs: join(cwd, '.takt/runs/test-run/context'),
      contextKnowledgeAbs: join(cwd, '.takt/runs/test-run/context/knowledge'),
      contextPolicyAbs: join(cwd, '.takt/runs/test-run/context/policy'),
      contextPreviousResponsesAbs: join(cwd, '.takt/runs/test-run/context/previous_responses'),
      logsAbs: join(cwd, '.takt/runs/test-run/logs'),
      metaAbs: join(cwd, '.takt/runs/test-run/meta.json'),
    };
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function createPlainTextPublicationHarness(
    normalizerResponses: readonly AgentResponse[],
    reportContentOverride?: string,
    /**
     * そのレビュアーが解決された profile の `escalate` 先。正規化係の provider/model は
     * ここから決まる。既定はテスト全体が期待する 'normalizer-model'、`null` は
     * 「escalate 無し」= 通常の既定解決。
     */
    reviewerEscalationOverride?: {
      readonly profile: string;
      readonly provider: string;
      readonly model: string;
      readonly providerOptions?: Record<string, unknown>;
    } | null,
    structuredOutputNormalizersOverride?: StructuredOutputNormalizerRegistry,
    reviewerOverrides?: {
      readonly agentResponses?: readonly AgentResponse[];
    },
    /** finding_contract.review_budget。差し戻し slot の提示予算の出所。 */
    reviewBudgetOverride?: { readonly maxReviewRounds: number },
  ) {
    const reportContent = reportContentOverride ?? [
      '# Architecture Review',
      '',
      '## Result: REJECT',
      '',
      'Issue: src/example.ts still bypasses the required boundary.',
    ].join('\n');
    const remainingAgentResponses = [...(reviewerOverrides?.agentResponses ?? [])];
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'reviewer system',
        userInstruction: prompt,
      });
      const queued = remainingAgentResponses.shift();
      if (queued !== undefined) {
        return queued;
      }
      return {
        persona: 'reviewer',
        status: 'done',
        content: reportContent,
        sessionId: 'reviewer-report-session',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      };
    });
    const remainingNormalizerResponses = [...normalizerResponses];
    const normalizeFindingIntake = vi.fn(async (
      _report: string,
      _options: unknown,
    ) => {
      const response = remainingNormalizerResponses.shift();
      if (response === undefined) {
        throw new Error('Unexpected normalizer call');
      }
      return response;
    });
    const updatePersonaSession = vi.fn();
    const recordSynthesizedAgentUsage = vi.fn();
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [
        { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
      ],
    });
    const state = makeState();
    let storedLedger: { findings: unknown[] } = { findings: [] };
    const findingContractContext = {
      ledgerSummary: '{"findings":[]}',
      reportLedgerSummary: '{"ids":[]}',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        reviewScopeSnapshotId: 'snapshot-plain-text',
      },
    };
    const resolveStepProviderModel = vi.fn().mockImplementation((resolvedStep, runtime) => (
      runtime?.providerInfo ?? {
        provider: resolvedStep.provider ?? 'mock',
        // 正規化係の合成ステップは、明示上書きの無い候補（既定解決）でも
        // 既定では同じ normalizer-model へ落ちる。解決チェーンの後段が先頭と
        // 同じ (provider, model) なら「やり直し先」にはならない。
        model: resolvedStep.model
          ?? (resolvedStep.name?.endsWith(':intake-normalize') === true
            ? 'normalizer-model'
            : 'reviewer-model'),
        providerOptions: resolvedStep.providerOptions,
        ...(reviewerEscalationOverride === null
          ? {}
          : {
              escalation: reviewerEscalationOverride
                ?? { profile: 'strong', provider: 'mock', model: 'normalizer-model' },
            }),
      }
    ));
    const executor = new StepExecutor({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn((
          _step,
          workflowState: WorkflowState,
          lastResponse: string,
          _updatePersonaSession,
          onPhaseStart,
          onPhaseComplete,
          _onJudgeStage,
          _iteration,
          runtime,
          onProviderAttempt,
        ) => ({
          cwd,
          reportDir: runPaths.reportsAbs,
          language: 'en' as const,
          lastResponse,
          workflowName: 'test-workflow',
          iteration: workflowState.iteration,
          getSessionId: () => 'reviewer-phase1-session',
          resolveSessionKey: () => 'reviewer:mock',
          buildResumeOptions: () => ({ resolvedProvider: 'mock' as const }),
          buildNewSessionReportOptions: () => ({ resolvedProvider: 'mock' as const }),
          buildFallbackReportOptions: () => undefined,
          resolveReportFallbackProviderModel: () => undefined,
          updatePersonaSession,
          resolveStepProviderModel: () => runtime?.providerInfo ?? {
            provider: 'mock' as const,
            model: 'reviewer-model',
          },
          onPhaseStart,
          onPhaseComplete,
          onProviderAttempt,
        })),
        resolveStepProviderModel,
        buildFindingContractInstructionContext: vi.fn().mockReturnValue(
          findingContractContext,
        ),
        buildFindingRestatementSlotContexts: vi.fn().mockReturnValue(new Map()),
      },
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => runPaths.reportsRel,
      structuredOutputNormalizers: structuredOutputNormalizersOverride
        ?? createStructuredOutputNormalizerRegistry([]),
      structuredCaller: { normalizeFindingIntake },
      getRunPaths: () => runPaths,
      getFindingCallNamespace: () => '',
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [step],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'test task',
      getRunId: () => 'test-run',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'Reconcile.',
          outputContract: 'Return JSON.',
        },
        ...(reviewBudgetOverride === undefined ? {} : { reviewBudget: reviewBudgetOverride }),
      },
      findingLedgerStore: {
        ledgerIdentity: 'scope-plain-text',
        workflowName: 'test-workflow',
        loadLedger: () => storedLedger,
        // 報告拒否の経路は protocol anomaly を台帳へ書く。読み取りだけの stub だと
        // その分岐に入った時点で落ちる。
        updateLedger: async (
          mutate: (ledger: unknown) => { ledger: unknown; result: unknown },
        ) => {
          const { ledger, result } = mutate(storedLedger);
          storedLedger = ledger as typeof storedLedger;
          return result;
        },
      },
      findingManagerAuthority: 'standard',
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      abortSignal: undefined,
    } as unknown as StepExecutorDeps);

    return {
      executor,
      normalizeFindingIntake,
      recordSynthesizedAgentUsage,
      reportContent,
      state,
      step,
      updatePersonaSession,
      findingContractContext,
      resolveStepProviderModel,
    };
  }

  it('plain-text reviewer reportを保存してから隔離normalizerの結果をpublicationする', async () => {
    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'src/example.ts still bypasses the required boundary.',
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const normalizerUsage = {
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      usageMissing: false,
    };
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      sessionId: 'isolated-normalizer-session',
      structuredOutput: { rawFindings: [rawFinding] },
      providerUsage: normalizerUsage,
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    }]);

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        sessionId: 'reviewer-phase1-session',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    if (!('publication' in result)) {
      throw new Error('Expected publication');
    }
    expect(result.publication.protocol).toMatchObject({
      format: 'normalized-plain-text',
      generationMode: 'freeform',
    });
    expect(result.publication.rawFindings).toEqual([rawFinding]);
    expect(result.response).toMatchObject({
      content: harness.reportContent,
      sessionId: 'reviewer-report-session',
      structuredOutput: { rawFindings: [rawFinding] },
    });
    expect(result.response.sessionId).not.toBe('isolated-normalizer-session');
    expect(readFileSync(join(runPaths.reportsAbs, 'review.md'), 'utf8'))
      .toBe(harness.reportContent);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(harness.normalizeFindingIntake).toHaveBeenCalledWith(
      harness.reportContent,
      expect.objectContaining({
        provider: 'mock',
        model: 'normalizer-model',
        mode: 'initial',
        language: 'en',
      }),
    );
    expect(harness.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'review:intake-normalize',
      expect.objectContaining({
        provider: 'mock',
        model: 'normalizer-model',
        providerOptions: undefined,
      }),
      true,
      normalizerUsage,
    );
    const normalizerResolutionCalls = harness.resolveStepProviderModel.mock.calls.filter(
      ([resolvedStep]) => resolvedStep.name === 'review:intake-normalize',
    );
    // 解決チェーンの先頭（= 実際に走る候補）はレビュアーの `escalate` 先が
    // 合成ステップへ直接載る（レビュアー自身の provider/model には落ちない）。
    expect(normalizerResolutionCalls[0]?.[0]).toMatchObject({
      provider: 'mock',
      providerSpecified: true,
      model: 'normalizer-model',
      modelSpecified: true,
    });
  });

  it('Phase 2 は明示指定された finding contract context を使い restatement-only 契約を保つ', async () => {
    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'src/example.ts still bypasses the required boundary.',
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [rawFinding] },
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
    }]);
    const requestWithoutId = {
      anomalyId: 'RA-PHASE2-OVERRIDE',
      reviewer: 'escalation-reviewer',
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '7'.repeat(64),
      sourceExcerptDigest: '8'.repeat(64),
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: [] as const,
      missingRequirements: [] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const presentationContext = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    // Phase 2 の既定経路（reviewer step 名から context を組み直す）は、この
    // harness の phase context に buildFindingContractInstructionContext が無いため
    // Finding Contract ブロックを一切出さない。明示 override が届いて初めて
    // restatement-only 契約が Phase 2 の指示に残る。
    const explicitContext = {
      ledgerSummary: '{"findings":[]}',
      reportLedgerSummary: '{"ids":[]}',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
        presentationContext,
        // mode は呼び出し側が明示する契約。落とすと Phase 2 だけ通常レビュー契約へ化ける。
        mode: 'restatement-only' as const,
      },
    };

    await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        sessionId: 'reviewer-phase1-session',
        timestamp: new Date('2026-08-07T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
      findingContractContext: explicitContext,
    });

    const reportInstruction = vi.mocked(executeAgent).mock.calls[0]?.[1] ?? '';
    expect(reportInstruction).toContain('restatement-only review');
    expect(reportInstruction).toContain('RA-PHASE2-OVERRIDE');
  });

  it('plain-text normalizerはmodel output不正時だけ新規抽出を1回訂正する', async () => {
    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'src/example.ts still bypasses the required boundary.',
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"invalid"}',
        structuredOutput: { rawFindings: 'invalid' },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [rawFinding] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => (
      (options as { mode: string }).mode
    ))).toEqual(['initial', 'correction']);
  });

  it('extraction-fidelity correctionが同じ欠落を返した場合はpublicationしない', async () => {
    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: null,
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [rawFinding] },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [rawFinding] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    await expect(harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    })).rejects.toThrow(/remained invalid after one correction \(initial: .+; corrected: .+\)/u);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => {
      const typed = options as { mode: string; extractionFidelityCorrection?: boolean };
      return {
        mode: typed.mode,
        extractionFidelityCorrection: typed.extractionFidelityCorrection,
      };
    })).toEqual([
      { mode: 'initial', extractionFidelityCorrection: false },
      { mode: 'correction', extractionFidelityCorrection: true },
    ]);
  });

  it('model output訂正後もextraction-fidelity違反を再検査してpublicationしない', async () => {
    const correctedRawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: null,
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"invalid"}',
        structuredOutput: { rawFindings: 'invalid' },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [correctedRawFinding] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    await expect(harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    })).rejects.toThrow(/remained invalid after one correction \(initial: .+; corrected: .+\)/u);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
  });

  const PLAIN_TEXT_REPORT_CONTENT = [
    '# Architecture Review',
    '',
    '## Result: REJECT',
    '',
    'Issue: src/example.ts still bypasses the required boundary.',
  ].join('\n');
  const CLAIM_EXCERPT = 'Issue: src/example.ts still bypasses the required boundary.';
  const COMPLETE_CANDIDATE = {
    rawFindingId: null,
    familyTag: null,
    severity: null,
    title: null,
    description: 'src/example.ts still bypasses the required boundary.',
    suggestion: null,
    relation: null,
    targetFindingIds: [],
    target: null,
    evidenceRequests: [],
  };
  it('should fire the extraction-fidelity correction when the normalizer returns a null candidate', async () => {
    // Given: rawExcerpt はあるのに candidate ごと null（実走 run-4 の退行形）
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: null }] },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: {
          rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE }],
        },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    // When
    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    // Then
    expect('publication' in result).toBe(true);
    if (!('publication' in result)) {
      throw new Error('Expected publication');
    }
    expect(result.publication.rawFindings).toEqual([
      { rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE },
    ]);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => {
      const typed = options as { mode: string; extractionFidelityCorrection?: boolean };
      return { mode: typed.mode, extractionFidelityCorrection: typed.extractionFidelityCorrection };
    })).toEqual([
      { mode: 'initial', extractionFidelityCorrection: false },
      { mode: 'correction', extractionFidelityCorrection: true },
    ]);
  });

  it('should fire the extraction-fidelity correction when the normalizer returns an incomplete candidate', async () => {
    // Given: candidate object はあるが必須項目を欠く（reviewer projection が null へ畳む形）
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: {
          rawFindings: [{
            rawExcerpt: CLAIM_EXCERPT,
            candidate: { description: 'src/example.ts still bypasses the required boundary.' },
          }],
        },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: {
          rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE }],
        },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    // When
    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    // Then
    expect('publication' in result).toBe(true);
    if (!('publication' in result)) {
      throw new Error('Expected publication');
    }
    expect(result.publication.rawFindings).toEqual([
      { rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE },
    ]);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => {
      const typed = options as { mode: string; extractionFidelityCorrection?: boolean };
      return { mode: typed.mode, extractionFidelityCorrection: typed.extractionFidelityCorrection };
    })).toEqual([
      { mode: 'initial', extractionFidelityCorrection: false },
      { mode: 'correction', extractionFidelityCorrection: true },
    ]);
  });

  it('should not publish when the normalizer keeps returning a null candidate after the correction', async () => {
    // Given
    const nullCandidateFinding = { rawExcerpt: CLAIM_EXCERPT, candidate: null };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [nullCandidateFinding] },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{}',
        structuredOutput: { rawFindings: [nullCandidateFinding] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    // When / Then
    await expect(harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    })).rejects.toThrow(/remained invalid after one correction \(initial: .+; corrected: .+\)/u);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
  });

  it('先頭候補が訂正1回でも通らなければ解決チェーンの次の候補で1度だけやり直す', async () => {
    // Given: escalate 先（先頭候補）は退行し続け、既定解決（次の候補）が成立する
    const nullCandidateFinding = { rawExcerpt: CLAIM_EXCERPT, candidate: null };
    const harness = createPlainTextPublicationHarness(
      [
        {
          persona: 'default',
          status: 'done',
          content: '{}',
          structuredOutput: { rawFindings: [nullCandidateFinding] },
          timestamp: new Date('2026-07-31T00:00:01.000Z'),
        },
        {
          persona: 'default',
          status: 'done',
          content: '{}',
          structuredOutput: { rawFindings: [nullCandidateFinding] },
          timestamp: new Date('2026-07-31T00:00:02.000Z'),
        },
        {
          persona: 'default',
          status: 'done',
          content: '{}',
          structuredOutput: {
            rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE }],
          },
          timestamp: new Date('2026-07-31T00:00:03.000Z'),
        },
      ],
      PLAIN_TEXT_REPORT_CONTENT,
      { profile: 'strong', provider: 'mock', model: 'escalated-normalizer-model' },
    );

    // When
    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    // Then: 先頭候補で initial + correction、次の候補で initial の計3回。
    expect('publication' in result).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(3);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => {
      const typed = options as { model?: string; mode: string };
      return { model: typed.model, mode: typed.mode };
    })).toEqual([
      { model: 'escalated-normalizer-model', mode: 'initial' },
      { model: 'escalated-normalizer-model', mode: 'correction' },
      { model: 'normalizer-model', mode: 'initial' },
    ]);
  });

  it('報告本文へ束縛できない失敗は fail-loud せず report rejection として返す', async () => {
    // Given: レビュアーが「markdown で書け」を無視して報告本文ごと JSON を返し、
    // 正規化係はそこから文を取り出したので rawExcerpt が報告本文に存在しない。
    const unboundFinding = {
      rawExcerpt: 'This sentence never appears in the report body.',
      candidate: COMPLETE_CANDIDATE,
    };
    const unboundResponse = {
      persona: 'default',
      status: 'done' as const,
      content: '{}',
      structuredOutput: { rawFindings: [unboundFinding] },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    };
    const harness = createPlainTextPublicationHarness(
      [unboundResponse, unboundResponse],
      '{"rawFindings":[{"rawExcerpt":"escaped\\u0020claim text"}]}',
    );

    // When
    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    // Then: 報告側原因なので次候補へは行かず（initial + correction の2回だけ）、
    // publication ではなく rejection を返す。
    expect('reportRejection' in result).toBe(true);
    if (!('reportRejection' in result)) {
      throw new Error('Expected a report rejection');
    }
    expect(result.reportRejection.reason)
      .toMatch(/report text could not be bound after one correction/u);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
  });

  /**
   * 実走行の回帰: 報告拒否のレビュアーは publication を持たないまま
   * applyPostExecutionRulesOnly（= Phase 3）へ進む。レポートファイルを
   * publication 成立時にしか書いていなかったため、use_judge の Phase 3 が
   * 「Status judgment requires existing use_judge reports」で run ごと落ちた。
   * 取り込みの成否とレポートの実在は別物なので、拒否された本文もファイルに残す。
   */
  it('報告拒否でもレポートは実在し、use_judge の Phase 3 がその本文を読む', async () => {
    const unboundFinding = {
      rawExcerpt: 'This sentence never appears in the report body.',
      candidate: COMPLETE_CANDIDATE,
    };
    const unboundResponse = {
      persona: 'default',
      status: 'done' as const,
      content: '{}',
      structuredOutput: { rawFindings: [unboundFinding] },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    };
    const harness = createPlainTextPublicationHarness(
      [unboundResponse, unboundResponse],
      PLAIN_TEXT_REPORT_CONTENT,
    );

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });
    expect('reportRejection' in result).toBe(true);

    // レポートを読む Phase 3 は throw せず、拒否された本文で判定できる。
    const judgedStep = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [
        { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
      ],
      rules: [
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      ],
    });
    const judgeStatus = vi.fn(async (
      structuredInstruction: string,
      _tagInstruction: string,
      _candidates: unknown[],
      options: {
        onStructuredPromptResolved?: (parts: {
          systemPrompt: string;
          userInstruction: string;
        }) => void;
      },
    ) => {
      options.onStructuredPromptResolved?.({
        systemPrompt: 'judge system',
        userInstruction: structuredInstruction,
      });
      return { candidateIndex: 0, method: 'structured_output' as const };
    });
    const judgment = await runStatusJudgmentPhase(judgedStep, {
      cwd,
      reportDir: runPaths.reportsAbs,
      iteration: 1,
      resolveStepProviderModel: () => ({ provider: 'mock', model: 'judge-model' }),
      structuredCaller: { judgeStatus },
    } as unknown as Parameters<typeof runStatusJudgmentPhase>[1]);

    expect(judgment.label).toBe('needs_fix');
    expect(judgeStatus.mock.calls[0]![0]).toContain(harness.reportContent);

    // publication の成否と無関係に、レポートは拒否された本文のまま実在する。
    expect(readFileSync(join(runPaths.reportsAbs, 'review.md'), 'utf-8'))
      .toBe(harness.reportContent);
  });

  it('正規化係の出力形の失敗は report rejection にせず次候補へ後退する', async () => {
    // Given: binding ではなく candidate 喪失（正規化係側の問題）。
    const lostClaimResponse = {
      persona: 'default',
      status: 'done' as const,
      content: '{}',
      structuredOutput: { rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: null }] },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    };
    const harness = createPlainTextPublicationHarness(
      [
        lostClaimResponse,
        lostClaimResponse,
        {
          persona: 'default',
          status: 'done',
          content: '{}',
          structuredOutput: {
            rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE }],
          },
          timestamp: new Date('2026-07-31T00:00:03.000Z'),
        },
      ],
      PLAIN_TEXT_REPORT_CONTENT,
      { profile: 'strong', provider: 'mock', model: 'escalated-normalizer-model' },
    );

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    // Then: 次候補で成立する。report rejection にはならない。
    expect('publication' in result).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(3);
  });

  it('やり直し候補まで失敗したら候補ごとの具体的な理由を添えて fail-loud する', async () => {
    const nullCandidateResponse = {
      persona: 'default',
      status: 'done' as const,
      content: '{}',
      structuredOutput: { rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: null }] },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    };
    const harness = createPlainTextPublicationHarness(
      [
        nullCandidateResponse,
        nullCandidateResponse,
        nullCandidateResponse,
        nullCandidateResponse,
      ],
      PLAIN_TEXT_REPORT_CONTENT,
      { profile: 'strong', provider: 'mock', model: 'escalated-normalizer-model' },
    );

    const error = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    }).catch((caught: unknown) => caught as Error);

    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(4);
    // 候補ごとに「どの item がどの検証に落ちたか」まで含む（理由なしで投げない）。
    expect(error.message).toContain('mock/escalated-normalizer-model:');
    expect(error.message).toContain('mock/normalizer-model:');
    expect(error.message).toContain('#0: candidate is null after projection');
  });

  it('plain-text normalizerの65件出力はcorrectionを消費せず64件とoverflow記録へ着地する', async () => {
    const rawFindings = Array.from({ length: 65 }, (_, index) => {
      const sequence = String(index + 1).padStart(3, '0');
      const rawExcerpt = `Finding ${sequence} observation.`;
      return {
        rawExcerpt,
        candidate: {
          rawFindingId: `raw-${sequence}`,
          familyTag: 'bug',
          severity: 'medium',
          title: `Finding ${sequence}`,
          description: rawExcerpt,
          suggestion: null,
          relation: 'new',
          targetFindingIds: [],
          target: { kind: 'code', paths: ['src/example.ts'] },
          evidenceRequests: [],
        },
      };
    });
    const reportContent = rawFindings.map((finding) => finding.rawExcerpt).join('\n');
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    }], reportContent);

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    if (!('publication' in result)) {
      throw new Error('Expected publication');
    }
    expect(result.publication.rawFindings).toHaveLength(64);
    expect(result.publication.reviewerOutputOverflow).toEqual({
      kind: 'reviewer-output-overflow',
      emittedAtomizedRawFindingCount: 65,
      admittedAtomizedRawFindingCount: 64,
      overflowAtomizedRawFindingCount: 1,
      reason: 'reviewer emitted 65 atomized raw findings; admitted 64 and recorded 1 as reviewer-output-overflow',
    });
    expect(result.response.structuredOutput?.rawFindings).toHaveLength(64);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(harness.normalizeFindingIntake.mock.calls[0]?.[1]).toMatchObject({
      mode: 'initial',
    });
  });

  it('plain-text normalizerの訂正失敗はreport recoveryと混同せずreportを保持する', async () => {
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"invalid"}',
        structuredOutput: { rawFindings: 'invalid' },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"still-invalid"}',
        structuredOutput: { rawFindings: 'still-invalid' },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    await expect(harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    })).rejects.toThrow(/Finding intake normalizer.*remained invalid after one correction/u);

    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(executeAgent).toHaveBeenCalledOnce();
    // レポートは正規化の成否と無関係に実在する（publication は成立していない）。
    expect(readFileSync(join(runPaths.reportsAbs, 'review.md'), 'utf8'))
      .toBe(harness.reportContent);
    expect(loadPendingFindingReviewNormalization(
      runPaths.reportsAbs,
      {
        scopeIdentity: 'scope-plain-text',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'review',
        reportName: 'review.md',
      },
      'test-workflow',
    )?.reportContent).toBe(harness.reportContent);
  });

  it('resume helperは保存済みplain reportからnormalizerだけを再実行する', async () => {
    const invalidHarness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"invalid"}',
        structuredOutput: { rawFindings: 'invalid' },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":"still-invalid"}',
        structuredOutput: { rawFindings: 'still-invalid' },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);
    await expect(invalidHarness.executor.prepareFindingReviewPublication({
      step: invalidHarness.step,
      executableStep: invalidHarness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: invalidHarness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: invalidHarness.updatePersonaSession,
    })).rejects.toThrow(/remained invalid after one correction/u);
    expect(executeAgent).toHaveBeenCalledOnce();

    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'src/example.ts still bypasses the required boundary.',
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const resumedHarness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [rawFinding] },
      timestamp: new Date('2026-07-31T00:01:00.000Z'),
    }]);
    const resumed = await resumedHarness.executor.resumeFindingReviewPublication({
      step: resumedHarness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: resumedHarness.state,
    });

    expect(resumed?.publication.rawFindings).toEqual([rawFinding]);
    expect(executeAgent).toHaveBeenCalledOnce();
    expect(resumedHarness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(resumedHarness.normalizeFindingIntake.mock.calls[0]?.[0])
      .toBe(invalidHarness.reportContent);

    const completedHarness = createPlainTextPublicationHarness([]);
    const completed = await completedHarness.executor.resumeFindingReviewPublication({
      step: completedHarness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: completedHarness.state,
    });
    expect(completed?.publication.publicationId).toBe(resumed?.publication.publicationId);
    expect(completedHarness.normalizeFindingIntake).not.toHaveBeenCalled();
  });

  it('保存済みnormalized pendingは現時点のreviewer選択と照合せず再開する', async () => {
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [] },
      timestamp: new Date('2026-07-31T00:01:00.000Z'),
    }]);
    persistPendingFindingReviewNormalization(
      runPaths.reportsAbs,
      createPendingFindingReviewNormalization({
        identity: {
          scopeIdentity: 'scope-plain-text',
          callNamespace: '',
          parentStepName: 'reviewers',
          stepIteration: 1,
          reviewerStepName: 'review',
          reportName: 'review.md',
        },
        workflowName: 'test-workflow',
        reportContent: harness.reportContent,
        reviewerExecutionIdentity: {
          provider: 'mock',
          model: 'reviewer-model',
        },
      }),
    );

    const resumed = await harness.executor.resumeFindingReviewPublication({
      step: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
    });

    expect(resumed).toMatchObject({
      reviewerProviderInfo: {
        provider: 'mock',
        model: 'reviewer-model',
      },
      publication: {
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      },
    });
    expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'rate_limited'] as const)(
    'pending plain reportのnormalizerが%sならresumeを終端応答として返す',
    async (status) => {
      const harness = createPlainTextPublicationHarness([{
        persona: 'default',
        status,
        content: `normalizer ${status}`,
        timestamp: new Date('2026-07-31T00:01:00.000Z'),
      }]);
      persistPendingFindingReviewNormalization(
        runPaths.reportsAbs,
        createPendingFindingReviewNormalization({
          identity: {
            scopeIdentity: 'scope-plain-text',
            callNamespace: '',
            parentStepName: 'reviewers',
            stepIteration: 1,
            reviewerStepName: 'review',
            reportName: 'review.md',
          },
          workflowName: 'test-workflow',
          reportContent: harness.reportContent,
          reviewerExecutionIdentity: {
            provider: 'mock',
            model: 'reviewer-model',
          },
        }),
      );

      const resumed = await harness.executor.resumeFindingReviewPublication({
        step: harness.step,
        parentStepName: 'reviewers',
        stepIteration: 1,
        state: harness.state,
      });

      expect(resumed).toMatchObject({
        // 終端メタデータは正規化係の応答から、本文はレビュアーのレポートから。
        // 正規化係の終端メッセージが本文を置き換えると、後続 step の
        // {previous_response} と snapshot にレビュー結果でない文字列が流れる。
        terminalResponse: expect.objectContaining({
          status,
          content: harness.reportContent,
          timestamp: new Date('2026-07-31T00:01:00.000Z'),
        }),
        reviewerProviderInfo: {
          provider: 'mock',
          model: 'reviewer-model',
        },
        terminalOperation: {
          origin: {
            stage: 'finding_intake_normalizer',
            reviewerStepName: 'review',
          },
          providerInfo: {
            provider: 'mock',
            model: 'normalizer-model',
          },
        },
      });
      expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
      expect(executeAgent).not.toHaveBeenCalled();
    },
  );

  it('reviewer fallback成功後のnormalizer fallbackは保存済みreviewer identityでpendingを再開する', async () => {
    const harness = createPlainTextPublicationHarness(
      [
        {
          persona: 'finding-intake-normalizer',
          status: 'rate_limited',
          content: '',
          error: 'normalizer rate limited',
          timestamp: new Date('2026-07-31T00:01:00.000Z'),
        },
        {
          persona: 'finding-intake-normalizer',
          status: 'done',
          content: '{"rawFindings":[]}',
          structuredOutput: { rawFindings: [] },
          timestamp: new Date('2026-07-31T00:02:00.000Z'),
        },
      ],
      undefined,
      {
        profile: 'strong',
        provider: 'mock',
        model: 'normalizer-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
          opencode: {
            variant: 'normalizer-fallback',
          },
        },
      },
    );
    const preparedExecution = {
      executableStep: harness.step,
      findingContractContext: harness.findingContractContext,
      phase1Instruction: 'Review.',
      stepIteration: 1,
    };
    const applyPostExecutionRulesOnly = vi.spyOn(
      harness.executor,
      'applyPostExecutionRulesOnly',
    );

    const reviewerFallbackRuntime = {
      providerInfo: {
        provider: 'mock' as const,
        model: 'fallback-reviewer-model',
        providerOptions: {
          opencode: {
            variant: 'reviewer-fallback',
          },
        },
      },
      fallback: {
        reason: 'rate_limited' as const,
        reasonDetail: 'reviewer rate limited',
        originalIteration: 2,
        previousProvider: 'mock' as const,
        previousModel: 'reviewer-model',
        currentProvider: 'mock' as const,
        currentModel: 'fallback-reviewer-model',
        stepName: 'review',
        reportDir: runPaths.reportsRel,
        origin: {
          stage: 'reviewer' as const,
          reviewerStepName: 'review',
        },
      },
    };
    const rateLimited = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      reviewerFallbackRuntime,
      preparedExecution,
    );
    expect(rateLimited.response.status).toBe('rate_limited');
    expect(rateLimited.providerInfo).toMatchObject({
      provider: 'mock',
      model: 'fallback-reviewer-model',
    });
    expect(rateLimited.terminalOperation).toMatchObject({
      origin: {
        stage: 'finding_intake_normalizer',
        reviewerStepName: 'review',
      },
      providerInfo: {
        provider: 'mock',
        model: 'normalizer-model',
      },
    });
    expect(loadPendingFindingReviewNormalization(
      runPaths.reportsAbs,
      {
        scopeIdentity: 'scope-plain-text',
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: 'review',
        reportName: 'review.md',
      },
      'test-workflow',
    )?.reviewerExecutionIdentity).toEqual({
      provider: 'mock',
      model: 'fallback-reviewer-model',
      providerOptions: {
        opencode: {
          variant: 'reviewer-fallback',
        },
      },
    });
    const reviewerCalls = vi.mocked(executeAgent).mock.calls.length;

    const fallbackRuntime = {
      providerInfo: {
        provider: 'mock' as const,
        model: 'fallback-normalizer-model',
      },
      fallback: {
        reason: 'rate_limited' as const,
        reasonDetail: 'normalizer rate limited',
        originalIteration: 3,
        previousProvider: 'mock' as const,
        previousModel: 'normalizer-model',
        currentProvider: 'mock' as const,
        currentModel: 'fallback-normalizer-model',
        stepName: 'review',
        reportDir: runPaths.reportsRel,
        origin: {
          stage: 'finding_intake_normalizer' as const,
          reviewerStepName: 'review',
        },
      },
    };
    const resumed = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      fallbackRuntime,
      preparedExecution,
    );

    expect(resumed.response.status).toBe('done');
    expect(resumed.providerInfo).toMatchObject({
      provider: 'mock',
      model: 'fallback-reviewer-model',
    });
    expect(executeAgent).toHaveBeenCalledTimes(reviewerCalls);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => ({
      provider: (options as { provider: string }).provider,
      model: (options as { model?: string }).model,
      providerOptions: (options as { providerOptions?: unknown }).providerOptions,
    }))).toEqual([
      {
        provider: 'mock',
        model: 'normalizer-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
          opencode: {
            variant: 'normalizer-fallback',
          },
        },
      },
      {
        provider: 'mock',
        model: 'fallback-normalizer-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
          opencode: {
            variant: 'normalizer-fallback',
          },
        },
      },
    ]);
    expect(applyPostExecutionRulesOnly).toHaveBeenCalledOnce();
    expect(applyPostExecutionRulesOnly.mock.calls[0]?.[4]).toMatchObject({
      providerInfo: {
        provider: 'mock',
        model: 'fallback-reviewer-model',
        providerOptions: {
          opencode: {
            variant: 'reviewer-fallback',
          },
        },
      },
    });
  });

  it('runNormalStepの正式resumeはpending本文をnormalizerだけで再開する', async () => {
    const rawFinding = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: {
        rawFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'src/example.ts still bypasses the required boundary.',
        suggestion: null,
        relation: null,
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    };
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [rawFinding] },
      timestamp: new Date('2026-07-31T00:01:00.000Z'),
    }]);
    const sourcePaths = buildRunPaths(cwd, 'source-run');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    persistPendingFindingReviewNormalization(
      sourcePaths.reportsAbs,
      createPendingFindingReviewNormalization({
        identity: {
          scopeIdentity: 'source-sqlite-scope',
          callNamespace: '',
          parentStepName: 'review',
          stepIteration: 1,
          reviewerStepName: 'review',
          reportName: 'review.md',
        },
        workflowName: 'test-workflow',
        reportContent: harness.reportContent,
        reviewerExecutionIdentity: {
          provider: 'mock',
          model: 'reviewer-model',
        },
      }),
    );
    inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: runPaths.slug,
    });

    const result = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep: harness.step,
        findingContractContext: harness.findingContractContext,
          phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    expect(result.response).toMatchObject({
      status: 'done',
      content: harness.reportContent,
      structuredOutput: { rawFindings: [rawFinding] },
    });
    expect(executeAgent).not.toHaveBeenCalled();
    expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(harness.normalizeFindingIntake.mock.calls[0]?.[0])
      .toBe(harness.reportContent);
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
  });

  it('cross-run completed publicationは保存済みreviewer identityをそのまま再利用する', async () => {
    const reportContent = '## Result: APPROVE\n\nNo findings.';
    const sourcePaths = buildRunPaths(cwd, 'source-run');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    const sourcePublication = createFindingReviewPublication({
      identity: {
        scopeIdentity: 'source-sqlite-scope',
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: 'review',
        reportName: 'review.md',
      },
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [],
    });
    persistFindingReviewPublication(sourcePaths.reportsAbs, {
      publication: sourcePublication,
      reviewerExecutionIdentity: {
        provider: 'codex',
        model: 'persisted-reviewer-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
        },
      },
    });
    publishFindingReviewPublication(sourcePaths.reportsAbs, sourcePublication);
    inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: runPaths.slug,
    });
    const harness = createPlainTextPublicationHarness([]);
    const applyPostExecutionRulesOnly = vi.spyOn(
      harness.executor,
      'applyPostExecutionRulesOnly',
    );
    const resumed = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep: harness.step,
        findingContractContext: harness.findingContractContext,
          phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    expect(resumed).toMatchObject({
      response: {
        status: 'done',
        content: reportContent,
      },
      providerInfo: {
        provider: 'codex',
        model: 'persisted-reviewer-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
        },
      },
    });
    expect(applyPostExecutionRulesOnly).toHaveBeenCalledOnce();
    expect(applyPostExecutionRulesOnly.mock.calls[0]?.[4]?.providerInfo).toEqual({
      provider: 'codex',
      model: 'persisted-reviewer-model',
      providerSource: 'step',
      modelSource: 'step',
      providerOptions: {
        codex: {
          reasoningEffort: 'high',
        },
      },
    });
    expect(executeAgent).not.toHaveBeenCalled();
    expect(harness.normalizeFindingIntake).not.toHaveBeenCalled();
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
  });

  it('companion付きFinding Contract reviewerのpublication resumeは未検証stateでconditionへ進まない', async () => {
    const harness = createPlainTextPublicationHarness([]);
    harness.step.companion = {
      fixed: ['ai-antipattern-review-companion'],
      pool: [],
    };
    const reportContent = '## Result: APPROVE\n\nNo findings.';
    const publication = createFindingReviewPublication({
      identity: {
        scopeIdentity: 'snapshot-plain-text',
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: 'review',
        reportName: 'review.md',
      },
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [],
    });
    vi.spyOn(harness.executor, 'resumeFindingReviewPublication').mockResolvedValue({
      publication,
      response: {
        persona: 'review',
        status: 'done',
        content: reportContent,
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
    });

    const resumed = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep: harness.step,
        findingContractContext: harness.findingContractContext,
        phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    expect(resumed.response.status).toBe('blocked');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  /** 単独ステップ経路で slot 呼び出しに渡された input を1件だけ取り出す。 */
  function singleSlotInput(): FindingRestatementSlotInput {
    const calls = vi.mocked(runFindingRestatementSlot).mock.calls;
    expect(calls).toHaveLength(1);
    return calls[0]![0];
  }

  it('単独ステップ経路は実行用ステップと設定の提示予算で差し戻し slot を回す', async () => {
    const harness = createPlainTextPublicationHarness(
      [{
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-07-31T00:01:00.000Z'),
      }],
      undefined,
      undefined,
      undefined,
      undefined,
      { maxReviewRounds: 3 },
    );
    // dynamic facets 適用後の実行用ステップ。設定上の step を owner に渡すと、
    // その回の owner が実際に使った facet 集合と代打の判断基準がずれる。
    const executableStep = {
      ...harness.step,
      knowledgeContents: [{ name: 'dynamic', content: 'Dynamic knowledge.' }],
    };

    await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep,
        findingContractContext: harness.findingContractContext,
        phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    const slotInput = singleSlotInput();
    expect(slotInput.ownerReviewerSteps).toEqual([executableStep]);
    // 提示予算は finding_contract.review_budget から来る。既定値へ落ちると
    // 壊れたレビュアーが1ステップで6パス回る。
    expect(slotInput.presentationLimit).toBe(3);
    expect(slotInput.parentStepName).toBe(harness.step.name);
    expect(slotInput.stepIteration).toBe(1);

    // slot のパスはレビューラウンドとして数えない。数えると review_budget を
    // 1ステップで使い切り、再レビューの機会がゼロになる。
    vi.mocked(ingestFindingContractResults).mockClear();
    await slotInput.ingest([{
      // 取り込みの記帳区分だけを見るので、publication は宛先レビュアーだけ持てば足りる。
      publication: {
        reviewerStepName: harness.step.name,
      } as unknown as CanonicalFindingReviewPublication,
      reviewEvidence: 'none',
    }]);
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    expect(vi.mocked(ingestFindingContractResults).mock.calls[0]![0])
      .toMatchObject({ budgetAccounting: 'excluded' });
  });

  it('単独ステップ経路は slot の terminal をそのままステップ結果へ差し替える', async () => {
    const harness = createPlainTextPublicationHarness([{
      persona: 'default',
      status: 'done',
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [] },
      timestamp: new Date('2026-07-31T00:01:00.000Z'),
    }]);
    const terminalResponse: AgentResponse = {
      persona: 'reviewer',
      status: 'rate_limited',
      content: 'Slot call hit the provider limit.',
      timestamp: new Date('2026-07-31T00:02:00.000Z'),
    };
    vi.mocked(runFindingRestatementSlot).mockResolvedValueOnce({
      kind: 'terminal',
      step: harness.step,
      response: terminalResponse,
      providerInfo: { provider: 'mock', model: 'slot-model' },
    });

    const result = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep: harness.step,
        findingContractContext: harness.findingContractContext,
        phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    expect(result.response).toBe(terminalResponse);
    expect(result.providerInfo).toEqual({ provider: 'mock', model: 'slot-model' });
    expect(harness.state.lastOutput).toBe(terminalResponse);
  });

  it('単独ステップ経路は報告拒否でも差し戻し slot を回す', async () => {
    // 報告拒否は「そのレビュアーの差し戻し対象が1件増えた」状態。取り込みが走らない
    // このぶんきで slot を飛ばすと、記録した protocol anomaly の差し戻しが次の
    // ワークフローラウンドまで届かない（resume 経路と parallel 経路は呼んでいる）。
    const unboundResponse = {
      persona: 'default',
      status: 'done' as const,
      content: '{}',
      structuredOutput: {
        rawFindings: [{
          rawExcerpt: 'This sentence never appears in the report body.',
          candidate: COMPLETE_CANDIDATE,
        }],
      },
      timestamp: new Date('2026-07-31T00:00:01.000Z'),
    };
    const harness = createPlainTextPublicationHarness(
      [unboundResponse, unboundResponse],
      PLAIN_TEXT_REPORT_CONTENT,
    );

    const result = await harness.executor.runNormalStep(
      harness.step,
      harness.state,
      'test task',
      5,
      harness.updatePersonaSession,
      undefined,
      undefined,
      {
        executableStep: harness.step,
        findingContractContext: harness.findingContractContext,
        phase1Instruction: 'Review.',
        stepIteration: 1,
      },
    );

    // publication が成立していない経路であることを、取り込みが1度も走っていない
    // ことで固定する（受理経路と取り違えると、この回帰テストは意味を失う）。
    expect(ingestFindingContractResults).not.toHaveBeenCalled();
    const slotInput = singleSlotInput();
    expect(slotInput.ownerReviewerSteps).toEqual([harness.step]);
    // ステップの結果は拒否された報告本文のまま返る。
    expect(result.response.content).toContain(PLAIN_TEXT_REPORT_CONTENT);
  });

  it.each([
    {
      label: 'zero occurrence',
      rawFindings: [{
        rawExcerpt: 'Issue not present in the report.',
        candidate: null,
      }],
    },
    {
      label: 'multiple occurrences',
      rawFindings: [{
        rawExcerpt: '#',
        candidate: null,
      }],
    },
    {
      label: 'trimmed excerpt',
      rawFindings: [{
        rawExcerpt: ' Issue: src/example.ts still bypasses the required boundary.',
        candidate: null,
      }],
    },
  ])('plain-text normalizerのpublication違反($label)は1回だけ訂正する', async ({
    rawFindings,
  }) => {
    const corrected = {
      rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
      candidate: COMPLETE_CANDIDATE,
    };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [corrected] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => (
      (options as { mode: string }).mode
    ))).toEqual(['initial', 'correction']);
  });

  it('rawExcerptがreport内に完全一致しても前後空白を含めば1回だけ訂正する', async () => {
    const reportContent = [
      '# Architecture Review',
      '',
      ' Issue: src/example.ts still bypasses the required boundary.',
    ].join('\n');
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: {
          rawFindings: [{
            rawExcerpt: ' Issue: src/example.ts still bypasses the required boundary.',
            candidate: null,
          }],
        },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: {
          rawFindings: [{
            rawExcerpt: 'Issue: src/example.ts still bypasses the required boundary.',
            candidate: COMPLETE_CANDIDATE,
          }],
        },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ], reportContent);

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(harness.normalizeFindingIntake.mock.calls.map(([, options]) => (
      (options as { mode: string }).mode
    ))).toEqual(['initial', 'correction']);
  });

  it('報告本文へ束縛できない publication 違反は fail-loud せず report rejection で終える', async () => {
    const invalid = {
      rawExcerpt: 'Issue not present in the report.',
      candidate: null,
    };
    const harness = createPlainTextPublicationHarness([
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [invalid] },
        timestamp: new Date('2026-07-31T00:00:01.000Z'),
      },
      {
        persona: 'default',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [invalid] },
        timestamp: new Date('2026-07-31T00:00:02.000Z'),
      },
    ]);

    const rejected = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: {
        persona: 'reviewer',
        status: 'done',
        content: 'phase 1 investigation',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
      agentOptions: { resolvedProvider: 'mock' },
      onProviderAttempt: vi.fn(),
      updatePersonaSession: harness.updatePersonaSession,
    });
    expect('reportRejection' in rejected).toBe(true);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledTimes(2);
  });

  it('phase:start には structured_output 用に差し替えた実 instruction を渡す', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"ok"}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const onPhaseStart = vi.fn();
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart,
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    const { instruction } = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      'Plan the next follow-up action.',
      undefined,
    );

    expect(onPhaseStart).toHaveBeenCalledWith(
      step,
      1,
      'execute',
      instruction,
      {
        systemPrompt: 'system prompt',
        userInstruction: instruction,
      },
      'implement:3:1:1',
      3,
    );
    expect(onPhaseStart).not.toHaveBeenCalledWith(
      step,
      1,
      'execute',
      'Plan the next follow-up action.',
      expect.anything(),
      undefined,
      3,
    );
  });

  it('単独 reviewer は snapshot A/B 不一致を拒否し、non-open confirmation の意味を変えず audit-only で取り込む', async () => {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/fixed.ts'), 'const fixed = true;\n');
    initializeGitFixture(cwd, ['src/fixed.ts']);
    const evidence = verifiedSourceQuoteFields(cwd, 'src/fixed.ts', 1);
    const structuredOutput = createRawFindingsStructuredOutput(evidence.snapshotId);
    const reviewerRawFindings = [{
      rawExcerpt: 'Confirmed fixed.',
      candidate: {
        rawFindingId: 'confirmation-resolved',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'The previously reported issue remains fixed.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingIds: ['F-0001'],
        target: { kind: 'code', paths: ['src/fixed.ts'] },
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/fixed.ts',
          startLine: 1,
          endLine: 1,
        }],
      },
    }];
    expect(structuredOutput.validationSchema).toBe(RawFindingsOutputValidationJsonSchema);
    const findingContractContext = {
      ledgerSummary: { findings: [] },
      reportLedgerSummary: { ids: [] },
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        reviewScopeSnapshotId: evidence.snapshotId,
      },
    };
    let agentCallCount = 0;
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      const callIndex = agentCallCount++;
      if (callIndex === 1) {
        return {
          persona: 'reviewer',
          status: 'error',
          content: 'Primary report provider unavailable.',
          error: 'Primary report provider unavailable.',
          timestamp: new Date('2026-07-22T00:00:00.500Z'),
        };
      }
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'Confirmed fixed.',
        timestamp: new Date('2026-07-22T00:00:00.000Z'),
      };
    });
    const normalizeFindingIntake = vi.fn().mockResolvedValue({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: '',
      structuredOutput: { rawFindings: reviewerRawFindings },
      timestamp: new Date('2026-07-22T00:00:02.000Z'),
    });
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review the implementation.',
      outputContracts: [{ name: 'findings.json', format: 'json', formatRef: 'review-finding-contract' }],
    });
    const buildAgentOptions = vi.fn().mockReturnValue({});
    const buildFindingContractInstructionContext = vi.fn().mockReturnValue(findingContractContext);
    const reportDir = '.takt/runs/test-run/reports';
    mkdirSync(join(cwd, reportDir), { recursive: true });
    const findingLedgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'test-run',
      reportDir: join(cwd, reportDir),
      workflowName: 'test-workflow',
    });
    await findingLedgerStore.updateLedger(() => ({
      ledger: authorizeFindingLedgerFixture({
        workflowName: 'test-workflow',
        nextId: 2,
        updatedAt: '2026-07-22T00:00:00.000Z',
        findings: [{
        id: 'F-0001',
        status: 'resolved',
        lifecycle: 'resolved',
        revision: 1,
        severity: 'high',
        title: 'Fixed issue',
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'old-run', stepName: 'review', timestamp: '2026-07-21T00:00:00.000Z' },
        lastSeen: { runId: 'old-run', stepName: 'review', timestamp: '2026-07-21T00:00:00.000Z' },
      }],
      evidenceRecords: [],
      rawFindings: [{
        rawFindingId: 'raw-existing',
        stepName: 'review',
        reviewer: 'reviewer',
        familyTag: 'bug',
        severity: 'high',
        title: 'Fixed issue',
        description: 'Previously reported issue.',
        suggestion: 'Keep the issue fixed.',
        relation: 'new',
        targetFindingId: null,
        evidence: [],
      }],
      conflicts: [],
      }),
      result: undefined,
    }));
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions,
        buildPhaseRunnerContext: vi.fn().mockReturnValue({
          cwd,
          reportDir,
          language: 'en',
          lastResponse: 'No findings.',
          getSessionId: () => undefined,
          resolveSessionKey: () => 'reviewer:primary',
          buildResumeOptions: () => ({}),
          buildNewSessionReportOptions: () => ({
            resolvedProvider: 'mock',
            resolvedModel: 'primary-capability-model',
          }),
          buildFallbackReportOptions: () => ({
            resolvedProvider: 'codex',
            resolvedModel: 'fallback-capability-model',
            resolvedProviderOptions: { codex: { reasoningEffort: 'high' } },
          }),
          resolveReportFallbackProviderModel: () => ({
            provider: 'codex',
            model: 'fallback-capability-model',
          }),
          updatePersonaSession: vi.fn(),
          resolveStepProviderModel: () => ({ provider: 'mock', model: 'primary-capability-model' }),
        }),
        buildFindingContractInstructionContext,
        buildFindingRestatementSlotContexts: vi.fn().mockReturnValue(new Map()),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'primary-capability-model' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => reportDir,
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'review task',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      structuredCaller: { normalizeFindingIntake } as unknown as StepExecutorDeps['structuredCaller'],
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'Return JSON.' },
      },
      findingLedgerStore,
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      recordSynthesizedAgentUsage: vi.fn(),
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
      onPhaseComplete: vi.fn(),
    };

    const executor = new StepExecutor(deps);
    const state = makeState();

    buildFindingContractInstructionContext.mockReturnValueOnce({
      ...findingContractContext,
      reviewer: {
        ...findingContractContext.reviewer!,
        reviewScopeSnapshotId: 'prompt-snapshot-B',
      },
    });
    const mismatchedPreparedExecution = await executor.prepareNormalStepExecution(
      step,
      state,
      'review task',
      5,
      1,
    );
    expect(mismatchedPreparedExecution.findingContractContext?.reviewer?.reviewScopeSnapshotId)
      .toBe('prompt-snapshot-B');

    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
    )).rejects.toThrow('requires prepared execution input');

    const preparedExecution = await executor.prepareNormalStepExecution(
      step,
      state,
      'review task',
      5,
      1,
    );

    const {
      findingContractContext: _findingContractContext,
      ...preparedExecutionWithoutFindingContractContext
    } = preparedExecution;
    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      preparedExecutionWithoutFindingContractContext,
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" is missing finding contract context`);

    const findingContractContextWithoutStructuredOutput = {
      ...findingContractContext,
      reviewer: undefined,
    };
    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      {
        ...preparedExecution,
        findingContractContext: findingContractContextWithoutStructuredOutput,
      },
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" is missing reviewer context`);

    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      {
        ...preparedExecution,
        executableStep: {
          ...preparedExecution.executableStep,
          structuredOutput: createRawFindingsStructuredOutput(evidence.snapshotId),
        },
      },
    )).rejects.toThrow(`Step "${step.name}" cannot combine finding_contract review reports with structured_output`);

    const actualContractIntake = await vi.importActual<typeof import('../core/workflow/findings/contract-intake.js')>(
      '../core/workflow/findings/contract-intake.js',
    );
    vi.mocked(ingestFindingContractResults).mockImplementationOnce(actualContractIntake.ingestFindingContractResults);
    const result = await executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      preparedExecution,
    );

    // 単独ステップは1レビュアーなので、owner context の凍結キーは要らない。
    // 言い直しは manager 取り込み後の slot が自前で台帳を読み直す。
    expect(buildFindingContractInstructionContext).toHaveBeenCalledWith(step, true);
    // レビュアーは markdown レポートしか書かない。raw findings のスキーマも
    // snapshot ID も、レビュアー側のプロンプトと provider options には載らない。
    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ structuredOutput: expect.anything() }),
      undefined,
    );
    expect(result.instruction).not.toContain(evidence.snapshotId);
    expect(result.instruction).not.toContain(JSON.stringify(structuredOutput.schema, null, 2));
    // Phase 1 + report attempt（primary 失敗 → fallback 成功）の2フェーズ3呼び出し。
    // raw findings は正規化係の単発呼び出しだけが作る。
    expect(agentCallCount).toBe(3);
    expect(vi.mocked(executeAgent).mock.calls[2]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'fallback-capability-model',
      resolvedProviderOptions: { codex: { reasoningEffort: 'high' } },
    });
    expect(vi.mocked(executeAgent).mock.calls[2]?.[2]?.outputSchema).toBeUndefined();
    expect(normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(normalizeFindingIntake.mock.calls[0]?.[0]).toBe('Confirmed fixed.');
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    const intake = vi.mocked(ingestFindingContractResults).mock.calls[0]![0];
    expect(intake.subResults[0]?.relationClarification).toBeUndefined();
    expect(intake.subResults[0]?.publication.rawFindings).toEqual(reviewerRawFindings);
    expect(intake.subResults[0]?.publication.reportContent).toBe('Confirmed fixed.');
    const savedLedger = findingLedgerStore.loadLedger();
    expect(savedLedger.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
    expect(savedLedger.findings.every((finding) => finding.provisional === undefined)).toBe(true);
    const report = JSON.parse(readFileSync(
      join(cwd, reportDir, 'findings-manager-validation.review.json'),
      'utf-8',
    )) as FindingManagerValidationReport;
    expect(savedLedger.findings.find(
      (finding) => finding.id === 'F-0001',
    )?.rejectedObservations?.some(
      (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
    )).toBe(true);
    expect(report.rawNormalizations?.find(
      (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
    )?.ambiguityCodes).toContain('confirmation-target-not-open');
    expect(report.interpretationStats?.managerCalls).toBe(0);
  });

  it('provider が未解決なら structured_output を fail fast にする', () => {
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: undefined, model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);

    expect(() => executor.buildPhase1Instruction(
      'Plan the next follow-up action.',
      step,
      undefined,
    )).toThrow(/structured_output.*provider is not resolved/i);
  });

  it('非native structured_output fallback は解決済みワークフロー言語を使う', () => {
    const executor = new StepExecutor({
      optionsBuilder: {
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      },
      getLanguage: () => 'ja',
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      structuredOutput: { schema: { type: 'object', properties: {}, required: [] } },
    });

    expect(executor.buildPhase1Instruction('指示', step)).toContain(
      '次の JSON schema に一致する fenced JSON block をちょうど1つ返してください',
    );
  });

  it('Team Leader親には完全な前回出力と Finding Contract ledger summary を同じ実 instruction 経路で渡す', () => {
    const previousTail = 'TAIL_FINDING: keep this review finding';
    const step = createTeamLeaderPlanningStep(makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan from {previous_response}',
      passPreviousResponse: true,
      teamLeader: {
        maxConcurrency: 2,
        timeoutMs: 1000,
      },
    }));
    const state = makeState();
    state.lastOutput = {
      persona: 'review',
      status: 'done',
      content: `${'x'.repeat(2500)}\n${previousTail}`,
      timestamp: new Date(),
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildFindingContractInstructionContext: vi.fn().mockReturnValue({
          ledgerSummary: { openFinding: 'LEDGER_SUMMARY: preserve this' },
          reportLedgerSummary: {},
          hasOpenFindings: true,
          hasWaivedFindings: false,
          hasDismissedFindings: false,
        }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'run',
      getFindingCallNamespace: () => '',
    };

    const instruction = new StepExecutor(deps).buildInstruction(step, 1, state, 'implement feature', 5);

    expect(instruction).toContain(previousTail);
    expect(instruction).toContain('x'.repeat(2500));
    expect(instruction).toContain('LEDGER_SUMMARY: preserve this');
  });

  it('明示nullでは既定の Finding Contract context を注入しない', () => {
    const buildFindingContractInstructionContext = vi.fn().mockReturnValue({
      ledgerSummary: 'OUT_OF_SCOPE_FINDING',
      reportLedgerSummary: {},
      hasOpenFindings: true,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
    });
    const step = makeStep({ name: 'fix.part', instruction: 'Scoped worker instruction' });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildFindingContractInstructionContext,
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'fix.part' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'run',
      getFindingCallNamespace: () => '',
    };

    const instruction = new StepExecutor(deps).buildInstruction(
      step,
      1,
      makeState(),
      'task',
      5,
      undefined,
      { mode: 'omit' },
    );

    expect(buildFindingContractInstructionContext).not.toHaveBeenCalled();
    expect(instruction).not.toContain('OUT_OF_SCOPE_FINDING');
    expect(instruction).not.toContain('full-ledger.json');
  });

  it('非対応 provider の structured_output fallback で required 欠落を失敗にする', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "cursor": $.result is required');
  });

  it('非対応 provider の structured_output fallback で additionalProperties false を強制する', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"ok","extra":true}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow(
      'Step "implement" requires structured_output for provider "cursor": $.extra is not allowed by the schema',
    );
  });

  it('非対応 provider の structured_output fallback で oneOf と format を含む schema を受け付ける', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"user@example.com"}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: {
              oneOf: [
                { type: 'string', format: 'email' },
                { type: 'null' },
              ],
            },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    const { response } = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      'Plan the next follow-up action.',
      undefined,
    );

    expect(response.structuredOutput).toEqual({
      result: 'user@example.com',
    });
  });

  it('native structured output 対応 provider でも structuredOutput 欠落を通さない', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "claude"');
  });

  it('native structured output 対応 provider でも required 欠落を通さない', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        structuredOutput: {},
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "claude": $.result is required');
  });

  it('native structured output 対応 provider でも additionalProperties false を強制する', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        structuredOutput: {
          result: 'ok',
          extra: true,
        },
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow(
      'Step "implement" requires structured_output for provider "claude": $.extra is not allowed by the schema',
    );
  });
});

describe('StepExecutor dynamic facet integration', () => {
  it('prepareNormalStepExecution reflects dynamic facet policyContents/knowledgeContents and throws when pool is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-df-'));
    const runPaths = buildRunPaths(cwd, 'test-run');
    mkdirSync(join(cwd, runPaths.contextPolicyRel), { recursive: true });
    mkdirSync(join(cwd, runPaths.contextKnowledgeRel), { recursive: true });
    try {
      const step = makeStep({
        name: 'fix',
        personaDisplayName: 'coder',
        instruction: 'Fix',
        dynamicFacets: { pool: 'fix', maxSelected: 4 },
      });
      const pool = {
        name: 'fix',
        candidates: [
          {
            id: 'backend',
            description: 'backend',
            policyRefs: [],
            knowledgeRefs: [],
            resolvedPolicyContents: [],
            resolvedKnowledgeContents: [],
          },
        ],
      };
      const coordinator = {
        resolveDynamicFacets: vi.fn().mockResolvedValue({
          selectedIds: ['backend'],
          effectivePolicyContents: ['policy-content'],
          effectiveKnowledgeContents: ['knowledge-content'],
          snapshot: {
            identity: 'id',
            step_name: 'fix',
            round: 1,
            selected_ids: ['backend'],
            selected_policy_refs: [],
            selected_knowledge_refs: [],
            rationale: 'r',
          },
        }),
      };
      const getFacetPool = vi.fn().mockReturnValue(pool);
      const deps: StepExecutorDeps = {
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({}),
          buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
          resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
          buildFindingContractInstructionContext: vi.fn(),
        } as unknown as StepExecutorDeps['optionsBuilder'],
        getCwd: () => cwd,
        getProjectCwd: () => cwd,
        getReportDir: () => '.takt/reports',
        getRunPaths: () => runPaths,
        getLanguage: () => undefined,
        getInteractive: () => false,
        getWorkflowSteps: () => [{ name: 'fix' }],
        getWorkflowName: () => 'test-workflow',
        getTask: () => 'task',
        getWorkflowDescription: () => undefined,
        getRetryNote: () => undefined,
        getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
        structuredCaller: {
          evaluateCondition: vi.fn(),
          judgeStatus: vi.fn(),
          decomposeTask: vi.fn(),
          requestMoreParts: vi.fn(),
        },
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
        dynamicFacetSelectorCoordinator: coordinator as unknown as StepExecutorDeps['dynamicFacetSelectorCoordinator'],
        getFacetPool,
        findingManagerAuthority: { canMarkFindings: () => false } as unknown as StepExecutorDeps['findingManagerAuthority'],
        executionProvider: 'cursor',
        executionModel: undefined,
        refreshFindingsState: vi.fn(),
        emitEvent: vi.fn(),
        recordSynthesizedAgentUsage: vi.fn(),
        getRunId: () => 'test-run',
        getFindingCallNamespace: () => '',
      };
      const executor = new StepExecutor(deps);
      const state = makeState();
      const prepared = await executor.prepareNormalStepExecution(step, state, 'task', 5, 1);

      expect(coordinator.resolveDynamicFacets).toHaveBeenCalledWith(step, state, 'task', pool);
      expect(prepared.executableStep.policyContents).toEqual([{ content: 'policy-content' }]);
      expect(prepared.executableStep.knowledgeContents).toEqual([{ content: 'knowledge-content' }]);

      getFacetPool.mockReturnValueOnce(undefined);
      await expect(
        executor.prepareNormalStepExecution(step, state, 'task', 5, 1),
      ).rejects.toThrow('Configuration error: step "fix" references unknown facet pool "fix"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
