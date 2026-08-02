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
import type { AgentResponse, FindingContractConfig, WorkflowState, WorkflowStep } from '../core/models/types.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';
import type { BuildInstructionOptions } from '../core/workflow/engine/StepExecutor.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import type { FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { makeRule, makeStep } from './test-helpers.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { snapshotWorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';

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
const TEST_EVENT_ATTRIBUTION = {
  iteration: 1,
  scope: snapshotWorkflowExecutionScope([
    { workflow: 'test-workflow', step: 'reviewers', kind: 'agent' },
  ]),
};

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

function makeFindingContractContext(
  overrides: Partial<FindingContractInstructionContext> = {},
): FindingContractInstructionContext {
  return {
    ledgerSummary: '{"findings":[]}',
    reportLedgerSummary: '{"ids":[]}',
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    rawFindingsStructuredOutput: createRawFindingsStructuredOutput('round-snapshot-abc123'),
    reviewScopeSnapshotId: 'round-snapshot-abc123',
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSnapshotIdEnum(context: FindingContractInstructionContext): unknown {
  const properties = context.rawFindingsStructuredOutput?.schema.properties;
  if (!isRecord(properties) || !isRecord(properties.rawFindings)) {
    return undefined;
  }
  const items = properties.rawFindings.items;
  if (!isRecord(items) || !isRecord(items.properties) || !isRecord(items.properties.snapshotId)) {
    return undefined;
  }
  return items.properties.snapshotId.enum;
}

function makeRunner(options: {
  withFindingContract?: boolean;
  projectCwd?: string;
  reportDir?: string;
  findingContractContext?: FindingContractInstructionContext;
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
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  });
  let findingLedgerStore: NonNullable<ParallelRunnerDeps['findingLedgerStore']>;
  findingLedgerStore = {
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
  const deps: ParallelRunnerDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
      resolveStepProviderModelBeforeAutoRouting: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      buildFindingContractInstructionContext: vi.fn().mockReturnValue(
        options.findingContractContext ?? makeFindingContractContext(),
      ),
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
      projectCwd,
    },
    getCwd: () => projectCwd,
    getReportDir: () => reportDir,
    getWorkflowName: () => 'test-workflow',
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
    ...(withFindingContract ? { findingContract: FINDING_CONTRACT } : {}),
    findingLedgerStore,
    runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
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

    const result = await runner.runParallelStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      undefined,
      undefined,
      TEST_EVENT_ATTRIBUTION,
    );
    expect(result.response.status, result.response.error).toBe('done');

    // WorkflowEngineSetup と同じヘルパ経由で、ラウンドに1回だけ呼ばれる
    // （sub-step ごとに独立して呼ぶと、間に working tree が変化した場合に
    // reviewer ごとに異なる snapshotId を配ってしまう — 並行実行の semaphore
    // 直列化時に特に問題になる）。
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledTimes(1);
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).toHaveBeenCalledWith(step, true);
    expect(vi.mocked(ingestFindingContractResults).mock.calls[0]?.[0].eventAttribution)
      .toEqual(TEST_EVENT_ATTRIBUTION);

    const builtContext = vi.mocked(deps.optionsBuilder.buildFindingContractInstructionContext).mock.results[0]?.value;
    expect(builtContext).toBeDefined();
    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    expect(buildInstructionCalls).toHaveLength(2);
    for (const call of buildInstructionCalls) {
      const findingContractPolicy = (call[5] as BuildInstructionOptions).findingContractPolicy;
      expect(findingContractPolicy?.mode).toBe('explicit');
      if (findingContractPolicy?.mode !== 'explicit') throw new Error('Expected explicit Finding Contract context');
      expect(findingContractPolicy.context).toBe(builtContext);
      expect(findingContractPolicy.context.reviewScopeSnapshotId).toBe('round-snapshot-abc123');
      expect(getSnapshotIdEnum(findingContractPolicy.context)).toEqual(['', 'round-snapshot-abc123']);
    }

    const outputContract = builtContext?.rawFindingsStructuredOutput;
    expect(outputContract).toBeDefined();
    for (const call of vi.mocked(deps.optionsBuilder.buildAgentOptions).mock.calls) {
      const executableStep = call[0] as WorkflowStep;
      expect(executableStep.structuredOutput).toBe(outputContract);
      expect(executableStep.structuredOutput?.schema).toBe(outputContract?.schema);
    }
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
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
        rawFindingsStructuredOutput: createRawFindingsStructuredOutput(evidence.snapshotId),
        reviewScopeSnapshotId: evidence.snapshotId,
      });
      const { runner, deps } = makeRunner({
        projectCwd,
        reportDir,
        findingContractContext,
      });
      const reviewerRawFindings = [{
        rawFindingId: 'confirmation-resolved',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'The previously reported issue remains fixed.',
        suggestion: '',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        ...evidence,
      }];
      let ledger: FindingLedger = {
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
          location: evidence.location,
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
          location: evidence.location,
          description: 'Previously reported issue.',
          relation: 'new',
        }],
        conflicts: [],
        interpretations: [],
      };
      const ledgerStore = deps.findingLedgerStore!;
      await ledgerStore.updateLedger(() => ({ ledger, result: undefined }));
      vi.mocked(ledgerStore.saveRawFindings).mockReturnValue(join(projectCwd, 'raw-findings.json'));
      queueAgentResponse(makeAgentResponse({
        persona: 'ai-antipattern-review',
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

      const result = await runner.runParallelStep(
        makeParallelStep(),
        makeState(),
        'test task',
        5,
        vi.fn(),
        undefined,
        undefined,
        TEST_EVENT_ATTRIBUTION,
      );
      expect(result.response.status, result.response.error).toBe('done');

      ledger = ledgerStore.loadLedger();
      const reports = vi.mocked(ledgerStore.saveManagerValidationReport).mock.calls
        .map(([report]) => report);
      expect(executeAgent).toHaveBeenCalledTimes(2);
      expect(ingestFindingContractResults).toHaveBeenCalledOnce();
      const intake = vi.mocked(ingestFindingContractResults).mock.calls[0]![0];
      expect(intake.subResults[0]?.relationClarification).toBeUndefined();
      expect(intake.subResults[0]?.response.structuredOutput?.rawFindings).toEqual(reviewerRawFindings);
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

  it('rejects a parallel reviewer context when the schema snapshot enum is A but the prompt snapshot token is B', async () => {
    const { runner, deps } = makeRunner();
    vi.mocked(deps.optionsBuilder.buildFindingContractInstructionContext).mockReturnValue(
      makeFindingContractContext({ reviewScopeSnapshotId: 'prompt-snapshot-B' }),
    );

    const result = await runner.runParallelStep(
      makeParallelStep(),
      makeState(),
      'test task',
      5,
      vi.fn(),
      undefined,
      undefined,
      TEST_EVENT_ATTRIBUTION,
    );

    expect(result.response.status).toBe('error');
    expect(result.response.error).toMatch(/snapshotId enum.*exactly/);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('does not call optionsBuilder.buildFindingContractInstructionContext when the workflow has no finding_contract configured', async () => {
    const { runner, deps } = makeRunner({ withFindingContract: false });
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({ persona: 'ai-antipattern-review', content: '[STEP:1] approved' }));
    queueAgentResponse(makeAgentResponse({ persona: 'security-review', content: '[STEP:1] approved' }));

    const result = await runner.runParallelStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      undefined,
      undefined,
      TEST_EVENT_ATTRIBUTION,
    );

    expect(result.response.status, result.response.error).toBe('done');
    expect(deps.optionsBuilder.buildFindingContractInstructionContext).not.toHaveBeenCalled();
    const buildInstructionCalls = vi.mocked(deps.stepExecutor.buildInstruction).mock.calls;
    for (const call of buildInstructionCalls) {
      expect((call[5] as BuildInstructionOptions).findingContractPolicy).toBeUndefined();
    }
  });
});
