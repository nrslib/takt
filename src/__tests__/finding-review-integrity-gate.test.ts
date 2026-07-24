/**
 * Engine-level coverage for the review-integrity gate (codex 対策#4 の二系統台帳 +
 * codex 検証ブロッカー#1). 二系統台帳では、機械照合を通らない reviewer の主張は
 * product finding ではなく reviewer anomaly（review-integrity 側）へ隔離される。
 * だが「レビュー全体が anomaly に隔離された run」は product gate（open/provisional）
 * が空になり、そのままだと即 COMPLETE で実質レビューされずに通ってしまう。
 *
 * ここでは engine レベルで:
 *   1. fail-closed: 未昇格 anomaly が残るのに COMPLETE を指す custom workflow は、
 *      エンジンの completion gate が COMPLETE を拒否して abort する（配線漏れでも
 *      安全側）。
 *   2. bounded 再レビュー → replan: anomaly 予算を使い切ったら要件を維持した
 *      再計画へ進み、再計画後も解消不能な反復だけ loop monitor が停止する。
 * を検証する。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ingestFindingContractResultsMock } = vi.hoisted(() => ({
  ingestFindingContractResultsMock: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn((provider: string) => ({
    supportsStructuredOutput: provider !== 'cursor',
    keepsAllowedToolWithoutEdit: () => false,
  })),
}));

vi.mock('../core/workflow/findings/snapshot.js', () => ({
  computeReviewScopeSnapshotId: vi.fn(() => 'test-review-snapshot'),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: async (...args: Parameters<typeof actual.ingestFindingContractResults>) => {
      ingestFindingContractResultsMock();
      return actual.ingestFindingContractResults(...args);
    },
  };
});

import { WorkflowEngine } from '../core/workflow/index.js';
import type { FindingLedger, WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import {
  createFindingLedgerStore,
  resolveFindingLedgerRoot,
} from '../core/workflow/findings/store.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { loadWorkflowFileWithResolutionOptions } from '../infra/config/loaders/workflowResolvedLoader.js';
import { runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { resolveWorkflowCallContinuation } from '../core/workflow/run/resume-point.js';

function createTestTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-review-integrity-'));
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  return dir;
}

// A hallucinated finding: a fresh claim citing a file that does not exist, with no
// verifiable evidence → the engine isolates it as a reviewer anomaly (never a
// product finding). The reviewer re-emits the same raw every round.
const HALLUCINATED_RAW = {
  rawFindingId: 'h-1',
  familyTag: 'security',
  severity: 'high',
  title: 'Hallucinated issue in a nonexistent file',
  location: 'src/does-not-exist.ts:99',
  description: 'Claims a bug in a file that is not part of the reviewed tree.',
  suggestion: '',
  relation: 'new',
  targetFindingId: '',
};

function mockReviewerEmitsHallucination(): void {
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
    const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
    if (schemaText.includes('"rawFindings"')) {
      return {
        persona,
        status: 'done',
        content: 'Review report body.',
        structuredOutput: { rawFindings: [HALLUCINATED_RAW] },
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    }
    // findings-manager is deterministic for an all-anomaly batch (no LLM decision
    // call), but mock it defensively; any other agent call just approves.
    return {
      persona,
      status: 'done',
      content: 'approved',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    };
  });
}

function reviewerStep(rules: ReturnType<typeof makeRule>[]): ReturnType<typeof makeStep> {
  return makeStep({
    name: 'reviewers',
    persona: 'reviewer',
    instruction: 'Review.',
    outputContracts: [
      { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
    ],
    rules,
  });
}

function seedReviewerAnomalyLedger(cwd: string, exhausted = true): void {
  const findingsDir = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings');
  mkdirSync(findingsDir, { recursive: true });
  const observation = {
    runId: 'seed-run',
    stepName: 'gemma-reviewer',
    timestamp: '2026-06-13T00:00:00.000Z',
  };
  const ledger: FindingLedger = {
    version: 1,
    workflowName: 'attested-parent',
    nextId: 1,
    updatedAt: observation.timestamp,
    findings: [],
    rawFindings: [],
    conflicts: [],
    reviewerAnomalies: [{
      id: 'RA-GEMMA',
      kind: 'quote-mismatch',
      stableKey: 'gemma-stable-key',
      lineageKey: 'gemma-lineage',
      sourceRawFindingIds: ['gemma-raw-1'],
      reviewers: ['gemma-reviewer'],
      title: 'Gemma source quote mismatch',
      mismatchReason: 'verbatimExcerpt does not match the reviewed source',
      firstObserved: observation,
      lastObserved: observation,
      occurrences: 1,
    }],
    reviewIntegrity: {
      roundMarkers: Array.from({ length: 6 }, (_, index) => `review-round-${index + 1}`),
      firstRoundAt: observation.timestamp,
      exhausted,
    },
  };
  writeFileSync(
    join(findingsDir, 'peer-review.json'),
    JSON.stringify(ledger, null, 2),
  );
}

function createAttestedFinalGateChild(cwd: string): WorkflowConfig {
  const filePath = join(
    getBuiltinWorkflowsDir('ja'),
    'merge-readiness-finding-contract-final-gate.yaml',
  );
  return loadWorkflowFileWithResolutionOptions(filePath, {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: 'builtin',
  });
}

function createAttestedCallStep(name: string, next: string): WorkflowConfig['steps'][number] {
  return {
    name,
    kind: 'workflow_call',
    call: 'attested-final-gate-child',
    personaDisplayName: name,
    instruction: '',
    rules: [
      makeRule('COMPLETE', next),
      makeRule('ABORT', 'ABORT'),
    ],
  };
}

function mockCleanApprovals(
  rawFindingsByPersona: Readonly<Record<string, typeof HALLUCINATED_RAW>> = {},
): void {
  vi.mocked(runStatusJudgmentPhase).mockResolvedValue({
    label: 'approved',
    method: 'ai_judge',
  });
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
    const emitsRawFindings = options?.outputSchema
      && JSON.stringify(options.outputSchema).includes('"rawFindings"');
    return {
      persona,
      status: 'done',
      content: 'approved',
      ...(emitsRawFindings
        ? { structuredOutput: { rawFindings: rawFindingsByPersona[persona]
          ? [rawFindingsByPersona[persona]]
          : [] } }
        : {}),
      timestamp: new Date(),
    };
  });
}

describe('review-integrity gate (engine level, codex 検証ブロッカー#1)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTestTmpDir();
    vi.clearAllMocks();
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fail-closed: 未昇格 anomaly が残るのに COMPLETE を指す custom workflow はエンジンの completion gate が拒否して abort する（配線漏れでも product gate 空で通さない）', async () => {
    mockReviewerEmitsHallucination();

    // 配線漏れのある custom workflow: anomaly の存在を無視し、product gate
    // （open == 0）だけを見て COMPLETE を指す。
    const config: WorkflowConfig = {
      name: 'review-integrity-failclosed',
      maxSteps: 4,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        reviewerStep([makeRule('when(findings.open.count == 0 && findings.conflicts.count == 0)', 'COMPLETE')]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // product gate は空（幻覚は anomaly に隔離され finding にならない）だが、
    // review-integrity gate が COMPLETE を拒否する。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('reviewer anomaly');

    // 台帳: product finding 0、未昇格 anomaly 1。
    const ledgerPath = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: unknown[];
      reviewerAnomalies?: Array<{ kind: string; promotedFindingId?: string }>;
    };
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewerAnomalies?.filter((a) => a.promotedFindingId === undefined)).toHaveLength(1);
    expect(ledger.reviewerAnomalies?.[0]?.kind).toBe('quote-mismatch');
  });

  it('fail-closed: returnValue 終端（return: ...）で完了しようとしても、未昇格 anomaly が残る限り completion gate が拒否して abort する（codex 検証2巡目#1: gate を迂回する完了経路を塞ぐ）', async () => {
    mockReviewerEmitsHallucination();

    // reviewers の rule が next ではなく return（returnValue 終端）で完了しようと
    // する。かつては returnValue 終端が checkCompletionGate を呼ばず直接 completed に
    // していたため、この配線で anomaly を残したまま「成功終了」できた。
    const config: WorkflowConfig = {
      name: 'review-integrity-returnvalue',
      maxSteps: 4,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        reviewerStep([makeRule(
          'when(findings.open.count == 0 && findings.conflicts.count == 0)',
          '',
          { returnValue: 'done' },
        )]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // returnValue 終端でも gate を通り、completed にならず abort する。
    expect(result.status).toBe('aborted');
    expect(result.returnValue).toBeUndefined();
    expect(abortReason).toContain('reviewer anomaly');
  });

  it('merge-readiness child の need_replan は親の replan → implement → reviewers へ進み write_tests を通らない', async () => {
    mockReviewerEmitsHallucination();

    const childConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-child',
      subworkflow: {
        callable: true,
        requiresFindingContract: true,
        returns: ['need_replan'],
      },
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      steps: [
        reviewerStep([makeRule(
          'when(findings.reviewerAnomalies.count > 0)',
          '',
          { returnValue: 'need_replan' },
        )]),
      ],
    };
    const parentConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-parent',
      maxSteps: 6,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        {
          name: 'final-gate',
          kind: 'workflow_call',
          call: childConfig.name,
          personaDisplayName: 'final-gate',
          instruction: '',
          passPreviousResponse: true,
          rules: [makeRule('need_replan', 'replan')],
        },
        makeStep({
          name: 'replan',
          tags: ['plan'],
          persona: 'planner',
          instruction: 'Redefine the implementation approach without changing requirements.',
          rules: [makeRule('when(true)', 'implement')],
        }),
        makeStep({
          name: 'implement',
          persona: 'coder',
          instruction: 'Implement the revised approach.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
        makeStep({
          name: 'reviewers',
          persona: 'reviewer-after-replan',
          instruction: 'Review the revised implementation.',
          rules: [makeRule('when(true)', 'ABORT')],
        }),
      ],
    };

    const engine = new WorkflowEngine(parentConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      workflowCallResolver: () => childConfig,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });

    const result = await engine.run();

    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('Workflow aborted by step transition');
    const personas = vi.mocked(runAgent).mock.calls.map(([persona]) => persona);
    expect(personas).toEqual(expect.arrayContaining(['planner', 'coder', 'reviewer-after-replan']));
    expect(personas).not.toContain('test-writer');
  });

  it('Gemma anomaly と sticky な budgetExhausted があっても、二段 APPROVE が開始時 evidence を ack して COMPLETE する', async () => {
    seedReviewerAnomalyLedger(cwd);
    mockCleanApprovals();
    const childConfig = createAttestedFinalGateChild(cwd);
    const config: WorkflowConfig = {
      name: 'attested-parent',
      maxSteps: 8,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [createAttestedCallStep('final-gate', 'COMPLETE')],
    };
    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      workflowCallResolver: () => childConfig,
    });

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(result.findings?.reviewerAnomalies).toMatchObject({
      count: 1,
      outstanding: 0,
      acknowledged: 1,
      budgetExhausted: true,
    });
    const ledger = JSON.parse(readFileSync(
      join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json'),
      'utf-8',
    )) as FindingLedger;
    expect(ledger.reviewerAnomalies).toHaveLength(1);
    expect(ledger.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(ledger.reviewerAnomalyAcknowledgements?.[0]?.approvals.map((approval) => approval.stepName))
      .toEqual(['merge-readiness-review', 'supervise']);
  });

  it('ack 保存後・親 workflow_call 完了記録前の direct resume は新 run でも同一 invocation replay になる', async () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: ja\n');
    seedReviewerAnomalyLedger(cwd);
    mockCleanApprovals();
    const childConfig = createAttestedFinalGateChild(cwd);
    const config: WorkflowConfig = {
      name: 'attested-parent',
      maxSteps: 8,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [{
        ...createAttestedCallStep('final-gate', 'COMPLETE'),
        call: childConfig.name,
      }],
    };
    const reportDirName = 'test-report-dir-crash-replay';
    const firstEngine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName,
      workflowCallResolver: () => childConfig,
    });
    let acknowledgementPersistenceObserved = false;
    let parentResponseRecordedAtCrash: boolean | undefined;
    let resumePointAtCrash: WorkflowResumePoint | undefined;
    firstEngine.on('findings:ledger', (ledger: FindingLedger) => {
      if ((ledger.reviewerAnomalyAcknowledgements?.length ?? 0) > 0) {
        acknowledgementPersistenceObserved = true;
        parentResponseRecordedAtCrash = firstEngine.getState().stepOutputs.has('final-gate');
        resumePointAtCrash = firstEngine.getResumePoint();
        throw new Error('simulated crash immediately after acknowledgement persistence');
      }
    });

    const crashed = await firstEngine.run();
    const ledgerPath = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
    const ledgerAfterCrash = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as FindingLedger;
    const acknowledgementAfterCrash = ledgerAfterCrash.reviewerAnomalyAcknowledgements?.[0];
    const resumePoint = resumePointAtCrash;

    expect(crashed.status).toBe('aborted');
    expect(acknowledgementPersistenceObserved).toBe(true);
    expect(ledgerAfterCrash.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(parentResponseRecordedAtCrash).toBe(false);
    expect(resumePoint).toBeDefined();
    expect(resumePoint?.stack.map((entry) => entry.step)).toEqual([
      'final-gate',
      'supervise',
    ]);
    expect(resumePoint?.stack[0]?.step_iterations?.['final-gate']).toBe(1);
    if (acknowledgementAfterCrash === undefined || resumePoint === undefined) {
      throw new Error('Expected persisted acknowledgement and engine resume point after crash');
    }
    const startStep = resumePoint.stack[0]?.step;
    if (startStep === undefined) {
      throw new Error('Expected root workflow step in engine resume point');
    }
    const invocationBeforeResume = acknowledgementAfterCrash.gate.invocationId;
    const runIdBeforeResume = acknowledgementAfterCrash.gate.startedAt.runId;
    expect(invocationBeforeResume).toBe(`${reportDirName}:final-gate#1`);
    expect(runIdBeforeResume).toBe(reportDirName);

    const resumedReportDirName = 'test-report-dir-crash-replay-resumed';
    const resumed = await executeWorkflow(config, 'task', cwd, {
      projectCwd: cwd,
      provider: 'claude',
      outputMode: 'silent',
      reportDirName: resumedReportDirName,
      startStep,
      resumePoint,
      resumeSource: {
        sourceRunSlug: reportDirName,
        resumeMode: 'retry',
      },
      initialIterationOverride: resumePoint.iteration,
    });
    const ledgerAfterResume = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as FindingLedger;
    const acknowledgementAfterResume = ledgerAfterResume.reviewerAnomalyAcknowledgements?.[0];

    expect(resumed.reason).toBeUndefined();
    expect(resumed).toMatchObject({ success: true });
    expect(resumedReportDirName).not.toBe(reportDirName);
    expect(resumed.runDirectory).toBe(join(cwd, '.takt', 'runs', resumedReportDirName));
    expect(ledgerAfterResume.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(acknowledgementAfterResume).toEqual(acknowledgementAfterCrash);
    expect(acknowledgementAfterResume?.gate.invocationId).toBe(invocationBeforeResume);
    expect(acknowledgementAfterResume?.gate.startedAt.runId).toBe(runIdBeforeResume);
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)).toEqual([
      'merge-readiness-reviewer',
      'supervisor',
      'merge-readiness-reviewer',
      'supervisor',
    ]);
  });

  it.each([
    {
      interruption: 'A承認後・B開始前',
      iteration: 2,
      childStepIterations: { 'merge-readiness-review': 1 },
      expectedResumedStepIterations: [2, 1],
    },
    {
      interruption: 'B承認後・ack保存前',
      iteration: 3,
      childStepIterations: { 'merge-readiness-review': 1, supervise: 1 },
      expectedResumedStepIterations: [2, 2],
    },
  ])('$interruption の resume はAへ巻き戻し、同じ final gate をA→Bで再承認してack・COMPLETEする', async ({
    iteration,
    childStepIterations,
    expectedResumedStepIterations,
  }) => {
    seedReviewerAnomalyLedger(cwd);
    mockCleanApprovals();
    const childConfig = createAttestedFinalGateChild(cwd);
    const config: WorkflowConfig = {
      name: 'attested-parent',
      maxSteps: 10,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [createAttestedCallStep('final-gate', 'COMPLETE')],
    };
    const resumePoint: WorkflowResumePoint = {
      version: 1,
      stack: [
        buildWorkflowResumePointEntry(
          config,
          'final-gate',
          'workflow_call',
          new Map([['final-gate', 1]]),
        ),
        buildWorkflowResumePointEntry(
          childConfig,
          'supervise',
          'agent',
          new Map(Object.entries(childStepIterations)),
        ),
      ],
      iteration,
      elapsed_ms: 1_000,
    };
    const resumedSteps: Array<{ name: string; stepIteration: number }> = [];
    const workflowCallContinuation = resolveWorkflowCallContinuation({
      workflow: config,
      resumePoint,
      invocationRunId: 'source-run',
      resolveWorkflowCall: () => childConfig,
    });
    expect(workflowCallContinuation).toBeDefined();
    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: `test-report-dir-resume-${iteration}`,
      workflowCallResolver: () => childConfig,
      startStep: 'final-gate',
      resumePoint,
      workflowCallContinuation,
      initialIteration: resumePoint.iteration,
    });
    engine.on('step:start', (
      step,
      _activeIteration,
      _instruction,
      _providerInfo,
      workflowName,
      _resumeStepName,
      stepIteration,
    ) => {
      if (workflowName === childConfig.name) {
        resumedSteps.push({ name: step.name, stepIteration });
      }
    });

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(resumedSteps).toEqual([
      {
        name: 'merge-readiness-review',
        stepIteration: expectedResumedStepIterations[0],
      },
      {
        name: 'supervise',
        stepIteration: expectedResumedStepIterations[1],
      },
    ]);
    const ledger = JSON.parse(readFileSync(
      join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json'),
      'utf-8',
    )) as FindingLedger;
    expect(ledger.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(ledger.reviewerAnomalyAcknowledgements?.[0]?.approvals.map((approval) => approval.stepName))
      .toEqual(['merge-readiness-review', 'supervise']);
  });

  it('capability 付き builtin でも authenticated workflow_call invocation 無しでは ack できない', async () => {
    seedReviewerAnomalyLedger(cwd);
    mockCleanApprovals();
    const childConfig = createAttestedFinalGateChild(cwd);
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    };
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
      workflowName: 'attested-parent',
      ledgerPath: contract.ledgerPath,
      rawFindingsPath: contract.rawFindingsPath,
    });
    const engine = new WorkflowEngine(childConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      inheritedFindingContract: { contract, ledgerStore },
    });

    const result = await engine.run();

    expect(result.status).toBe('aborted');
    expect(ledgerStore.loadLedger().reviewerAnomalyAcknowledgements).toBeUndefined();
  });

  it('plain spread で capability を失った attestation config は direct Engine で拒否する', () => {
    seedReviewerAnomalyLedger(cwd);
    const loaded = createAttestedFinalGateChild(cwd);
    const plainConfig = { ...loaded };
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    };
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
      workflowName: 'attested-parent',
      ledgerPath: contract.ledgerPath,
      rawFindingsPath: contract.rawFindingsPath,
    });

    expect(() => new WorkflowEngine(plainConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      inheritedFindingContract: { contract, ledgerStore },
    })).toThrow(/not authorized by the workflow resolver/);
  });

  it('同一 identity の attestation config を発行後に変更すると direct Engine で拒否する', () => {
    seedReviewerAnomalyLedger(cwd);
    const loaded = createAttestedFinalGateChild(cwd);
    loaded.steps[0]!.instruction = 'Mutated approval instruction';
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    };
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
      workflowName: 'attested-parent',
      ledgerPath: contract.ledgerPath,
      rawFindingsPath: contract.rawFindingsPath,
    });

    expect(() => new WorkflowEngine(loaded, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      inheritedFindingContract: { contract, ledgerStore },
    })).toThrow(/workflow content changed after issuance/);
  });

  it('localllm 相当の inner gate 後に boundary へ進み、boundary の新 anomaly を final gate で再評価する', async () => {
    seedReviewerAnomalyLedger(cwd);
    const boundaryRaw = {
      ...HALLUCINATED_RAW,
      rawFindingId: 'boundary-1',
      title: 'Boundary-only anomaly',
      location: 'src/boundary-does-not-exist.ts:7',
    };
    mockCleanApprovals({ 'boundary-reviewer': boundaryRaw });
    const childConfig = createAttestedFinalGateChild(cwd);
    const config: WorkflowConfig = {
      name: 'attested-parent',
      maxSteps: 16,
      initialStep: 'local-review-integrity-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        createAttestedCallStep('local-review-integrity-gate', 'boundary-reviewers'),
        makeStep({
          name: 'boundary-reviewers',
          persona: 'boundary-reviewer',
          instruction: 'Review boundaries.',
          outputContracts: [{
            name: 'boundary-review.md',
            format: 'boundary review',
            formatRef: 'failure-boundary-review-finding-contract',
          }],
          rules: [makeRule(
            'approved && when(findings.open.count == 0 && findings.provisional.count == 0 && findings.conflicts.count == 0)',
            'final-gate',
          )],
        }),
        createAttestedCallStep('final-gate', 'COMPLETE'),
      ],
    };
    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      workflowCallResolver: () => childConfig,
    });

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)).toContain('boundary-reviewer');
    const ledger = JSON.parse(readFileSync(
      join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json'),
      'utf-8',
    )) as FindingLedger;
    expect(ledger.reviewerAnomalies).toHaveLength(2);
    expect(ledger.reviewerAnomalyAcknowledgements).toHaveLength(2);
  });

  it('gate 内で新たに生成された anomaly があれば開始時分も ack せず、次の gate で全件を再承認する', async () => {
    seedReviewerAnomalyLedger(cwd);
    const gateRaw = {
      ...HALLUCINATED_RAW,
      rawFindingId: 'gate-1',
      title: 'Anomaly created by the supervisor gate',
      location: 'src/gate-does-not-exist.ts:9',
    };
    mockCleanApprovals({ supervisor: gateRaw });
    const childConfig = createAttestedFinalGateChild(cwd);
    const config: WorkflowConfig = {
      name: 'attested-parent',
      maxSteps: 8,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [createAttestedCallStep('final-gate', 'COMPLETE')],
    };
    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      workflowCallResolver: () => childConfig,
    });

    const result = await engine.run();

    expect(result.status).toBe('aborted');
    const ledgerPath = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
    const ledger = JSON.parse(readFileSync(
      ledgerPath,
      'utf-8',
    )) as FindingLedger;
    expect(ledger.reviewerAnomalies).toHaveLength(2);
    expect(ledger.reviewerAnomalyAcknowledgements ?? []).toHaveLength(0);
    const newAnomaly = ledger.reviewerAnomalies?.find((anomaly) => anomaly.title === gateRaw.title);
    expect(newAnomaly).toBeDefined();

    mockCleanApprovals();
    const retryEngine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir-retry',
      workflowCallResolver: () => childConfig,
    });
    const retryResult = await retryEngine.run();
    const retriedLedger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as FindingLedger;

    expect(retryResult.status).toBe('completed');
    expect(retriedLedger.reviewerAnomalyAcknowledgements).toHaveLength(2);
  });

  it('final-gate supervisor は2つのFinding Contract報告を出しても、ステップごとに1回だけ取り込み、raw findingを重複保存しない', async () => {
    mockReviewerEmitsHallucination();
    const config: WorkflowConfig = {
      name: 'supervisor-two-reports',
      maxSteps: 4,
      initialStep: 'supervise',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        makeStep({
          name: 'supervise',
          persona: 'supervisor',
          instruction: 'Supervise the final gate.',
          outputContracts: [
            { name: 'supervisor-validation.md', format: 'validation', formatRef: 'supervisor-validation-finding-contract' },
            { name: 'supervisor-gate-summary.md', format: 'summary', formatRef: 'supervisor-gate-summary-finding-contract' },
          ],
          rules: [makeRule('approved', 'COMPLETE')],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    await engine.run();

    expect(ingestFindingContractResultsMock).toHaveBeenCalledOnce();
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"rawFindings"')
    ));
    expect(reviewerCalls).toHaveLength(1);

    const rawFindingsDir = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'raw');
    const rawFindingFiles = readdirSync(rawFindingsDir);
    expect(rawFindingFiles).toHaveLength(1);
    const rawFindings = JSON.parse(readFileSync(join(rawFindingsDir, rawFindingFiles[0]), 'utf-8')) as Array<{ rawFindingId: string }>;
    expect(rawFindings).toHaveLength(1);
    expect(new Set(rawFindings.map((finding) => finding.rawFindingId)).size).toBe(rawFindings.length);
  });
});
