import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { AgentResponse, WorkflowState } from '../core/models/types.js';
import type { StreamEvent } from '../shared/types/provider.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import {
  makeStep,
  makeWorkflowResumePointEntry,
} from './test-helpers.js';
import { createTeamLeaderPlanningStep } from '../core/workflow/engine/team-leader-common.js';
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

import { executeAgent } from '../agents/agent-usecases.js';
import { ingestFindingContractResults } from '../core/workflow/findings/contract-intake.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import { RawFindingsOutputValidationJsonSchema } from '../core/models/finding-schemas.js';
import { createFindingLedgerStore, type FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import {
  FINDING_CLAIM_BEGIN_MARKER,
  FINDING_CLAIM_END_MARKER,
  parseCanonicalFindingClaimReport,
} from '../shared/prompts/finding-canonical-claim.js';
import {
  createFindingReviewPublication,
  FREEFORM_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  persistFindingReviewPublication,
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

function malformedCanonicalFindingReport(): string {
  return [
    '## Result: REJECT',
    '',
    FINDING_CLAIM_BEGIN_MARKER,
    'Finding Claim',
    'Raw Finding ID: missing-feature',
    'Relation: new',
    'Target Finding ID: none',
    'Family Tag: architecture',
    'Severity: high',
    'Title: Feature is missing',
    'Description: The feature is absent.',
    'Suggestion: Implement it.',
    'Target Kind: absence',
    'Target Paths: none',
    'Review Scope Roots: ["src"]',
    'Manifest Targets: none',
    'Absence Predicate: exact_literal_absent',
    'Absence Path: none',
    'Absence Literal: attachPullRequestImages',
    'Evidence Requests:',
    '  Authoritative Quote',
    FINDING_CLAIM_END_MARKER,
  ].join('\n');
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

  function createFreeformPublicationRetryHarness(options: {
    readonly reportResponses: readonly (
      | string
      | Pick<AgentResponse, 'status' | 'content'>
        & Partial<Pick<
          AgentResponse,
          'error' | 'errorKind' | 'providerUsage' | 'sessionId' | 'timestamp'
        >>
        & { readonly streamEvents?: readonly StreamEvent[] }
    )[];
    readonly fallback: boolean;
  }) {
    let currentSessionId: string | undefined = 'initial-phase1-session';
    const updatePersonaSession = vi.fn((_sessionKey: string, sessionId: string | undefined) => {
      currentSessionId = sessionId;
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const normalizeFindingIntake = vi.fn(async (_reportContent, normalizerOptions) => {
      normalizerOptions.onPromptResolved?.({
        systemPrompt: 'normalizer system',
        userInstruction: 'normalizer prompt',
      });
      return {
        persona: 'normalizer',
        status: 'done' as const,
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-07-30T00:00:10.000Z'),
      };
    });
    const reportResponses = [...options.reportResponses];
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, agentOptions) => {
      agentOptions?.onPromptResolved?.({
        systemPrompt: 'reviewer system',
        userInstruction: prompt,
      });
      const attempt = reportResponses.shift();
      if (attempt === undefined) {
        throw new Error('Unexpected report attempt');
      }
      const response = typeof attempt === 'string'
        ? {
            status: 'done' as const,
            content: attempt,
            streamEvents: undefined,
          }
        : attempt;
      for (const event of response.streamEvents ?? []) {
        agentOptions?.onStream?.(event);
      }
      const { streamEvents: _streamEvents, ...agentResponse } = response;
      return {
        persona: 'reviewer',
        ...agentResponse,
        sessionId: `report-session-${options.reportResponses.length - reportResponses.length}`,
        timestamp: new Date('2026-07-30T00:00:00.000Z'),
      };
    });
    const buildPhaseRunnerContext = vi.fn((
      _step,
      state: WorkflowState,
      lastResponse: string,
      _updatePersonaSession,
      _onPhaseStart,
      _onPhaseComplete,
      _onJudgeStage,
      _iteration,
      _runtime,
      onProviderAttempt,
    ) => ({
      cwd,
      reportDir: runPaths.reportsAbs,
      language: 'en' as const,
      lastResponse,
      workflowName: 'test-workflow',
      iteration: state.iteration,
      getSessionId: () => currentSessionId,
      resolveSessionKey: () => 'reviewer:mock',
      buildResumeOptions: (_reportStep, sessionId: string, overrides) => ({
        resolvedProvider: 'mock' as const,
        sessionId,
        maxTurns: overrides.maxTurns,
      }),
      buildNewSessionReportOptions: (_reportStep, overrides) => ({
        resolvedProvider: 'mock' as const,
        allowedTools: overrides.allowedTools,
        maxTurns: overrides.maxTurns,
      }),
      buildFallbackReportOptions: (_reportStep, _failedOptions, overrides) => (
        options.fallback
          ? {
              resolvedProvider: 'claude' as const,
              allowedTools: overrides.allowedTools,
              maxTurns: overrides.maxTurns,
            }
          : undefined
      ),
      resolveReportFallbackProviderModel: () => (
        options.fallback ? { provider: 'claude' as const } : undefined
      ),
      updatePersonaSession,
      resolveStepProviderModel: () => ({ provider: 'mock' as const }),
      onPhaseStart,
      onPhaseComplete,
      onProviderAttempt,
    }));
    const recordSynthesizedAgentUsage = vi.fn();
    const onProviderAttempt = vi.fn((providerInfo, success, usage) => {
      recordSynthesizedAgentUsage(
        'review',
        providerInfo,
        success,
        usage,
      );
    });
    const executor = new StepExecutor({
      optionsBuilder: {
        buildPhaseRunnerContext,
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'mock',
          model: 'reviewer-model',
        }),
      },
      structuredCaller: { normalizeFindingIntake },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getRunPaths: () => runPaths,
      getFindingCallNamespace: () => '',
      getLanguage: () => 'en',
      getWorkflowName: () => 'test-workflow',
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage,
      findingLedgerStore: {
        ledgerIdentity: 'scope-retry',
      },
      onPhaseStart,
      onPhaseComplete,
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [
        { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
      ],
    });
    const state = makeState();
    const initialPhase1Response: AgentResponse = {
      persona: 'reviewer',
      status: 'done',
      content: 'Initial authoritative Phase 1 review.',
      sessionId: 'initial-phase1-session',
      timestamp: new Date('2026-07-30T00:00:00.000Z'),
    };
    const rerunPhase1Fresh = vi.fn(async () => {
      currentSessionId = 'fresh-phase1-session';
      return {
        ...initialPhase1Response,
        content: 'Fresh authoritative Phase 1 review.',
        sessionId: 'fresh-phase1-session',
        timestamp: new Date('2026-07-30T00:00:05.000Z'),
      };
    });

    return {
      executor,
      step,
      state,
      initialPhase1Response,
      rerunPhase1Fresh,
      onProviderAttempt,
      updatePersonaSession,
      normalizeFindingIntake,
      onPhaseStart,
      recordSynthesizedAgentUsage,
    };
  }

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

  it('active normal reviewerをfree-formで実行し、reviewer phase確定後に独立normalizer phaseを取り込む', async () => {
    const reviewerTimestamp = new Date('2026-07-29T01:00:00.000Z');
    const phase1Usage = {
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
      usageMissing: false,
    };
    const phase2Usage = {
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
      usageMissing: false,
    };
    const rawExcerpt = [
      FINDING_CLAIM_BEGIN_MARKER,
      'Finding Claim',
      'Raw Finding ID: none',
      'Relation: persists',
      'Target Finding ID: F-missing',
      'Family Tag: none',
      'Severity: none',
      'Title: none',
      'Description: A concrete defect.',
      'Suggestion: none',
      'Target Kind: code',
      'Target Paths: ["src/example.ts"]',
      'Review Scope Roots: none',
      'Manifest Targets: none',
      'Absence Predicate: none',
      'Absence Path: none',
      'Absence Literal: none',
      'Evidence Requests:',
      '- File Quote',
      '  Path: src/example.ts',
      '  Start Line: 1',
      '  End Line: 1',
      '  Verbatim Excerpt:',
      '  ```text',
      '  const example = false;',
      '  ```',
      FINDING_CLAIM_END_MARKER,
    ].join('\n');
    const normalizedRawFinding = {
      rawExcerpt,
      candidate: {
        rawFindingId: null,
        relation: 'persists',
        targetFindingIds: ['F-missing'],
        familyTag: null,
        severity: null,
        title: null,
        description: 'A concrete defect.',
        suggestion: null,
        target: { kind: 'code', paths: ['src/example.ts'] },
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/example.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'const example = false;',
        }],
      },
    };
    const reviewerResponse: AgentResponse = {
      persona: 'reviewer',
      status: 'done',
      content: 'Phase 1 draft; this is not the authoritative report.',
      sessionId: 'reviewer-session',
      providerUsage: phase1Usage,
      timestamp: reviewerTimestamp,
    };
    const reportContent = `## Result: REJECT\n\n${rawExcerpt}`;
    let reviewerCall = 0;
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'reviewer system',
        userInstruction: prompt,
      });
      if (reviewerCall++ === 0) {
        return reviewerResponse;
      }
      return {
        ...reviewerResponse,
        content: reportContent,
        providerUsage: phase2Usage,
        timestamp: new Date('2026-07-29T01:00:00.500Z'),
      };
    });

    const normalizeFindingIntake = vi.fn(async (_report, options) => {
      options.onPromptResolved?.({
        systemPrompt: 'normalizer system',
        userInstruction: 'normalizer prompt',
      });
      return {
        persona: 'default',
        status: 'done' as const,
        content: JSON.stringify({ rawFindings: [normalizedRawFinding] }),
        structuredOutput: { rawFindings: [normalizedRawFinding] },
        sessionId: 'discard-normalizer-session',
        timestamp: new Date('2026-07-29T01:00:01.000Z'),
      };
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
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
    const findingContractContext = {
      ledgerSummary: '{"findings":[]}',
      reportLedgerSummary: '{"ids":[]}',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        mode: 'freeform' as const,
        reviewScopeSnapshotId: 'snapshot-1',
      },
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn((
          _reportStep,
          _state,
          lastResponse,
          phaseUpdatePersonaSession,
          phaseOnStart,
          phaseOnComplete,
          _onJudgeStage,
          _iteration,
          _runtime,
          onProviderAttempt,
        ) => ({
          cwd,
          reportDir: runPaths.reportsAbs,
          language: 'en',
          lastResponse,
          workflowName: 'test-workflow',
          getSessionId: () => undefined,
          resolveSessionKey: () => 'reviewer:mock',
          buildResumeOptions: () => ({}),
          buildNewSessionReportOptions: () => ({}),
          buildFallbackReportOptions: () => undefined,
          resolveReportFallbackProviderModel: () => undefined,
          updatePersonaSession: phaseUpdatePersonaSession,
          resolveStepProviderModel: () => ({ provider: 'mock', model: 'reviewer-model' }),
          onPhaseStart: phaseOnStart,
          onPhaseComplete: phaseOnComplete,
          onProviderAttempt,
        })),
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'claude',
          model: 'sonnet',
        }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue(findingContractContext),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'test task',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        normalizeFindingIntake,
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      } as unknown as StepExecutorDeps['structuredCaller'],
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: {
        provider: 'mock',
        model: 'normalizer-model',
      },
      findingContract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'Reconcile.',
          outputContract: 'Return JSON.',
        },
      },
      findingLedgerStore: {
        ledgerIdentity: 'scope-1',
        loadLedger: () => ({ findings: [] }),
      } as StepExecutorDeps['findingLedgerStore'],
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      recordSynthesizedAgentUsage,
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
      onPhaseStart,
      onPhaseComplete,
    };
    const executor = new StepExecutor(deps);
    const state = makeState();
    const prepared = executor.prepareNormalStepExecution(
      step,
      state,
      'test task',
      5,
      1,
    );

    expect(prepared.executableStep.structuredOutput).toBeUndefined();
    const result = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      updatePersonaSession,
      undefined,
      undefined,
      prepared,
    );

    expect(normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(reviewerCall).toBe(2);
    expect(normalizeFindingIntake).toHaveBeenCalledWith(
      reportContent,
      expect.objectContaining({
        provider: 'mock',
        model: 'normalizer-model',
      }),
    );
    expect(result.response).toMatchObject({
      content: reportContent,
      sessionId: reviewerResponse.sessionId,
      providerUsage: phase1Usage,
      timestamp: new Date('2026-07-29T01:00:00.500Z'),
      structuredOutput: { rawFindings: [normalizedRawFinding] },
    });
    expect(updatePersonaSession).toHaveBeenCalledWith(
      expect.any(String),
      'reviewer-session',
    );
    expect(updatePersonaSession.mock.invocationCallOrder[0]).toBeLessThan(
      normalizeFindingIntake.mock.invocationCallOrder[0]!,
    );
    expect(onPhaseComplete.mock.calls.map(([phaseStep]) => phaseStep.name))
      .toEqual(['review', 'review', 'review:intake-normalize']);
    expect(onPhaseStart.mock.calls.map(([phaseStep]) => phaseStep.name))
      .toEqual(['review', 'review', 'review:intake-normalize']);
    expect(
      recordSynthesizedAgentUsage.mock.calls
        .filter(([stepName]) => stepName === 'review'),
    ).toEqual([
      [
        'review',
        { provider: 'mock', model: 'reviewer-model' },
        true,
        phase2Usage,
      ],
    ]);
    expect(recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'review:intake-normalize',
      expect.objectContaining({ provider: 'mock', model: 'normalizer-model' }),
      true,
      undefined,
    );
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ingestFindingContractResults).mock.calls[0]?.[0]
        .subResults[0]?.publication.rawFindings,
    ).toEqual([normalizedRawFinding]);
  });

  it.each([
    { freshOutcome: 'done' as const, expectedSuccess: true },
    { freshOutcome: 'throw' as const, expectedSuccess: false },
  ])(
    'normal FC fresh Phase 1は$freshOutcome時もusage attemptを一度だけ記録する',
    async ({ freshOutcome, expectedSuccess }) => {
      const initialResponse: AgentResponse = {
        persona: 'reviewer',
        status: 'done',
        content: 'Initial Phase 1 response.',
        timestamp: new Date('2026-07-30T01:00:00.000Z'),
      };
      const freshUsage = {
        inputTokens: 23,
        outputTokens: 7,
        totalTokens: 30,
        usageMissing: false,
      };
      const freshResponse: AgentResponse = {
        ...initialResponse,
        content: 'Fresh Phase 1 response.',
        providerUsage: freshUsage,
        timestamp: new Date('2026-07-30T01:00:01.000Z'),
      };
      let callCount = 0;
      vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: 'reviewer system',
          userInstruction: prompt,
        });
        callCount += 1;
        if (callCount === 1) {
          return initialResponse;
        }
        if (freshOutcome === 'throw') {
          throw new Error('fresh Phase 1 failed');
        }
        return freshResponse;
      });

      const recordSynthesizedAgentUsage = vi.fn();
      const step = makeStep({
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        outputContracts: [
          { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
        ],
      });
      const deps = {
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({}),
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'claude',
            model: 'sonnet',
          }),
          buildFindingContractInstructionContext: vi.fn().mockReturnValue({
            ledgerSummary: '{"findings":[]}',
            reportLedgerSummary: '{"ids":[]}',
            hasOpenFindings: false,
            hasWaivedFindings: false,
            hasDismissedFindings: false,
            reviewer: {
              mode: 'freeform',
              reviewScopeSnapshotId: 'snapshot-1',
            },
          }),
        },
        getCwd: () => cwd,
        getProjectCwd: () => cwd,
        getReportDir: () => '.takt/reports',
        getRunPaths: () => runPaths,
        getLanguage: () => 'en',
        getInteractive: () => false,
        getWorkflowSteps: () => [{ name: 'review' }],
        getWorkflowName: () => 'test-workflow',
        getTask: () => 'test task',
        getWorkflowDescription: () => undefined,
        getRetryNote: () => undefined,
        structuredCaller: {
          evaluateCondition: vi.fn(),
          judgeStatus: vi.fn(),
          decomposeTask: vi.fn(),
          requestMoreParts: vi.fn(),
        },
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
        intakeNormalize: {
          provider: 'mock',
          model: 'normalizer-model',
        },
        findingContract: {
          ledgerPath: '.takt/findings/ledger.json',
          rawFindingsPath: '.takt/findings/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'Reconcile.',
            outputContract: 'Return JSON.',
          },
        },
        findingLedgerStore: {
          ledgerIdentity: 'scope-1',
          loadLedger: () => ({ findings: [] }),
        },
        refreshFindingsState: vi.fn(),
        emitEvent: vi.fn(),
        recordSynthesizedAgentUsage,
        getFindingCallNamespace: () => '',
        onPhaseStart: vi.fn(),
        onPhaseComplete: vi.fn(),
      } as unknown as StepExecutorDeps;
      const executor = new StepExecutor(deps);
      vi.spyOn(executor, 'prepareFindingReviewPublication')
        .mockImplementation(async (input) => ({
          terminalResponse: await input.rerunPhase1Fresh(),
        }));
      const state = makeState();
      const prepared = executor.prepareNormalStepExecution(
        step,
        state,
        'test task',
        5,
        1,
      );
      const execution = executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        undefined,
        undefined,
        prepared,
      );

      if (freshOutcome === 'throw') {
        await expect(execution).rejects.toThrow('fresh Phase 1 failed');
      } else {
        await expect(execution).resolves.toBeDefined();
      }
      expect(
        recordSynthesizedAgentUsage.mock.calls
          .filter(([stepName]) => stepName === 'review'),
      ).toEqual([[
        'review',
        { provider: 'claude', model: 'sonnet' },
        expectedSuccess,
        freshOutcome === 'done' ? freshUsage : undefined,
      ]]);
    },
  );

  it('canonical grammar invalidをreport retry後にfresh Phase1から一度だけ再調査し、valid reportだけnormalizerへ渡す', async () => {
    const malformedReport = [
      '## Result: REJECT',
      '',
      FINDING_CLAIM_BEGIN_MARKER,
      'Finding Claim',
      'Raw Finding ID: missing-feature',
      'Relation: new',
      'Target Finding ID: none',
      'Family Tag: architecture',
      'Severity: high',
      'Title: Feature is missing',
      'Description: The feature is absent.',
      'Suggestion: Implement it.',
      'Target Kind: absence',
      'Target Paths: none',
      'Review Scope Roots: ["src"]',
      'Manifest Targets: none',
      'Absence Predicate: exact_literal_absent',
      'Absence Path: none',
      'Absence Literal: attachPullRequestImages',
      'Evidence Requests:',
      '  Authoritative Quote',
      FINDING_CLAIM_END_MARKER,
    ].join('\n');
    const validReport = '## Result: APPROVE\n\nNo findings.';
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [malformedReport, malformedReport, validReport],
      fallback: false,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result).toBe(true);
    if (!('publication' in result)) {
      throw new Error('Expected publication');
    }
    expect(result.publication.reportContent).toBe(validReport);
    expect(harness.rerunPhase1Fresh).toHaveBeenCalledOnce();
    expect(harness.normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(harness.normalizeFindingIntake).toHaveBeenCalledWith(
      validReport,
      expect.anything(),
    );
    expect(
      harness.onPhaseStart.mock.calls
        .filter(([, phase]) => phase === 2)
        .map((call) => call[5]),
    ).toEqual([
      'review:3:2:1',
      'review:3:2:2',
      'review:3:2:3',
    ]);
  });

  it('empty reportをfresh sessionでも回復できなければfresh Phase 1後のvalid reportを採用する', async () => {
    const validReport = '## Result: APPROVE\n\nNo findings.';
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: ['   ', '', validReport],
      fallback: false,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result && result.publication.reportContent)
      .toBe(validReport);
    expect(harness.rerunPhase1Fresh).toHaveBeenCalledOnce();
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(3);
  });

  it('invalid後のretryとfallbackがprovider errorでもfresh Phase 1回復を失わない', async () => {
    const validReport = '## Result: APPROVE\n\nNo findings.';
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [
        malformedCanonicalFindingReport(),
        malformedCanonicalFindingReport(),
        {
          status: 'error',
          content: '',
          error: 'fallback transport failed',
        },
        validReport,
      ],
      fallback: true,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result && result.publication.reportContent)
      .toBe(validReport);
    expect(harness.rerunPhase1Fresh).toHaveBeenCalledOnce();
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(4);
  });

  it('fresh Phase 1がdone空ならterminal errorにしてfinal Phase 2へ進めずsessionを破棄する', async () => {
    const malformedReport = malformedCanonicalFindingReport();
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [malformedReport, malformedReport],
      fallback: false,
    });
    harness.rerunPhase1Fresh.mockResolvedValueOnce({
      persona: 'reviewer',
      status: 'done',
      content: '   ',
      sessionId: 'empty-fresh-phase1-session',
      timestamp: new Date('2026-07-30T00:00:05.000Z'),
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('terminalResponse' in result).toBe(true);
    if (!('terminalResponse' in result)) {
      throw new Error('Expected terminal response');
    }
    expect(result.terminalResponse).toMatchObject({
      status: 'error',
      content: '',
      error: PHASE1_EMPTY_OUTPUT_ERROR,
    });
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(harness.updatePersonaSession).toHaveBeenLastCalledWith(
      'reviewer:mock',
      undefined,
    );
  });

  it('validatorがtrimした本文とbyte一致するresponseだけをnormalizerへ渡す', async () => {
    const validReport = '## Result: APPROVE\n\nNo findings.';
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [`\n${validReport}\n`],
      fallback: false,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('publication' in result && result.publication.reportContent)
      .toBe(validReport);
    expect(harness.normalizeFindingIntake).toHaveBeenCalledWith(
      validReport,
      expect.anything(),
    );
  });

  it('production phase context経由でinvalid report usageを失敗として一度だけ記録する', async () => {
    const invalidUsage = {
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      usageMissing: false,
    };
    const validUsage = {
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      usageMissing: false,
    };
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [
        {
          status: 'done',
          content: malformedCanonicalFindingReport(),
          providerUsage: invalidUsage,
        },
        {
          status: 'done',
          content: '## Result: APPROVE\n\nNo findings.',
          providerUsage: validUsage,
        },
      ],
      fallback: false,
    });

    await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect(
      harness.recordSynthesizedAgentUsage.mock.calls
        .filter(([stepName]) => stepName === 'review'),
    ).toEqual([
      ['review', { provider: 'mock' }, false, invalidUsage],
      ['review', { provider: 'mock' }, true, validUsage],
    ]);
  });

  it('empty outputでreport回復を使い切ったterminalはempty種別を固定文で示す', async () => {
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [' ', '', '\n'],
      fallback: false,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('terminalResponse' in result).toBe(true);
    if (!('terminalResponse' in result)) {
      throw new Error('Expected terminal response');
    }
    expect(result.terminalResponse.error).toBe(
      'Finding contract reviewer "review" exhausted report recovery attempts; failure types: empty output',
    );
  });

  it('terminal固定文は初回cycleとfinal attemptのfailure種別を集約する', async () => {
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [
        malformedCanonicalFindingReport(),
        malformedCanonicalFindingReport(),
        {
          status: 'error',
          content: '',
          error: 'fallback transport failed',
        },
        '',
      ],
      fallback: true,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('terminalResponse' in result).toBe(true);
    if (!('terminalResponse' in result)) {
      throw new Error('Expected terminal response');
    }
    expect(result.terminalResponse.error).toBe(
      'Finding contract reviewer "review" exhausted report recovery attempts; failure types: invalid output, provider error, empty output',
    );
    expect(result.terminalResponse.error).not.toContain('fallback transport failed');
  });

  it('tool callでreport回復を使い切ったterminalはtool種別を固定文で示す', async () => {
    const toolAttempt = {
      status: 'done' as const,
      content: 'discarded model body',
      streamEvents: [{
        type: 'tool_use' as const,
        data: {
          tool: 'run',
          input: { command: 'echo unsafe' },
          id: 'tool-call',
        },
      }],
    };
    const harness = createFreeformPublicationRetryHarness({
      reportResponses: [toolAttempt, toolAttempt, toolAttempt],
      fallback: false,
    });

    const result = await harness.executor.prepareFindingReviewPublication({
      step: harness.step,
      executableStep: harness.step,
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: harness.state,
      phase1Response: harness.initialPhase1Response,
      agentOptions: { resolvedProvider: 'mock' },
      rerunPhase1Fresh: harness.rerunPhase1Fresh,
      onProviderAttempt: harness.onProviderAttempt,
      updatePersonaSession: harness.updatePersonaSession,
    });

    expect('terminalResponse' in result).toBe(true);
    if (!('terminalResponse' in result)) {
      throw new Error('Expected terminal response');
    }
    expect(result.terminalResponse.error).toBe(
      'Finding contract reviewer "review" exhausted report recovery attempts; failure types: forbidden tool call',
    );
    expect(result.terminalResponse.error).not.toContain('discarded model body');
  });

  it.each([
    { fallback: false, expectedAttempts: 3 },
    { fallback: true, expectedAttempts: 4 },
  ])(
    'canonical grammar invalidを全report経路で拒否したらfresh Phase1を一度だけ使ってterminalにする: fallback=$fallback',
    async ({ fallback, expectedAttempts }) => {
      const malformedReport = [
        '## Result: REJECT',
        '',
        FINDING_CLAIM_BEGIN_MARKER,
        'Finding Claim',
        'Raw Finding ID: missing-feature',
        'Relation: new',
        'Target Finding ID: none',
        'Family Tag: architecture',
        'Severity: high',
        'Title: Feature is missing',
        'Description: The feature is absent.',
        'Suggestion: Implement it.',
        'Target Kind: absence',
        'Target Paths: none',
        'Review Scope Roots: ["src"]',
        'Manifest Targets: none',
        'Absence Predicate: exact_literal_absent',
        'Absence Path: none',
        'Absence Literal: attachPullRequestImages',
        'Evidence Requests:',
        '  Authoritative Quote',
        FINDING_CLAIM_END_MARKER,
      ].join('\n');
      const harness = createFreeformPublicationRetryHarness({
        reportResponses: Array.from(
          { length: expectedAttempts },
          () => malformedReport,
        ),
        fallback,
      });

      const result = await harness.executor.prepareFindingReviewPublication({
        step: harness.step,
        executableStep: harness.step,
        parentStepName: 'reviewers',
        stepIteration: 1,
        state: harness.state,
        phase1Response: harness.initialPhase1Response,
        agentOptions: { resolvedProvider: 'mock' },
        rerunPhase1Fresh: harness.rerunPhase1Fresh,
        onProviderAttempt: harness.onProviderAttempt,
        updatePersonaSession: harness.updatePersonaSession,
      });

      expect('terminalResponse' in result).toBe(true);
      if (!('terminalResponse' in result)) {
        throw new Error('Expected terminal response');
      }
      expect(result.terminalResponse).toMatchObject({
        persona: 'review',
        status: 'error',
        error: expect.stringContaining(
          'exhausted report recovery attempts; failure types: invalid output',
        ),
      });
      expect(harness.rerunPhase1Fresh).toHaveBeenCalledOnce();
      expect(harness.normalizeFindingIntake).not.toHaveBeenCalled();
      expect(harness.updatePersonaSession).toHaveBeenLastCalledWith(
        'reviewer:mock',
        undefined,
      );
      expect(
        harness.onPhaseStart.mock.calls
          .filter(([, phase]) => phase === 2)
          .map((call) => call[5]),
      ).toEqual(
        Array.from(
          { length: expectedAttempts },
          (_, index) => `review:3:2:${index + 1}`,
        ),
      );
    },
  );

  it('normalizerがprompt callback前にfail-fastしても合成phaseのstart/error/usageを記録する', async () => {
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const recordSynthesizedAgentUsage = vi.fn();
    const executor = new StepExecutor({
      structuredCaller: {
        normalizeFindingIntake: vi.fn(async () => {
          throw new Error('normalizer failed');
        }),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getLanguage: () => 'en',
      getWorkflowName: () => 'test-workflow',
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage,
      onPhaseStart,
      onPhaseComplete,
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
    });

    await expect(executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: '## Result: APPROVE\n\nReview report.',
      timestamp: new Date('2026-07-29T00:00:00.000Z'),
    }, 3)).rejects.toThrow('normalizer failed');

    expect(onPhaseStart).toHaveBeenCalledOnce();
    expect(onPhaseStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'review:intake-normalize' }),
      1,
      'execute',
      expect.stringContaining('## Result: APPROVE'),
      expect.objectContaining({
        systemPrompt: '',
        userInstruction: expect.stringContaining('## Result: APPROVE'),
      }),
      'review:intake-normalize:3:1:1',
      3,
    );
    expect(onPhaseComplete).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'review:intake-normalize' }),
      1,
      'execute',
      '',
      'error',
      'normalizer failed',
      'review:intake-normalize:3:1:1',
      3,
    );
    expect(recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'review:intake-normalize',
      expect.objectContaining({ provider: 'mock', model: 'normalizer-model' }),
      false,
      undefined,
    );
  });

  it('canonical blockの欠落抽出を同じreportだけで1回訂正し、成功時だけ返す', async () => {
    const block = [
      FINDING_CLAIM_BEGIN_MARKER,
      'Finding Claim',
      'Raw Finding ID: none',
      'Relation: new',
      'Target Finding ID: none',
      'Family Tag: bug',
      'Severity: high',
      'Title: Broken behavior',
      'Description: The behavior is broken.',
      'Suggestion: Fix it.',
      'Target Kind: code',
      'Target Paths: ["src/example.ts"]',
      'Review Scope Roots: none',
      'Manifest Targets: none',
      'Absence Predicate: none',
      'Absence Path: none',
      'Absence Literal: none',
      'Evidence Requests:',
      '- File Quote',
      '  Path: src/example.ts',
      '  Start Line: 1',
      '  End Line: 1',
      '  Verbatim Excerpt:',
      '  ```text',
      '  const example = false;',
      '  ```',
      FINDING_CLAIM_END_MARKER,
    ].join('\n');
    const report = `## Result: REJECT\n\n${block}`;
    const correctedItem = parseCanonicalFindingClaimReport(report).report!.items[0]!;
    const normalizeFindingIntake = vi.fn()
      .mockResolvedValueOnce({
        persona: 'normalizer',
        status: 'done',
        content: '{"rawFindings":[]}',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-07-29T02:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        persona: 'normalizer',
        status: 'done',
        content: JSON.stringify({ rawFindings: [correctedItem] }),
        structuredOutput: { rawFindings: [correctedItem] },
        timestamp: new Date('2026-07-29T02:00:01.000Z'),
      });
    const onPhaseStart = vi.fn();
    const executor = new StepExecutor({
      optionsBuilder: {
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'mock',
          model: 'normalizer-model',
        }),
      },
      structuredCaller: { normalizeFindingIntake },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getLanguage: () => 'en',
      getWorkflowName: () => 'test-workflow',
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage: vi.fn(),
      onPhaseStart,
      onPhaseComplete: vi.fn(),
    } as unknown as StepExecutorDeps);
    const step = makeStep({ name: 'review', persona: 'reviewer', instruction: 'Review.' });

    const result = await executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: report,
      timestamp: new Date('2026-07-29T02:00:00.000Z'),
    }, 4);

    expect(result.response.structuredOutput).toEqual({ rawFindings: [correctedItem] });
    expect(normalizeFindingIntake).toHaveBeenCalledTimes(2);
    expect(normalizeFindingIntake.mock.calls.map(([input]) => input)).toEqual([report, report]);
    expect(normalizeFindingIntake.mock.calls.map(([, options]) => options.mode))
      .toEqual(['initial', 'correction']);
    expect(onPhaseStart.mock.calls.map(([phaseStep]) => phaseStep.name)).toEqual([
      'review:intake-normalize',
      'review:intake-normalize-correction',
    ]);
  });

  it('normalized itemの訂正は1回だけ行い、不正blockはnormalizer前にfail-loudする', async () => {
    const validBlock = [
      FINDING_CLAIM_BEGIN_MARKER,
      'Finding Claim',
      'Raw Finding ID: code-1',
      'Relation: new',
      'Target Finding ID: none',
      'Family Tag: bug',
      'Severity: high',
      'Title: Broken behavior',
      'Description: The behavior is broken.',
      'Suggestion: Fix it.',
      'Target Kind: code',
      'Target Paths: ["src/example.ts"]',
      'Review Scope Roots: none',
      'Manifest Targets: none',
      'Absence Predicate: none',
      'Absence Path: none',
      'Absence Literal: none',
      'Evidence Requests:',
      '- File Quote',
      '  Path: src/example.ts',
      '  Start Line: 1',
      '  End Line: 1',
      '  Verbatim Excerpt:',
      '  ```text',
      '  const example = false;',
      '  ```',
      FINDING_CLAIM_END_MARKER,
    ].join('\n');
    const emptyResponse = {
      persona: 'normalizer',
      status: 'done' as const,
      content: '{"rawFindings":[]}',
      structuredOutput: { rawFindings: [] },
      timestamp: new Date('2026-07-29T03:00:00.000Z'),
    };
    const normalizeFindingIntake = vi.fn().mockResolvedValue(emptyResponse);
    const executor = new StepExecutor({
      optionsBuilder: {
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'mock',
          model: 'normalizer-model',
        }),
      },
      structuredCaller: { normalizeFindingIntake },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getLanguage: () => 'en',
      getWorkflowName: () => 'test-workflow',
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage: vi.fn(),
    } as unknown as StepExecutorDeps);
    const step = makeStep({ name: 'review', persona: 'reviewer', instruction: 'Review.' });

    await expect(executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: `## Result: REJECT\n\n${validBlock}`,
      timestamp: new Date('2026-07-29T03:00:00.000Z'),
    }, 5)).rejects.toThrow('remained invalid after one correction');
    expect(normalizeFindingIntake).toHaveBeenCalledTimes(2);

    normalizeFindingIntake.mockClear();
    await expect(executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: [
        '## Result: REJECT',
        '',
        FINDING_CLAIM_BEGIN_MARKER,
        'Finding Claim',
        'Relation: new',
        FINDING_CLAIM_END_MARKER,
      ].join('\n'),
      timestamp: new Date('2026-07-29T03:00:02.000Z'),
    }, 6)).rejects.toThrow('expected "Raw Finding ID"');
    expect(normalizeFindingIntake).not.toHaveBeenCalled();

    const needReplan = await executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: '## Result: NEED_REPLAN\n\nReview scope must be replanned.',
      timestamp: new Date('2026-07-29T03:00:03.000Z'),
    }, 7);
    expect(needReplan.response.structuredOutput).toEqual({ rawFindings: [] });
    expect(normalizeFindingIntake).toHaveBeenCalledOnce();
  });

  it('canonical publicationをresumeしてもnormalizerを再実行せず同じpublicationを再利用する', () => {
    const reportContent = '## Result: APPROVE\n\nNo findings.';
    const identity = {
      scopeIdentity: 'scope-1',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
      reviewerStepName: 'review',
      reportName: 'review.md',
    };
    const publication = createFindingReviewPublication({
      identity,
      protocol: FREEFORM_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [],
    });
    persistFindingReviewPublication(runPaths.reportsAbs, { publication });
    const normalizeFindingIntake = vi.fn();
    const executor = new StepExecutor({
      structuredCaller: { normalizeFindingIntake },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getRunPaths: () => runPaths,
      getFindingCallNamespace: () => '',
      findingLedgerStore: {
        ledgerIdentity: 'scope-1',
      },
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [
        { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
      ],
    });

    const first = executor.resumeFindingReviewPublication({
      step,
      parentStepName: 'reviewers',
      stepIteration: 2,
    });
    const second = executor.resumeFindingReviewPublication({
      step,
      parentStepName: 'reviewers',
      stepIteration: 2,
    });

    expect(first?.publication.publicationId).toBe(publication.publicationId);
    expect(second?.publication.publicationId).toBe(publication.publicationId);
    expect(first?.response.structuredOutput).toEqual({ rawFindings: [] });
    expect(normalizeFindingIntake).not.toHaveBeenCalled();
    expect(readFileSync(join(runPaths.reportsAbs, 'review.md'), 'utf8')).toBe(reportContent);
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
          verbatimExcerpt: evidence.verbatimExcerpt,
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
        mode: 'structured',
        rawFindingsStructuredOutput: structuredOutput,
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
      if (callIndex === 2) {
        return {
          persona: 'reviewer',
          status: 'done',
          content: '',
          structuredOutput: {
            reportContent: 'Confirmed fixed.',
            rawFindings: 'invalid',
          },
          timestamp: new Date('2026-07-22T00:00:01.000Z'),
        };
      }
      if (callIndex > 2) {
        return {
          persona: 'reviewer',
          status: 'done',
          content: '',
          structuredOutput: {
            reportContent: 'Confirmed fixed.',
            rawFindings: reviewerRawFindings,
          },
          timestamp: new Date('2026-07-22T00:00:01.000Z'),
        };
      }
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'Confirmed fixed.',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-07-22T00:00:00.000Z'),
      };
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
    const findingLedgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      runId: 'test-run',
      reportDir: join(cwd, reportDir),
      workflowName: 'test-workflow',
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
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
        interpretations: [],
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
          buildFallbackReportOptions: (reportStep) => ({
            resolvedProvider: 'codex',
            resolvedModel: 'fallback-capability-model',
            resolvedProviderOptions: { codex: { reasoningEffort: 'high' } },
            outputSchema: reportStep.structuredOutput?.schema,
          }),
          resolveReportFallbackProviderModel: () => ({
            provider: 'codex',
            model: 'fallback-capability-model',
          }),
          updatePersonaSession: vi.fn(),
          resolveStepProviderModel: () => ({ provider: 'mock', model: 'primary-capability-model' }),
        }),
        buildFindingContractInstructionContext,
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
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      findingContract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
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
    const mismatchedPreparedExecution = executor.prepareNormalStepExecution(
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

    const preparedExecution = executor.prepareNormalStepExecution(
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
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" has mismatched structured output`);

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

    expect(buildFindingContractInstructionContext).toHaveBeenCalledWith(step, 'structured');
    expect(buildAgentOptions).toHaveBeenCalledWith(expect.objectContaining({
      structuredOutput,
    }), undefined);
    expect(result.instruction).not.toContain(evidence.snapshotId);
    expect(result.instruction).toContain(JSON.stringify(structuredOutput.schema, null, 2));
    expect(agentCallCount).toBe(4);
    expect(vi.mocked(executeAgent).mock.calls[3]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'fallback-capability-model',
      resolvedProviderOptions: { codex: { reasoningEffort: 'high' } },
      outputSchema: expect.objectContaining({
        required: ['reportContent', 'rawFindings'],
      }),
      permissionMode: 'readonly',
      allowedTools: [],
    });
    expect(vi.mocked(executeAgent).mock.calls[3]?.[2]?.sessionId).toBeUndefined();
    const publicationCorrectionInstruction = vi.mocked(executeAgent).mock.calls[3]?.[1] as string;
    expect(publicationCorrectionInstruction).toContain('MUST include both reportContent and rawFindings');
    expect(publicationCorrectionInstruction).toContain('byte-for-byte identical');
    expect(publicationCorrectionInstruction).toContain('"reportContent": "Confirmed fixed."');
    expect(publicationCorrectionInstruction).toContain('"rawFindings": "invalid"');
    expect(publicationCorrectionInstruction).not.toContain('Do not repeat the report text');
    expect(vi.mocked(executeAgent).mock.calls.some(
      ([, instruction]) => instruction.includes('Some of your raw findings have contradictory relation/targetFindingId labeling'),
    )).toBe(false);
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
    expect(report.unsupportedRawFindings?.some(
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
