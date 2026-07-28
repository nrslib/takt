import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerStore, RawFinding } from '../core/workflow/findings/types.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { createFindingLedgerStore, type FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { createFindingAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { computeRoundMarker } from '../core/workflow/findings/round-marker.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import {
  createFindingManagerPublicationDouble,
  observeFindingLedgerMutations,
  RevisionedFindingLedgerTestRepository,
} from './helpers/finding-manager-publication.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

// raw admission validation（manager-runner.ts の cwd 引数）が実 fs を見るため、
// このテストファイルが使う location（src/a.ts:10/11, src/b.ts:5/20, src/c.ts:1,
// src/dup.ts:10）に対応する実ファイルを1つの共有 fixture ディレクトリへ用意する。
const TEST_TMPDIR = realpathSync(tmpdir());
const FIXTURE_CWD = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-runner-fixtures-'));
const REPORT_DIR = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-runner-reports-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/a.ts', 30);
writeFixtureFile('src/b.ts', 30);
writeFixtureFile('src/c.ts', 5);
writeFixtureFile('src/dup.ts', 20);
initializeGitFixture(FIXTURE_CWD, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/dup.ts']);

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
  rmSync(REPORT_DIR, { recursive: true, force: true });
});

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [
      {
        rawFindingId: 'raw-existing',
        stepName: 'arch-review',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        description: 'Existing issue body.',
        relation: 'new',
      },
    ],
    conflicts: [],
    interpretations: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      },
    ],
    ...overrides,
  };
}

interface Harness {
  savedLedgers: FindingLedger[];
  savedRawFindings: RawFinding[][];
  savedValidationReports: FindingManagerValidationReport[];
  ledgerStore: FindingLedgerStore;
  currentLedger: () => FindingLedger;
  run: (input: {
    reviewerRawFindings: Array<Record<string, unknown>>;
    priorStepResponseText?: string;
  }) => ReturnType<typeof runFindingManagerForStep>;
}

function makeHarness(initialLedger: FindingLedger): Harness {
  // WAL（beginInterpretations / completeInterpretations）が保存を複数回
  // 行うため、テスト double も状態を持つ（mutator の結果を次回の読み込みに使う）。
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(initialLedger);
  const savedLedgers: FindingLedger[] = [];
  const savedRawFindings: RawFinding[][] = [];
  const savedValidationReports: FindingManagerValidationReport[] = [];
  const saveManagerValidationReport = (report: FindingManagerValidationReport): void => {
    savedValidationReports.push(report);
  };
  const publicationDouble = createFindingManagerPublicationDouble((report) => {
    savedValidationReports.push(report);
    return join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`);
  }, ledgerRepository);
  const observedMutations = observeFindingLedgerMutations(
    ledgerRepository,
    publicationDouble,
    (ledger) => {
      savedLedgers.push(ledger);
    },
  );
  const ledgerStore: FindingLedgerStore = {
    ledgerIdentity: '/test/finding-manager-mechanical-runner/harness-ledger.json',
    workflowName: 'peer-review',
    loadLedger: () => ledgerRepository.loadLedger(),
    ...createFindingAdjudicationReservation(),
    saveLedgerSnapshot: () => {},
    saveRawFindings: (_runId, _stepName, rawFindings) => {
      savedRawFindings.push(rawFindings);
    },
    saveManagerValidationReport,
    ...publicationDouble,
    ...observedMutations,
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    recordSynthesizedAgentUsage: () => {},
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    ledgerPath: '.takt/findings/ledger.json',
    rawFindingsPath: '.takt/findings/raw',
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
  };
  return {
    savedLedgers,
    savedRawFindings,
    savedValidationReports,
    ledgerStore,
    currentLedger: () => ledgerRepository.loadLedger(),
    run: (input) => runFindingManagerForStep({
      // テスト対象が使うメソッドだけを実装した最小 double。
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: input.reviewerRawFindings },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-2',
      // トップレベルの走行を模す（呼び出し名前空間なし）。既存 id の形は変わらない。
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
      priorStepResponseText: input.priorStepResponseText,
    }),
  };
}

const CONFIRMATION_RAW = {
  rawFindingId: 'c-1',
  familyTag: 'bug',
  severity: 'high',
  title: 'Confirmed fixed',
  description: 'Verified the fix at src/a.ts:10.',
  suggestion: '',
  relation: 'resolution_confirmation',
  targetFindingId: 'F-0001',
  ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
};

const UNMATCHED_ISSUE_RAW = {
  rawFindingId: 'i-1',
  familyTag: 'security',
  severity: 'medium',
  title: 'New unmatched issue',
  description: 'A different problem.',
  suggestion: 'Fix it.',
  relation: 'new',
  targetFindingId: '',
  ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 5),
};

const ANOTHER_UNMATCHED_ISSUE_RAW = {
  rawFindingId: 'i-2',
  familyTag: 'style',
  severity: 'low',
  title: 'Another unmatched issue',
  description: 'A separate different problem.',
  suggestion: 'Fix it too.',
  relation: 'new',
  targetFindingId: '',
  ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/c.ts', 1),
};

function runFindingManagerWithStore(input: {
  ledgerStore: FindingLedgerStore;
  cwd: string;
  runId: string;
  stepIteration: number;
  reviewerRawFindings: Array<Record<string, unknown>>;
}) {
  return runFindingManagerForStep({
    contract: {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    } as never,
    ledgerStore: input.ledgerStore,
    optionsBuilder: {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    } as never,
    stepExecutor: {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    } as never,
    cwd: input.cwd,
    parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
    stepIteration: input.stepIteration,
    subResults: [{
      subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
      response: {
        status: 'done',
        content: '',
        structuredOutput: { rawFindings: input.reviewerRawFindings },
      } as unknown as AgentResponse,
    }],
    workflowName: 'peer-review',
    runId: input.runId,
    callNamespace: '',
    timestamp: '2026-06-14T00:00:00.000Z',
  });
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

describe('runFindingManagerForStep mechanical path', () => {
  it('Given the round marker is already applied When the same invocation is replayed Then the runner is a complete no-op before agent, WAL, raw artifacts, and reports', async () => {
    const roundMarker = computeRoundMarker({
      runId: 'run-2',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
    });
    const initialLedger = makeLedger({
      stopBudget: {
        roundMarkers: [roundMarker],
        firstRoundAt: '2026-06-14T00:00:00.000Z',
        exhausted: false,
      },
    });
    const snapshot = structuredClone(initialLedger);
    const harness = makeHarness(initialLedger);

    const result = await harness.run({
      reviewerRawFindings: [{
        ...UNMATCHED_ISSUE_RAW,
        relation: 'persists',
      }],
    });

    expect(result.status).toBe('unchanged');
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(harness.savedLedgers).toEqual([]);
    expect(harness.savedRawFindings).toEqual([]);
    expect(harness.savedValidationReports).toEqual([]);
    expect(result.ledger).toEqual(snapshot);
  });

  it('Given the same invocation races with itself When both enter the runner Then only the first applies and the second observes its marker under the same exclusion', async () => {
    const harness = makeHarness(makeLedger());

    const results = await Promise.all([
      harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] }),
      harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['unchanged', 'updated']);
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(harness.savedLedgers).toHaveLength(1);
    expect(harness.savedRawFindings).toHaveLength(1);
    expect(harness.savedValidationReports).toEqual([]);
  });

  it('Given report publication fails after the ledger mutation When the same invocation is retried Then only the pending report is published before the completed marker is finalized', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [{
          rawFindingId: 'run-2:reviewers:2:arch-review:i-1',
          decision: 'new',
          evidence: 'No related open finding.',
        }],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);
    const harness = makeHarness(makeLedger());
    const publishReport = harness.ledgerStore.publishManagerValidationPublication;
    const reportSpy = vi.spyOn(harness.ledgerStore, 'publishManagerValidationPublication')
      .mockImplementationOnce(() => {
        throw new Error('injected manager report publication failure');
      })
      .mockImplementation(publishReport);
    const invalidQuoteRaw = {
      ...ANOTHER_UNMATCHED_ISSUE_RAW,
      rawFindingId: 'quote-mismatch',
      verbatimExcerpt: 'not the current source line',
    };
    const input = {
      reviewerRawFindings: [UNMATCHED_ISSUE_RAW, invalidQuoteRaw],
    };
    const roundMarker = computeRoundMarker({
      runId: 'run-2',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
    });

    await expect(harness.run(input)).rejects.toThrow('injected manager report publication failure');

    expect(harness.currentLedger().stopBudget?.roundMarkers ?? []).not.toContain(roundMarker);
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(harness.savedRawFindings).toHaveLength(1);

    const retried = await harness.run(input);

    expect(retried.status).toBe('unchanged');
    expect(reportSpy).toHaveBeenCalledTimes(2);
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(harness.savedRawFindings).toHaveLength(1);
    expect(harness.currentLedger().stopBudget?.roundMarkers).toEqual([roundMarker]);
    expect(harness.currentLedger().findings.filter(
      (finding) => finding.title === UNMATCHED_ISSUE_RAW.title,
    )).toHaveLength(1);
  });

  it('Given separate stores bind the same canonical ledger When the same round races Then only one reaches agent and artifacts', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-round-identity-project-'));
    const reportDirA = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-round-identity-report-a-'));
    const reportDirB = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-round-identity-report-b-'));
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    initializeGitFixture(projectCwd, ['src/b.ts']);

    const createStore = (reportDir: string) => createFindingLedgerStore({
      projectCwd,
      runId: 'shared-run',
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    const storeA = createStore(reportDirA);
    const storeB = createStore(reportDirB);
    await storeA.updateLedger(() => ({
      ledger: {
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      result: undefined,
    }));
    const copySpies = [vi.spyOn(storeA, 'saveLedgerSnapshot'), vi.spyOn(storeB, 'saveLedgerSnapshot')];
    const rawSpies = [vi.spyOn(storeA, 'saveRawFindings'), vi.spyOn(storeB, 'saveRawFindings')];
    const reportSpies = [
      vi.spyOn(storeA, 'saveManagerValidationReport'),
      vi.spyOn(storeB, 'saveManagerValidationReport'),
    ];
    executeAgentMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{
            rawFindingId: 'shared-run:reviewers:1:arch-review:i-1',
            decision: 'new',
            evidence: 'No related open finding.',
          }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });
    const run = (ledgerStore: FindingLedgerStore) => runFindingManagerWithStore({
      ledgerStore,
      cwd: projectCwd,
      runId: 'shared-run',
      stepIteration: 1,
      reviewerRawFindings: [{
        ...UNMATCHED_ISSUE_RAW,
        ...verifiedSourceQuoteFields(projectCwd, 'src/b.ts', 5),
      }],
    });

    try {
      const results = await Promise.all([run(storeA), run(storeB)]);

      expect(results.map((result) => result.status).sort()).toEqual(['unchanged', 'updated']);
      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      expect(copySpies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
      expect(rawSpies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
      expect(reportSpies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(0);
      expect(storeA.loadLedger().interpretations).toEqual([]);
      expect(storeA.loadLedger().rawFindings).toHaveLength(1);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDirA, { recursive: true, force: true });
      rmSync(reportDirB, { recursive: true, force: true });
    }
  });

  it('Given a persisted pending report When resume uses a new run id Then it drains the old transaction and completes the new round in the same invocation', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-pending-project-'));
    const reportDirA = join(projectCwd, '.takt', 'runs', 'pending-run', 'reports');
    mkdirSync(reportDirA, { recursive: true });
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/b.ts'), '// line 1\n// line 2\n// line 3\n// line 4\n// line 5\n');
    writeFileSync(join(projectCwd, 'src/c.ts'), '// line 1\n');
    initializeGitFixture(projectCwd, ['src/b.ts', 'src/c.ts']);
    const createStore = (
      runId: string,
      reportDir: string,
      trustedResumeSourceRunId?: string,
    ) => createFindingLedgerStore({
      projectCwd,
      runId,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      ...(trustedResumeSourceRunId === undefined ? {} : { trustedResumeSourceRunId }),
    });
    const storeA = createStore('pending-run', reportDirA);
    await storeA.updateLedger(() => ({
      ledger: {
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      result: undefined,
    }));
    const reportSpyA = vi.spyOn(storeA, 'publishManagerValidationPublication')
      .mockImplementationOnce(() => {
        throw new Error('injected persisted report failure');
      });
    const reviewerRawFindings = [
      {
        ...UNMATCHED_ISSUE_RAW,
        ...verifiedSourceQuoteFields(projectCwd, 'src/b.ts', 5),
      },
      {
        ...ANOTHER_UNMATCHED_ISSUE_RAW,
        rawFindingId: 'quote-mismatch',
        ...verifiedSourceQuoteFields(projectCwd, 'src/c.ts', 1),
        verbatimExcerpt: 'not the current source line',
      },
    ];
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [{
          rawFindingId: 'pending-run:reviewers:1:arch-review:i-1',
          decision: 'new',
          evidence: 'No related open finding.',
        }],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    try {
      await expect(runFindingManagerWithStore({
        ledgerStore: storeA,
        cwd: projectCwd,
        runId: 'pending-run',
        stepIteration: 1,
        reviewerRawFindings,
      })).rejects.toThrow('injected persisted report failure');
      inheritResumeReportSnapshot({
        cwd: projectCwd,
        sourceRunSlug: 'pending-run',
        targetRunSlug: 'different-run',
      });
      const reportDirB = join(projectCwd, '.takt', 'runs', 'different-run', 'reports');
      const storeB = createStore(
        'different-run',
        reportDirB,
        'pending-run',
      );
      const copySpyB = vi.spyOn(storeB, 'saveLedgerSnapshot');
      const rawSpyB = vi.spyOn(storeB, 'saveRawFindings');
      const reportSpyB = vi.spyOn(storeB, 'publishManagerValidationPublication');
      expect(storeB.loadLedger().pendingManagerCommit?.roundMarker).toBe(
        computeRoundMarker({
          runId: 'pending-run',
          callNamespace: '',
          parentStepName: 'reviewers',
          stepIteration: 1,
        }),
      );

      const resumed = await runFindingManagerWithStore({
        ledgerStore: storeB,
        cwd: projectCwd,
        runId: 'different-run',
        stepIteration: 1,
        reviewerRawFindings: [{
          ...CONFIRMATION_RAW,
          ...verifiedSourceQuoteFields(projectCwd, 'src/b.ts', 5),
          targetFindingId: 'F-0001',
        }],
      });

      expect(resumed.status).toBe('updated');
      expect(storeB.loadLedger().pendingManagerCommit).toBeUndefined();
      expect(storeB.loadLedger().stopBudget?.roundMarkers).toHaveLength(2);
      expect(storeB.loadLedger().findings.find(
        (finding) => finding.title === UNMATCHED_ISSUE_RAW.title,
      )?.status).toBe('resolved');
      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      expect(copySpyB).toHaveBeenCalledTimes(1);
      expect(rawSpyB).toHaveBeenCalledTimes(1);
      expect(reportSpyA).toHaveBeenCalledTimes(1);
      expect(reportSpyB).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('Given only mechanically classifiable confirmations and no prior response When run Then the manager agent is not called and the ledger is updated', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('updated');
    const finding = harness.currentLedger().findings.find((entry) => entry.id === 'F-0001');
    expect(finding?.status).toBe('resolved');
  });

  it('Given a residual raw finding When run Then the agent is called with only the residual raws and outputs are merged', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW, UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;
    expect(instruction).toContain('classified mechanically');
    expect(instruction).toContain('i-1');
    expect(instruction).not.toContain('"run-2:reviewers:2:arch-review:c-1"');

    expect(result.status).toBe('updated');
    const ledger = harness.currentLedger();
    expect(ledger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    expect(ledger?.findings.some((entry) => entry.title === 'New unmatched issue' && entry.status === 'open')).toBe(true);
  });

  it('Given zero residual and a prior response without a Disputed Findings heading When run Then the agent is skipped', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [CONFIRMATION_RAW],
      priorStepResponseText: 'F-0001 を修正しました。全テスト green です。',
    });

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('updated');
  });

  it('Given zero residual but a prior step response When run Then the agent is still called for waiver adjudication', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [CONFIRMATION_RAW],
      priorStepResponseText: '## Disputed Findings\n- findingId: F-0001\n  reason: stale\n  evidence: src/a.ts:10',
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('updated');
  });
});

describe('runFindingManagerForStep rejected decisions land as provisional without retry', () => {
  it('Given one rejected decision among several When run Then the manager is NOT re-asked; the accepted decision applies and the rejected raw lands as a gate-blocking provisional', async () => {
    // semantic retry は 0 回。i-1 は妥当な "new"（採用）、i-2 は存在しない
    // finding への "same"（不採用 → provisional 着地。new への強制も drop もしない）。
    executeAgentMock.mockResolvedValueOnce({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-2', decision: 'same', findingId: 'F-9999', evidence: 'x' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW, ANOTHER_UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);

    expect(result.status).toBe('updated');
    const ledger = harness.currentLedger();
    const accepted = ledger?.findings.find((entry) => entry.title === 'New unmatched issue');
    expect(accepted?.status).toBe('open');
    expect(accepted?.provisional).toBeUndefined();
    const rejected = ledger?.findings.find((entry) => entry.title === 'Another unmatched issue');
    expect(rejected?.status).toBe('open');
    expect(rejected?.provisional).toMatchObject({ kind: 'raw-adjudication-unresolved', gateEffect: 'block' });
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
    expect(harness.savedValidationReports[0]?.provisionalLandings?.some(
      (landing) => landing.sourceRawFindingIds.includes('run-2:reviewers:2:arch-review:i-2'),
    )).toBe(true);
  });

  it('Given a confirmation whose target is already resolved When run Then it is tainted and, per A-1, lands as audit-only (no provisional, no ladder call, target unchanged)', async () => {
    // 対象が open でない confirmation は ambiguous（confirmation-target-not-open）
    // として taint される。tainted confirmation は capability 格子上 resolve 権限を
    // 持たず、provisional 化は「解消確認」を blocker に変換する誤着地（実台帳
    // F-0015/16/17）— A-1 により admission の成否にかかわらず ladder に載せず、
    // 解消証拠として不採用（監査保存のみ）とする。
    const ledger = makeLedger({ findings: [{ ...makeLedger().findings[0]!, status: 'resolved', lifecycle: 'resolved' }] });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    // decisions manager も解釈フェーズも呼ばれない。
    expect(executeAgentMock).not.toHaveBeenCalled();

    expect(result.status).toBe('updated');
    const savedLedger = harness.currentLedger();
    expect(savedLedger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    expect(savedLedger?.findings.every((entry) => entry.provisional === undefined)).toBe(true);
    // 監査には不採用の事実が残る。
    const report = harness.savedValidationReports.at(-1) as FindingManagerValidationReport | undefined;
    expect(report?.unsupportedRawFindings?.some((entry) => entry.rawFindingId.endsWith(':c-1'))).toBe(true);
    expect(report?.rawFindingDispositions).toEqual([
      expect.objectContaining({
        rawFindingId: expect.stringMatching(/:c-1$/),
        outcome: 'unsupported',
        reason: expect.any(String),
      }),
    ]);
  });

  it('Given the agent repeats an invalid decision When run Then the raw finding lands as provisional (never forced to "new")', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'same', findingId: 'F-9999', evidence: 'x' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('updated');
    const ledger = harness.currentLedger();
    const landed = ledger?.findings.find((entry) => entry.title === 'New unmatched issue');
    expect(landed?.status).toBe('open');
    expect(landed?.provisional).toMatchObject({ kind: 'raw-adjudication-unresolved' });
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
  });

  it('Given the manager omits decisions for every residual raw finding When run Then nothing is silently dropped: the issue raw lands as a gate-blocking provisional and the tainted confirmation is audit-only', async () => {
    // decisions manager が rawDecisions: [] を返す（no-op gate bypass 攻撃の
    // 基本形）。欠落 decision の issue raw は provisional へ。対象が
    // resolved の confirmation は tainted confirmation として A-1 の対象になり、
    // provisional にはならず監査保存のみ（解消確認は問題の観測ではない）。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({ findings: [{ ...makeLedger().findings[0]!, status: 'resolved', lifecycle: 'resolved' }] });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW, CONFIRMATION_RAW] });

    // clean residual（i-1）用の decisions call の1回のみ（c-1 は ladder に載らない）。
    expect(executeAgentMock).toHaveBeenCalledTimes(1);

    expect(result.status).toBe('updated');
    const savedLedger = harness.currentLedger();
    expect(savedLedger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    const provisionals = savedLedger?.findings.filter((entry) => entry.provisional !== undefined) ?? [];
    expect(provisionals).toHaveLength(1);
    expect(provisionals[0]?.title).toBe('New unmatched issue');
    const report = harness.savedValidationReports.at(-1) as FindingManagerValidationReport | undefined;
    expect(report?.unsupportedRawFindings?.some((entry) => entry.rawFindingId.endsWith(':c-1'))).toBe(true);
    expect(report?.rawFindingDispositions).toContainEqual(expect.objectContaining({
      rawFindingId: expect.stringMatching(/:c-1$/),
      outcome: 'unsupported',
      reason: expect.any(String),
    }));
  });

  it('Given a resolved-target confirmation and a manager that incorrectly returns new for it When run Then the confirmation remains an unsupported finite audit outcome', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          {
            rawFindingId: 'run-2:reviewers:2:arch-review:c-1',
            decision: 'new',
            evidence: 'Incorrectly attempted to create from a confirmation.',
          },
          {
            rawFindingId: 'run-2:reviewers:2:arch-review:i-1',
            decision: 'new',
            evidence: 'No related open finding.',
          },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);
    const resolved = makeLedger({
      findings: [{
        ...makeLedger().findings[0]!,
        status: 'resolved',
        lifecycle: 'resolved',
      }],
    });
    const harness = makeHarness(resolved);

    await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW, CONFIRMATION_RAW] });

    const report = harness.savedValidationReports.at(-1);
    expect(report?.rawFindingDispositions).toContainEqual(expect.objectContaining({
      rawFindingId: 'run-2:reviewers:2:arch-review:c-1',
      outcome: 'unsupported',
      reason: expect.stringContaining('cannot serve as resolution evidence'),
    }));
    expect(harness.currentLedger().findings.filter(
      (finding) => finding.rawFindingIds.includes('run-2:reviewers:2:arch-review:c-1'),
    )).toEqual([]);
  });
});

describe('runFindingManagerForStep conflict handling', () => {
  it('Given an active conflict in the ledger When all raws are mechanical Then the agent is still called', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [{ conflictId: 'C-FA2947446963', decision: 'keep', evidence: 'Still unresolved.' }],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({
      conflicts: [
        {
          id: 'C-FA2947446963',
          status: 'active',
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-existing'],
          description: 'Reviewers disagree about F-0001.',
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
    });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('updated');
  });

  it('Given an active conflict referencing a resolved finding When the agent is called Then that finding keeps full detail in the instruction', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [{ conflictId: 'C-FA2947446963', decision: 'keep', evidence: 'Still unresolved.' }],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({
      findings: [
        {
          id: 'F-0001',
          status: 'resolved',
          lifecycle: 'resolved',
          revision: 1,
          severity: 'high',
          title: 'Existing issue',
          location: 'src/a.ts:10',
          description: 'Original detailed description of the conflicted finding.',
          reviewers: ['arch-review'],
          rawFindingIds: ['raw-existing'],
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
      conflicts: [
        {
          id: 'C-FA2947446963',
          status: 'active',
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-existing'],
          description: 'Reviewers disagree about F-0001.',
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
    });
    const harness = makeHarness(ledger);
    await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW] });

    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;
    expect(instruction).toContain('Original detailed description of the conflicted finding.');
  });
});

describe('runFindingManagerForStep workflow_call sub-steps', () => {
  it('Given a workflow_call sub-step mixed into a parallel step When run Then it is excluded from raw findings extraction instead of erroring', async () => {
    // workflow_call のサブステップは AgentResponse.structuredOutput を持たない
    // （子ワークフロー側が自分の finding_contract で台帳へ取り込み済みという
    // 想定）。除外しないと「structured output が無い」という欠落と区別できず
    // fail-fast エラーになってしまう。現状の builtin workflow にこの構成は
    // 無いが、将来 parallel の子に workflow_call を混ぜても壊れないことを確認する。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-3:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const savedLedgers: FindingLedger[] = [];
    const savedRawFindings: RawFinding[][] = [];
    const ledgerRepository = new RevisionedFindingLedgerTestRepository(makeLedger());
    const publicationDouble = createFindingManagerPublicationDouble(
      (report) => join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`),
      ledgerRepository,
    );
    const observedMutations = observeFindingLedgerMutations(
      ledgerRepository,
      publicationDouble,
      (ledger) => {
        savedLedgers.push(ledger);
      },
    );
    const ledgerStore: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-manager-mechanical-runner/workflow-call-ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => ledgerRepository.loadLedger(),
      ...createFindingAdjudicationReservation(),
      saveLedgerSnapshot: () => {},
      saveRawFindings: (_runId, _stepName, rawFindings) => {
        savedRawFindings.push(rawFindings);
      },
      saveManagerValidationReport: () => {},
      ...publicationDouble,
      ...observedMutations,
    };
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };
    const workflowCallSubStep: WorkflowStep = {
      kind: 'workflow_call',
      name: 'child-delegate',
      call: 'child',
      personaDisplayName: 'child-delegate',
      instruction: '',
    } as WorkflowStep;

    const result = await runFindingManagerForStep({
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [UNMATCHED_ISSUE_RAW] },
          } as unknown as AgentResponse,
        },
        {
          // workflow_call のレスポンスは実運用でも structuredOutput を持たない
          // （WorkflowCallRunner.buildWorkflowCallResponse が返す形そのもの）。
          subStep: workflowCallSubStep,
          response: {
            persona: 'child-delegate',
            status: 'done',
            content: 'COMPLETE',
            timestamp: new Date('2026-06-14T00:00:00.000Z'),
          } as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-3',
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    expect(savedRawFindings).toHaveLength(1);
    expect(savedRawFindings[0]).toHaveLength(1);
    expect(savedRawFindings[0]?.[0]?.stepName).toBe('arch-review');
  });
});

describe('runFindingManagerForStep concurrent workflow_call lost update', () => {
  // codex の再現ケース: 並列 workflow_call の子エンジンが同じ store（親から
  // 継承した台帳）を共有すると、各子は「LLM 呼び出し前に読んだ台帳」を基準に
  // 非同期処理後に保存するため、後勝ちで一方の新規指摘が消える。
  // 台帳を実ファイルで共有する createFindingLedgerStore を使い、2つの
  // runFindingManagerForStep 呼び出しを Promise.all で同時実行して確認する。
  const cleanupDirs = new Set<string>();

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('Given two concurrent callers each reporting a distinct new issue When both resolve their LLM call around the same time Then neither new finding is lost', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-race-project-'));
    const reportDir = join(projectCwd, '.takt', 'runs', 'shared-run', 'reports');
    mkdirSync(reportDir, { recursive: true });
    cleanupDirs.add(projectCwd);
    // raw admission validation は projectCwd を cwd として使うため、この
    // テストが引用する location に対応する実ファイルを用意する。
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/a.ts'), `${Array.from({ length: 15 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 25 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    initializeGitFixture(projectCwd, ['src/a.ts', 'src/b.ts']);

    // workflow_call の並列子は親から継承した同一の FindingLedgerStore
    // インスタンスを共有する（WorkflowCallExecutor.ts の inheritedFindingContract
    // 参照）。ここでも1つの store インスタンスを両呼び出しで共有する。
    const store = createFindingLedgerStore({
      projectCwd,
      runId: 'shared-run',
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    const storeA = store;
    const storeB = store;
    await storeA.updateLedger(() => ({
      ledger: {
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      result: undefined,
    }));

    // workflow_call の並列子は WorkflowCallExecutor から同じ reportDirName
    // （= 親の runPaths.slug）を渡されるため、実運用では2子の runId は常に
    // 一致する。異なる runId を使うと衝突条件を再現しないため、ここでは
    // 両呼び出しに同じ runId を渡し、呼び出し名前空間（callNamespace）だけで
    // 区別する。
    const SHARED_RUN_ID = 'shared-run';
    const rawFindingIdA = `${SHARED_RUN_ID}:child-a:reviewers:1:arch-review:i-1`;
    const rawFindingIdB = `${SHARED_RUN_ID}:child-b:reviewers:1:arch-review:i-1`;
    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      const rawFindingId = instruction.includes(`${SHARED_RUN_ID}:child-a:`) ? rawFindingIdA : rawFindingIdB;
      // LLM 応答の返却前に一呼吸置き、2呼び出しの「読み込み → await → 保存」
      // が実際に重なるようにする。
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{ rawFindingId, decision: 'new', evidence: 'No related open finding.' }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    const runCall = (store: FindingLedgerStore, callNamespace: string, raw: Record<string, unknown>) => runFindingManagerForStep({
      contract: contract as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: projectCwd,
      parentStep,
      stepIteration: 1,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [raw] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: SHARED_RUN_ID,
      callNamespace,
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const [resultA, resultB] = await Promise.all([
      runCall(storeA, 'child-a', {
        rawFindingId: 'i-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Issue reported by child A',
        description: 'Reported by concurrent child A.',
        suggestion: '',
        relation: 'new',
        ...verifiedSourceQuoteFields(projectCwd, 'src/a.ts', 10),
      }),
      runCall(storeB, 'child-b', {
        rawFindingId: 'i-1',
        familyTag: 'security',
        severity: 'medium',
        title: 'Issue reported by child B',
        description: 'Reported by concurrent child B.',
        suggestion: '',
        relation: 'new',
        ...verifiedSourceQuoteFields(projectCwd, 'src/b.ts', 20),
      }),
    ]);

    expect(resultA.status).toBe('updated');
    expect(resultB.status).toBe('updated');

    const finalLedger = storeA.loadLedger();
    // 両方の新規指摘が反映されている（後勝ちで片方が消えていない）。
    expect(finalLedger.findings.some((f) => f.title === 'Issue reported by child A')).toBe(true);
    expect(finalLedger.findings.some((f) => f.title === 'Issue reported by child B')).toBe(true);
    // nextId の割り当ても衝突していない（2件とも別々の finding id を持つ）。
    const ids = new Set(finalLedger.findings.map((f) => f.id));
    expect(ids.size).toBe(finalLedger.findings.length);
  });

  it('Given two concurrent callers each deciding "new" for an IDENTICAL raw (same path, title and description) When both resolve their LLM call around the same time Then only one finding is created (no F-0001/F-0002 duplicate)', async () => {
    // codex の再現ケース本体: 上のテストは意図的に異なる path/title の
    // 2件を使っているため、この競合を検出しない。ここでは両方の子が内容の
    // 完全一致する raw（path + 正規化タイトル + description が同じ。familyTag と
    // 行番号は同一性の根拠にしない設計）を "new" と判断する状況を再現する。
    // 保存直前の再照合で、後から critical section に入った側は先に保存された
    // finding を台帳上で検出し、"new" ではなく "same" として畳み込まれるべき
    // （decision-assembly.ts の openFindingKeyIndex。鍵は path+title+description の
    // 完全一致 — path+title だけのリダイレクトは manager の new 判断を意味判断
    // なしで覆す禁止マージだった: codex ブロッカー B3）。
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-race-dup-project-'));
    const reportDir = mkdtempSync(join(TEST_TMPDIR, 'takt-findings-race-dup-report-'));
    cleanupDirs.add(projectCwd);
    cleanupDirs.add(reportDir);
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/dup.ts'), `${Array.from({ length: 15 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    initializeGitFixture(projectCwd, ['src/dup.ts']);

    const store = createFindingLedgerStore({
      projectCwd,
      runId: 'shared-run',
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    await store.updateLedger(() => ({
      ledger: {
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      result: undefined,
    }));

    // 上のテストと同じ理由で、2子の runId を揃え、callNamespace だけで区別する。
    const SHARED_RUN_ID = 'shared-run-dup';
    const rawFindingIdA = `${SHARED_RUN_ID}:child-a:reviewers:1:arch-review:i-1`;
    const rawFindingIdB = `${SHARED_RUN_ID}:child-b:reviewers:1:arch-review:i-1`;
    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      const rawFindingId = instruction.includes(`${SHARED_RUN_ID}:child-a:`) ? rawFindingIdA : rawFindingIdB;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{ rawFindingId, decision: 'new', evidence: 'No related open finding.' }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    const runCall = (callNamespace: string, raw: Record<string, unknown>) => runFindingManagerForStep({
      contract: contract as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: projectCwd,
      parentStep,
      stepIteration: 1,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [raw] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: SHARED_RUN_ID,
      callNamespace,
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const [resultA, resultB] = await Promise.all([
      runCall('child-a', {
        rawFindingId: 'i-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Duplicate issue at src/dup.ts',
        description: 'The handle opened at src/dup.ts:10 is never released.',
        suggestion: '',
        relation: 'new',
        ...verifiedSourceQuoteFields(projectCwd, 'src/dup.ts', 10),
      }),
      runCall('child-b', {
        rawFindingId: 'i-1',
        // familyTag と行番号が違っても、内容（path+title+description）が完全一致
        // すれば同一性の索引に掛かる（familyTag は分類ヒントに過ぎず識別根拠では
        // ないことの確認）。
        familyTag: 'security',
        severity: 'high',
        title: 'Duplicate issue at src/dup.ts',
        description: 'The handle opened at src/dup.ts:10 is never released.',
        suggestion: '',
        relation: 'new',
        ...verifiedSourceQuoteFields(projectCwd, 'src/dup.ts', 10),
      }),
    ]);

    expect(resultA.status).toBe('updated');
    expect(resultB.status).toBe('updated');

    const finalLedger = store.loadLedger();
    const openAtLocation = finalLedger.findings.filter((f) => f.location === 'src/dup.ts:10' && f.status === 'open');
    // F-0001 と F-0002 の重複が起きない: 1件だけ立つ。
    expect(openAtLocation).toHaveLength(1);
    // 両方の raw finding id がその1件に紐づく（片方は "new" から "same" へ
    // リダイレクトされている）。
    const rawFindingIdsOnFinding = openAtLocation[0]?.rawFindingIds ?? [];
    expect(rawFindingIdsOnFinding).toContain(rawFindingIdA);
    expect(rawFindingIdsOnFinding).toContain(rawFindingIdB);
  });
});

describe('runFindingManagerForStep stale rejection isolation', () => {
  it('Given a "same" decision that the freshly re-read ledger rejects (target no longer open) When run Then the raw lands through the explicit provisional plan and no duplicate finding is created', async () => {
    // codex 指摘: assembleManagerOutput() は保存直前に最新台帳へ再照合するが、
    // そこで不採用になった raw が別の確定アクションへ流れると、項目単位の
    // 不採用が実質不成立になるケースを再現する。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          {
            rawFindingId: 'run-2:reviewers:2:arch-review:i-1',
            decision: 'same',
            findingId: 'F-0001',
            evidence: 'Same root cause as F-0001, restated at a nearby line.',
          },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      },
    } as unknown as AgentResponse);

    const initialLedger = makeLedger(); // F-0001 は open, location src/a.ts:10
    // 保存直前の再読込で見える「最新台帳」では、別の並列子が既に F-0001 を
    // 解消済みにしている想定。
    const staleFreshLedger: FindingLedger = {
      ...initialLedger,
      findings: [
        {
          ...initialLedger.findings[0]!,
          status: 'resolved',
          lifecycle: 'resolved',
          resolvedAt: '2026-06-14T00:00:00.000Z',
          resolvedEvidence: 'Resolved by a concurrent child.',
        },
      ],
    };

    const savedLedgers: FindingLedger[] = [];
    const savedValidationReports: FindingManagerValidationReport[] = [];
    const saveManagerValidationReport = (report: FindingManagerValidationReport): string => {
      savedValidationReports.push(report);
      return join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`);
    };
    const ledgerRepository = new RevisionedFindingLedgerTestRepository(staleFreshLedger);
    const publicationDouble = createFindingManagerPublicationDouble(
      saveManagerValidationReport,
      ledgerRepository,
    );
    const observedMutations = observeFindingLedgerMutations(
      ledgerRepository,
      publicationDouble,
      (ledger) => {
        savedLedgers.push(ledger);
      },
    );
    const ledgerStore: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-manager-mechanical-runner/stale-ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => initialLedger,
      ...createFindingAdjudicationReservation(),
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport,
      ...publicationDouble,
      ...observedMutations,
    };
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    // 台帳の F-0001 (src/a.ts:10) とは1行ずれた場所にしておき、機械分類の
    // 完全一致（location 文字列一致）には掛からず LLM 判断（residual）に回す。
    const rawFinding = {
      rawFindingId: 'i-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Restated existing issue',
      description: 'Same bug, reported again at a nearby line.',
      suggestion: '',
      relation: 'new',
      ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 11),
    };

    const result = await runFindingManagerForStep({
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [rawFinding] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-2',
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    expect(savedLedgers).toHaveLength(1);
    const savedLedger = ledgerRepository.loadLedger();
    // 不採用になった raw は明示的な計画入力により gate-blocking provisional
    // として着地する（黙って消えてゲートが開くことも
    // 新規 finding として洗浄されることもない）。
    expect(savedLedger?.findings.find((f) => f.id === 'F-0001')?.status).toBe('resolved');
    const landed = savedLedger?.findings.find((f) => f.title === 'Restated existing issue');
    expect(landed?.status).toBe('open');
    expect(landed?.provisional).toMatchObject({ kind: 'raw-adjudication-unresolved', gateEffect: 'block' });
    // 除外した理由は validation report に残る。
    expect(savedValidationReports).toHaveLength(1);
    expect(savedValidationReports[0]?.ledgerUpdated).toBe(true);
    const lastAttempt = savedValidationReports[0]?.attempts.at(-1);
    expect(lastAttempt?.validationErrors.some((e) => e.includes('i-1'))).toBe(true);
    expect(lastAttempt?.validationErrors.some((e) => e.includes('not open'))).toBe(true);
  });
});
