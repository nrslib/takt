import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, WorkflowStep } from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type {
  FindingManagerStore,
  FindingManagerValidationReport,
} from '../core/workflow/findings/store.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import { applyRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-commit.js';
import { runRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-recovery.js';
import {
  releaseRawAdjudicationReservations,
  reserveRawAdjudicationRecovery,
} from '../core/workflow/findings/raw-adjudication-reservation.js';
import {
  estimateTokens,
  RAW_ADJUDICATION_RECOVERY_LIMITS,
} from '../core/workflow/findings/raw-finding-limits.js';
import { classifyProvisionalRecovery } from '../core/workflow/findings/provisional-recovery.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import { RawAdjudicationDecisionsJsonSchema } from '../core/workflow/findings/raw-adjudication-step.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import { snapshotProvisionalRecoveryOrigin } from '../core/workflow/findings/provisional-recovery-origin.js';
import { createFindingManagerPublicationDouble } from './helpers/finding-manager-publication.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));
vi.mock('../core/workflow/findings/snapshot.js', () => ({
  computeReviewScopeSnapshotId: () => 'bounded-snapshot',
}));
vi.mock('../core/workflow/findings/manager-output-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/manager-output-validation.js')>();
  return { ...actual, validateFindingManagerOutput: vi.fn(actual.validateFindingManagerOutput) };
});
vi.mock('../core/workflow/findings/mechanical-classification.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/mechanical-classification.js')>();
  return { ...actual, classifyRawFindingsMechanically: vi.fn(actual.classifyRawFindingsMechanically) };
});

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);
const validationModule = await import('../core/workflow/findings/manager-output-validation.js');
const actualValidationModule = await vi.importActual<typeof validationModule>(
  '../core/workflow/findings/manager-output-validation.js',
);
const validateManagerOutputMock = vi.mocked(validationModule.validateFindingManagerOutput);
const mechanicalModule = await import('../core/workflow/findings/mechanical-classification.js');
const actualMechanicalModule = await vi.importActual<typeof mechanicalModule>(
  '../core/workflow/findings/mechanical-classification.js',
);
const classifyRawFindingsMechanicallyMock = vi.mocked(mechanicalModule.classifyRawFindingsMechanically);

const observation = {
  runId: 'run-bounded',
  stepName: 'reviewers',
  timestamp: '2026-07-20T00:00:00.000Z',
};
const quote = {
  location: 'package.json:1',
  verbatimExcerpt: '{',
  snapshotId: 'bounded-snapshot',
};

function findingId(index: number): string {
  return `F-${String(index).padStart(4, '0')}`;
}

function sourceRaw(index: number, descriptionChars = 0): RawFinding {
  const suffix = descriptionChars > 0 ? ` ${'x'.repeat(descriptionChars)}` : '';
  return {
    rawFindingId: `source-${index}`,
    stepName: 'reviewer-a',
    reviewer: 'reviewer-a',
    familyTag: 'bug',
    severity: 'high',
    title: `Issue ${index}`,
    location: quote.location,
    description: `Distinct issue ${index}.${suffix}`,
    suggestion: `Fix issue ${index}.`,
    relation: 'new',
    evidence: {
      kind: 'source_quote',
      path: 'package.json',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: quote.verbatimExcerpt,
      snapshotId: quote.snapshotId,
    },
  };
}

function provisionalFinding(input: {
  index: number;
  source: RawFinding;
  firstObservedRound: number;
  firstObservedAt?: string;
  attempts?: number;
}): FindingLedgerEntry {
  const firstObservedAt = {
    ...observation,
    timestamp: input.firstObservedAt ?? observation.timestamp,
  };
  return {
    id: findingId(input.index),
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: input.source.title,
    location: input.source.location,
    description: input.source.description,
    reviewers: ['reviewer-a'],
    rawFindingIds: [input.source.rawFindingId],
    firstSeen: firstObservedAt,
    lastSeen: firstObservedAt,
    revision: 1,
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: `stable-${input.index}`,
      lineageKey: `lineage-${input.index}`,
      sourceRawFindingIds: [input.source.rawFindingId],
      reason: 'pending raw adjudication',
      firstObservedAt,
      lastObservedAt: firstObservedAt,
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: input.firstObservedRound,
      ...(input.attempts === undefined ? {} : {
        adjudicationAttempts: Array.from({ length: input.attempts }, (_, attemptIndex) => ({
          attempt: attemptIndex + 1,
          replayRawFindingId: `prior-replay-${input.index}-${attemptIndex + 1}`,
          reason: 'prior failure',
          at: observation,
        })),
      }),
      recoveryReviewerStableKey: 'reviewer-stable-a',
    },
  };
}

function makeBacklog(input: {
  count: number;
  descriptionChars?: number;
  firstObservedRound: number;
  startIndex?: number;
}): FindingLedger {
  const startIndex = input.startIndex ?? 1;
  const raws = Array.from(
    { length: input.count },
    (_, offset) => sourceRaw(startIndex + offset, input.descriptionChars),
  );
  return {
    workflowName: 'peer-review',
    nextId: startIndex + input.count + 1,
    updatedAt: observation.timestamp,
    rawFindings: raws,
    conflicts: [],
    interpretations: [],
    findings: raws.map((source, offset) => provisionalFinding({
      index: startIndex + offset,
      source,
      firstObservedRound: input.firstObservedRound,
    })),
  };
}

interface RecoveryHarness {
  store: FindingManagerStore;
  claimed: Set<string>;
  released: string[];
  savedRawFindings: RawFinding[][];
  savedReports: FindingManagerValidationReport[];
  current: () => FindingLedger;
  replaceLedger: (replace: (ledger: FindingLedger) => FindingLedger) => void;
  runInput: RunFindingManagerForStepInput;
  managerStep: AgentWorkflowStep;
  runRecovery: () => ReturnType<typeof runRawAdjudicationRecovery>;
}

function makeHarness(
  initialLedger: FindingLedger,
  options?: { provider: 'codex' | 'cursor' },
): RecoveryHarness {
  let current = initialLedger;
  const provider = options?.provider ?? 'codex';
  const claimed = new Set<string>();
  const released: string[] = [];
  const savedRawFindings: RawFinding[][] = [];
  const savedReports: FindingManagerValidationReport[] = [];
  const store: FindingManagerStore = {
    ledgerIdentity: '/test/finding-raw-adjudication-bounds/ledger.json',
    workflowName: initialLedger.workflowName,
    loadLedger: () => current,
    saveLedger: (ledger) => { current = ledger; },
    updateLedger: async (mutator) => {
      const mutation = mutator(current);
      current = mutation.ledger;
      return mutation;
    },
    claimAdjudicationReservation: (token) => {
      if (claimed.has(token)) {
        return false;
      }
      claimed.add(token);
      return true;
    },
    releaseAdjudicationReservation: (token) => {
      claimed.delete(token);
      released.push(token);
    },
    createRunCopy: () => '/tmp/raw-adjudication-ledger.json',
    saveRawFindings: (_runId, _stepName, rawFindings) => {
      savedRawFindings.push(rawFindings);
      return '/tmp/raw-adjudication-findings.json';
    },
    saveManagerValidationReport: (report) => {
      savedReports.push(report);
      return '/tmp/raw-adjudication-report.json';
    },
    ...createFindingManagerPublicationDouble((report) => {
      savedReports.push(report);
      return `/tmp/findings-manager-validation.${report.stepName}.json`;
    }),
  };
  const managerStep: AgentWorkflowStep = {
    kind: 'agent',
    name: 'findings-manager',
    persona: 'findings-manager',
    edit: false,
  };
  const phase1Executor = new StepExecutor({
    optionsBuilder: {
      resolveStepProviderModel: () => ({ provider, model: 'gpt-test' }),
    },
    getLanguage: () => 'en',
  } as never);
  const runInput = {
    contract: {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    },
    cwd: process.cwd(),
    ledgerStore: store,
    optionsBuilder: {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider, model: 'gpt-test' }),
    },
    stepExecutor: {
      buildPhase1Instruction: phase1Executor.buildPhase1Instruction.bind(phase1Executor),
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      recordSynthesizedAgentUsage: () => {},
    },
    parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
    stepIteration: 2,
    subResults: [],
    workflowName: initialLedger.workflowName,
    runId: observation.runId,
    callNamespace: '',
    timestamp: observation.timestamp,
  } as RunFindingManagerForStepInput;
  return {
    store,
    claimed,
    released,
    savedRawFindings,
    savedReports,
    current: () => current,
    replaceLedger: (replace) => { current = replace(current); },
    runInput,
    managerStep,
    runRecovery: () => runRawAdjudicationRecovery({
      runInput,
      previousLedger: current,
      managerStep,
      ledgerCopyPath: '/tmp/raw-adjudication-ledger.json',
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    }),
  };
}

function rawBatchFromInstruction(instruction: string): RawFinding[] {
  const match = /Raw findings:\n(`{3,})json\n([\s\S]*?)\n\1/.exec(instruction);
  if (match?.[2] === undefined) {
    throw new Error('Raw findings block was not found in manager instruction');
  }
  return JSON.parse(match[2]) as RawFinding[];
}

function managerResponse(instruction: string, evidence = 'Independent issue.'): AgentResponse {
  const batch = rawBatchFromInstruction(instruction);
  return {
    status: 'done',
    content: '',
    structuredOutput: {
      rawDecisions: batch.map((raw) => ({
        rawFindingId: raw.rawFindingId,
        decision: 'new',
        findingId: '',
        evidence,
      })),
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    },
  };
}

function applyRecovery(harness: RecoveryHarness, recovery: Awaited<ReturnType<RecoveryHarness['runRecovery']>>): FindingLedger {
  return applyRawAdjudicationRecovery({
    freshLedger: harness.current(),
    recovery,
    runInput: harness.runInput,
    observation,
    reviewScopeSnapshotId: quote.snapshotId,
  }).ledger;
}

beforeEach(() => {
  executeAgentMock.mockReset();
  validateManagerOutputMock.mockReset();
  validateManagerOutputMock.mockImplementation(actualValidationModule.validateFindingManagerOutput);
  classifyRawFindingsMechanicallyMock.mockReset();
  classifyRawFindingsMechanicallyMock.mockImplementation(
    actualMechanicalModule.classifyRawFindingsMechanically,
  );
});

describe('bounded raw adjudication recovery', () => {
  it('uses a dedicated schema whose worst-case structured output stays within budget', () => {
    const properties = RawAdjudicationDecisionsJsonSchema.properties;
    const rawProperties = properties.rawDecisions.items.properties;
    const disabledDecisionKeys = [
      'disputeDecisions',
      'conflictDecisions',
      'invalidateDecisions',
      'duplicateDecisions',
      'dismissDecisions',
    ] as const;
    const worstCaseOutput = {
      rawDecisions: Array.from(
        { length: RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch },
        (_, index) => ({
          rawFindingId: `replay-${index.toString(16).padStart(64, '0')}`,
          decision: 'unsupported',
          findingId: 'F-9999',
          evidence: '\u0000'.repeat(rawProperties.evidence.maxLength),
        }),
      ),
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    };

    expect(properties.rawDecisions.maxItems).toBe(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch,
    );
    expect(rawProperties.rawFindingId.maxLength).toBeDefined();
    expect(rawProperties.findingId.maxLength).toBeDefined();
    expect(rawProperties.evidence.maxLength).toBeDefined();
    for (const key of disabledDecisionKeys) {
      expect(properties[key].maxItems).toBe(0);
    }
    expect(estimateTokens(JSON.stringify(worstCaseOutput))).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxOutputTokensPerCall,
    );
  });

  it('claims only the target limit and leaves overflow candidates unchanged', async () => {
    const initial = makeBacklog({ count: 70, firstObservedRound: 1 });
    const harness = makeHarness(initial);

    const reservation = await reserveRawAdjudicationRecovery(harness.store);

    expect(reservation.result).toHaveLength(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect(reservation.result.at(-1)?.provisionalFindingId).toBe(findingId(64));
    expect(harness.current().findings.slice(64)).toEqual(initial.findings.slice(64));
  });

  it('splits replay candidates across calls whose prompts stay within count and input limits', async () => {
    const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const instructions = executeAgentMock.mock.calls.map((call) => call[1] as string);

    expect(instructions).toHaveLength(2);
    expect(instructions.map((instruction) => rawBatchFromInstruction(instruction).length)).toEqual([16, 4]);
    expect(instructions.every((instruction) => (
      rawBatchFromInstruction(instruction).length
        <= RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch
      && estimateTokens(instruction) <= RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall
    ))).toBe(true);
    expect(recovery.origins).toHaveLength(20);
  });

  it('records an unsplittable single-item input overflow as a consumed failure', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, descriptionChars: 100_000, firstObservedRound: 1 }));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(recovery.origins).toHaveLength(1);
    expect(harness.released).toHaveLength(0);
    expect([...recovery.failures.values()][0]).toMatchObject({
      kind: 'input_budget_exceeded',
      outcome: 'audit_only',
      reason: expect.stringContaining('per-call budget'),
    });
    expect(applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    }).rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'audit_only' }),
    ]);
    expect(committed.findings[0]?.provisional?.adjudicationAttempts).toHaveLength(1);
    expect(committed.findings[0]?.revision).toBe(2);
  });

  it('rejects a replay failure when the expected attempt was already recorded', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, descriptionChars: 100_000, firstObservedRound: 1 }));
    const recovery = await harness.runRecovery();
    const firstCommit = applyRecovery(harness, recovery);
    harness.replaceLedger(() => firstCommit);

    const duplicateResult = applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    });
    const duplicateCommit = duplicateResult.ledger;

    expect(duplicateCommit.findings[0]?.provisional?.adjudicationAttempts).toHaveLength(1);
    expect(duplicateCommit.findings[0]?.revision).toBe(2);
    expect(duplicateResult.rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'stale' }),
    ]);
  });

  it('records source-missing failures without replay payload once per attempt until the bound', async () => {
    const backlog = makeBacklog({ count: 1, firstObservedRound: 1 });
    const harness = makeHarness({ ...backlog, rawFindings: [] });

    const firstRecovery = await harness.runRecovery();
    expect(firstRecovery.intake.items).toEqual([]);
    expect(firstRecovery.failures).toHaveLength(1);

    const firstResult = applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery: firstRecovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    });
    const firstCommit = firstResult.ledger;
    expect(firstResult.rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'audit_only' }),
    ]);
    expect(firstCommit.findings[0]?.provisional?.adjudicationAttempts).toEqual([
      expect.objectContaining({ attempt: 1 }),
    ]);
    harness.replaceLedger(() => firstCommit);

    const duplicateCommit = applyRecovery(harness, firstRecovery);
    expect(duplicateCommit).toEqual(firstCommit);
    harness.replaceLedger(() => duplicateCommit);

    const secondRecovery = await harness.runRecovery();
    const secondCommit = applyRecovery(harness, secondRecovery);
    const provisional = secondCommit.findings[0]?.provisional;

    expect(provisional?.adjudicationAttempts?.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(classifyProvisionalRecovery(provisional!, 2)).toBe('terminal-adjudication');
  });

  it('persists a source-missing finite outcome in the final manager report without synthesizing replay payload', async () => {
    const backlog = makeBacklog({ count: 1, firstObservedRound: 1 });
    const harness = makeHarness({ ...backlog, rawFindings: [] });

    await runFindingManagerForStep(harness.runInput);

    expect(harness.savedRawFindings.flat()).toEqual([]);
    expect(harness.savedReports.at(-1)?.rawFindingDispositions).toEqual([
      expect.objectContaining({
        outcome: 'audit_only',
        reason: expect.stringContaining('missing raw finding'),
      }),
    ]);
  });

  it('measures and sends the schema-appended fallback prompt without transforming it twice', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, firstObservedRound: 1 }), { provider: 'cursor' });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    await harness.runRecovery();
    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;

    expect(instruction).toContain('Return exactly one fenced JSON block that matches this JSON schema:');
    expect(instruction).toContain('"maxItems": 16');
    expect(instruction.match(/Return exactly one fenced JSON block/g)).toHaveLength(1);
    expect(estimateTokens(instruction)).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall,
    );
  });

  it('releases queue entries stopped by call or step budgets without consuming attempts', async () => {
    const backlog = makeBacklog({ count: 64, descriptionChars: 600, firstObservedRound: 1 });
    const harness = makeHarness({
      ...backlog,
      findings: backlog.findings.map((finding) => ({ ...finding, rawFindingIds: [] })),
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const instructions = executeAgentMock.mock.calls.map((call) => call[1] as string);
    const attempted = committed.findings.filter(
      (finding) => (finding.provisional?.adjudicationAttempts ?? []).length > 0,
    );

    expect(executeAgentMock.mock.calls.length).toBeGreaterThan(0);
    expect(executeAgentMock.mock.calls.length).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxManagerCallsPerStep,
    );
    expect(instructions.reduce((total, instruction) => total + estimateTokens(instruction), 0))
      .toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerStep);
    expect(recovery.origins.size).toBeLessThan(64);
    expect(harness.released.length).toBe(64 - recovery.origins.size);
    expect(attempted).toHaveLength(0);
    expect(committed.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(
      64 - recovery.origins.size,
    );
  });

  it('stops after the first provider exception and records only the sent batch', async () => {
    const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
    executeAgentMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(recovery.origins).toHaveLength(16);
    expect(applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    }).rawFindingDispositions).toHaveLength(16);
    expect(harness.released).toHaveLength(4);
    expect(committed.findings.slice(0, 16).every(
      (finding) => finding.provisional?.adjudicationAttempts?.length === 1,
    )).toBe(true);
    expect(committed.findings.slice(16).every(
      (finding) => finding.provisional?.adjudicationAttempts === undefined,
    )).toBe(true);
  });

  it('settles mechanical replay outcomes without adding failure attempts when a residual call fails', async () => {
    const targetRaw = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetRaw, firstObservedRound: 1 }),
      provisional: undefined,
    };
    const mechanicalSource: RawFinding = {
      ...sourceRaw(1),
      relation: 'persists',
      targetFindingId: target.id,
    };
    const residualSource = sourceRaw(2);
    const current: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetRaw, mechanicalSource, residualSource],
      findings: [
        target,
        provisionalFinding({ index: 1, source: mechanicalSource, firstObservedRound: 1 }),
        provisionalFinding({ index: 2, source: residualSource, firstObservedRound: 1 }),
      ],
    };
    const harness = makeHarness(current);
    executeAgentMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const mechanicalOrigin = committed.findings.find((finding) => finding.id === findingId(1));
    const residualOrigin = committed.findings.find((finding) => finding.id === findingId(2));

    expect(recovery.output.matches.some((match) => match.findingId === target.id)).toBe(true);
    expect(mechanicalOrigin?.status).toBe('resolved');
    expect(mechanicalOrigin?.provisional?.adjudicationAttempts).toBeUndefined();
    expect(residualOrigin?.provisional?.adjudicationAttempts).toHaveLength(1);
  });

  it('classifies an explicit replay-manager unsupported decision as unsupported in both recovery audit views', async () => {
    const targetSource = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetSource, firstObservedRound: 1 }),
      status: 'resolved',
      lifecycle: 'resolved',
      provisional: undefined,
    };
    const replaySource: RawFinding = {
      ...sourceRaw(1),
      relation: 'reopened',
      targetFindingId: target.id,
    };
    const current: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource, replaySource],
      findings: [
        target,
        provisionalFinding({ index: 1, source: replaySource, firstObservedRound: 1 }),
      ],
    };
    const harness = makeHarness(current);
    const evidence = 'The replay evidence does not support the referenced target.';
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const [replayRaw] = rawBatchFromInstruction(instruction as string);
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{
            rawFindingId: replayRaw!.rawFindingId,
            decision: 'unsupported',
            findingId: '',
            evidence,
          }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const recovery = await harness.runRecovery();
    const [replayRawFindingId] = recovery.origins.keys();
    const committed = applyRawAdjudicationRecovery({
      freshLedger: current,
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    });

    expect(recovery.failures.get(replayRawFindingId!)).toEqual({
      kind: 'manager_unsupported',
      outcome: 'unsupported',
      reason: evidence,
    });
    expect(recovery.unsupportedRawFindingReports).toEqual([{
      rawFindingId: replayRawFindingId,
      targetFindingId: target.id,
      evidence,
    }]);
    expect(committed.rawFindingDispositions).toEqual([{
      rawFindingId: replayRawFindingId,
      outcome: 'unsupported',
      reason: evidence,
    }]);
  });

  it.each(['oversized-output', 'whole-output-discard'] as const)(
    'limits %s failure to the sent batch and leaves later backlog untouched',
    async (failureKind) => {
      const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
      if (failureKind === 'oversized-output') {
        executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
          managerResponse(instruction as string, 'x'.repeat(9_000))
        ));
      } else {
        let validationCall = 0;
        validateManagerOutputMock.mockImplementation((...args) => {
          validationCall += 1;
          return validationCall === 2
            ? { ok: false, errors: ['synthetic whole-output discard'] }
            : actualValidationModule.validateFindingManagerOutput(...args);
        });
        executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
          managerResponse(instruction as string)
        ));
      }

      const recovery = await harness.runRecovery();
      const committed = applyRecovery(harness, recovery);

      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      expect(recovery.origins).toHaveLength(16);
      expect(committed.findings.slice(0, 16).every(
        (finding) => finding.provisional?.adjudicationAttempts?.length === 1,
      )).toBe(true);
      expect(committed.findings.slice(16).every(
        (finding) => finding.provisional?.adjudicationAttempts === undefined,
      )).toBe(true);
    },
  );

  it('stops after discarding a resolution-confirmation-only batch and releases the remaining queue', async () => {
    const targetSource = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetSource, firstObservedRound: 1 }),
      provisional: undefined,
    };
    const confirmations = Array.from({ length: 20 }, (_, offset): RawFinding => ({
      ...sourceRaw(offset + 1),
      rawFindingId: `confirmation-${offset + 1}`,
      relation: 'resolution_confirmation',
      targetFindingId: target.id,
    }));
    const harness = makeHarness({
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource, ...confirmations],
      findings: [
        target,
        ...confirmations.map((source, offset) => provisionalFinding({
          index: offset + 1,
          source,
          firstObservedRound: 1,
        })),
      ],
    });
    classifyRawFindingsMechanicallyMock.mockImplementationOnce((input) => ({
      output: {
        matches: [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
        invalidatedFindings: [],
        duplicateFindings: [],
        dismissedFindings: [],
      },
      residualRawFindings: input.rawFindings,
    }));
    let discardedFirstBatch = false;
    validateManagerOutputMock.mockImplementation((...args) => {
      if (!discardedFirstBatch && args[0].rawFindings.length === 16) {
        discardedFirstBatch = true;
        return { ok: false, errors: ['synthetic confirmation-only whole-output discard'] };
      }
      return actualValidationModule.validateFindingManagerOutput(...args);
    });
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
      managerResponse(instruction as string)
    ));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const replayed = committed.findings.filter((finding) => finding.id !== target.id).slice(0, 16);
    const untouched = committed.findings.filter((finding) => finding.id !== target.id).slice(16);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(recovery.origins).toHaveLength(16);
    expect(harness.released).toHaveLength(4);
    expect(replayed.every(
      (finding) => finding.provisional?.adjudicationAttempts?.length === 1,
    )).toBe(true);
    expect(untouched.every(
      (finding) => finding.provisional?.adjudicationAttempts === undefined,
    )).toBe(true);
  });

  it('normalizes same-identity new decisions once across the batch boundary', async () => {
    const backlog = makeBacklog({ count: 17, firstObservedRound: 1 });
    const firstDuplicateSource = backlog.rawFindings[15]!;
    const secondDuplicateSource: RawFinding = {
      ...backlog.rawFindings[16]!,
      title: firstDuplicateSource.title,
      location: firstDuplicateSource.location,
      description: firstDuplicateSource.description,
      suggestion: firstDuplicateSource.suggestion,
    };
    const harness = makeHarness({
      ...backlog,
      rawFindings: [...backlog.rawFindings.slice(0, 16), secondDuplicateSource],
      findings: backlog.findings.map((finding, index) => {
        if (index < 15) {
          return finding;
        }
        const source = index === 15 ? firstDuplicateSource : secondDuplicateSource;
        return {
          ...provisionalFinding({
            index: index + 1,
            source,
            firstObservedRound: index === 15 ? 2 : 1,
          }),
          title: `Provisional origin ${index + 1}`,
          description: `Distinct provisional origin ${index + 1}`,
        };
      }),
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const duplicateReplayIds = new Set([...recovery.origins]
      .filter(([, origin]) => origin.provisionalFindingId === findingId(16)
        || origin.provisionalFindingId === findingId(17))
      .map(([rawFindingId]) => rawFindingId));
    const grouped = recovery.output.newFindings.find((finding) => (
      finding.rawFindingIds.filter((rawFindingId) => duplicateReplayIds.has(rawFindingId)).length === 2
    ));
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(grouped?.rawFindingIds).toEqual(expect.arrayContaining([...duplicateReplayIds]));
    const newerOrigin = committed.findings.find((finding) => finding.id === findingId(16));
    const canonicalOrigin = committed.findings.find((finding) => finding.id === findingId(17));
    const normalFindingsForIdentity = committed.findings.filter((finding) => (
      finding.provisional === undefined
      && finding.rawFindingIds.some((rawFindingId) => duplicateReplayIds.has(rawFindingId))
    ));

    expect(normalFindingsForIdentity).toEqual([canonicalOrigin]);
    expect(canonicalOrigin?.status).toBe('open');
    expect(canonicalOrigin?.rawFindingIds).toEqual(expect.arrayContaining([...duplicateReplayIds]));
    expect(canonicalOrigin?.provisional).toBeUndefined();
    expect(newerOrigin?.status).toBe('resolved');
    expect(newerOrigin?.resolvedEvidence).toContain(canonicalOrigin!.id);
    expect(newerOrigin?.provisional?.adjudicationAttempts).toBeUndefined();
  });

  it('keeps never-selected findings replayable after two rounds and advances only twice-failed findings', async () => {
    const old = makeBacklog({ count: 70, firstObservedRound: 1 });
    const newer = makeBacklog({ count: 10, firstObservedRound: 2, startIndex: 71 });
    const harness = makeHarness({
      ...old,
      nextId: 82,
      rawFindings: [...old.rawFindings, ...newer.rawFindings],
      findings: [...old.findings, ...newer.findings],
    });
    const first = await reserveRawAdjudicationRecovery(harness.store);
    releaseRawAdjudicationReservations(
      harness.store,
      new Set(first.result.map((reservation) => reservation.reservationToken)),
    );
    const firstIds = new Set(first.result.map((reservation) => reservation.provisionalFindingId));
    harness.replaceLedger((ledger) => ({
      ...ledger,
      findings: ledger.findings.map((finding) => firstIds.has(finding.id)
        ? {
          ...finding,
          provisional: {
            ...finding.provisional!,
            adjudicationAttempts: [{
              attempt: 1,
              replayRawFindingId: `first-${finding.id}`,
              reason: 'failure',
              at: observation,
            }],
          },
        }
        : finding),
    }));
    const second = await reserveRawAdjudicationRecovery(harness.store);
    releaseRawAdjudicationReservations(
      harness.store,
      new Set(second.result.map((reservation) => reservation.reservationToken)),
    );
    const secondIds = new Set(second.result.map((reservation) => reservation.provisionalFindingId));
    harness.replaceLedger((ledger) => ({
      ...ledger,
      findings: ledger.findings.map((finding) => secondIds.has(finding.id)
        ? {
          ...finding,
          provisional: {
            ...finding.provisional!,
            adjudicationAttempts: [
              ...(finding.provisional?.adjudicationAttempts ?? []),
              {
                attempt: (finding.provisional?.adjudicationAttempts ?? []).length + 1,
                replayRawFindingId: `second-${finding.id}`,
                reason: 'failure',
                at: observation,
              },
            ],
          },
        }
        : finding),
    }));

    const twiceFailed = harness.current().findings.filter(
      (finding) => finding.provisional?.adjudicationAttempts?.length === 2,
    );
    const neverSelected = harness.current().findings.filter((finding) => Number(finding.id.slice(2)) > 70);
    expect(twiceFailed.length).toBeGreaterThan(0);
    expect(twiceFailed.every((finding) => (
      classifyProvisionalRecovery(finding.provisional!, 2) === 'terminal-adjudication'
    ))).toBe(true);
    expect(neverSelected.every((finding) => (
      finding.provisional?.adjudicationAttempts === undefined
      && classifyProvisionalRecovery(finding.provisional!, 2) === 'raw-adjudication'
    ))).toBe(true);
  });

  it('gives concurrent reservations disjoint bounded ownership and skips already claimed candidates', async () => {
    const harness = makeHarness(makeBacklog({ count: 100, firstObservedRound: 1 }));

    const [left, right] = await Promise.all([
      reserveRawAdjudicationRecovery(harness.store),
      reserveRawAdjudicationRecovery(harness.store),
    ]);
    const leftTokens = new Set(left.result.map((reservation) => reservation.reservationToken));
    const rightTokens = new Set(right.result.map((reservation) => reservation.reservationToken));

    expect(left.result.length).toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect(right.result.length).toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect([...leftTokens].filter((token) => rightTokens.has(token))).toEqual([]);
    expect(new Set([
      ...left.result.map((reservation) => reservation.provisionalFindingId),
      ...right.result.map((reservation) => reservation.provisionalFindingId),
    ])).toHaveLength(100);
  });

  it('rejects a stale revision at commit and releases its reservation token', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, firstObservedRound: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      harness.replaceLedger((ledger) => ({
        ...ledger,
        findings: ledger.findings.map((finding) => ({ ...finding, revision: 2 })),
      }));
      return managerResponse(instruction as string);
    });

    const result = await runFindingManagerForStep(harness.runInput);
    const origin = result.ledger.findings.find((finding) => finding.id === findingId(1));

    expect(origin?.revision).toBe(2);
    expect(origin?.provisional?.adjudicationAttempts).toBeUndefined();
    expect(result.ledger.findings.some((finding) => finding.id !== findingId(1))).toBe(false);
    expect(harness.claimed).toHaveLength(0);
  });

  it('rejects every replay entry that mixes a stale raw with a fresh raw across all landing arrays', () => {
    const targetSources = Array.from({ length: 4 }, (_, offset) => sourceRaw(9000 + offset));
    const targets: FindingLedgerEntry[] = targetSources.map((source, offset) => ({
      ...provisionalFinding({ index: 9000 + offset, source, firstObservedRound: 1 }),
      status: offset === 3 ? 'resolved' : 'open',
      lifecycle: offset === 3 ? 'resolved' : 'new',
      provisional: undefined,
      ...(offset === 3
        ? { resolvedAt: observation.timestamp, resolvedEvidence: 'Previously fixed.' }
        : {}),
    }));
    const actionSources: RawFinding[] = [
      sourceRaw(1),
      sourceRaw(2),
      { ...sourceRaw(3), relation: 'persists', targetFindingId: targets[0]!.id },
      { ...sourceRaw(4), relation: 'persists', targetFindingId: targets[0]!.id },
      { ...sourceRaw(5), relation: 'resolution_confirmation', targetFindingId: targets[1]!.id },
      { ...sourceRaw(6), relation: 'resolution_confirmation', targetFindingId: targets[1]!.id },
      { ...sourceRaw(7), relation: 'reopened', targetFindingId: targets[3]!.id },
      { ...sourceRaw(8), relation: 'reopened', targetFindingId: targets[3]!.id },
      sourceRaw(9),
      sourceRaw(10),
    ];
    const processes = actionSources.map((source, offset) => provisionalFinding({
      index: offset + 1,
      source,
      firstObservedRound: 1,
    }));
    const originalLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 9010,
      updatedAt: observation.timestamp,
      rawFindings: [...targetSources, ...actionSources],
      conflicts: [],
      interpretations: [],
      findings: [...processes, ...targets],
    };
    const replayItems = actionSources.map((source, offset) => {
      const replaySource = { ...source, rawFindingId: `replay-mixed-${offset + 1}` };
      const canonical = canonicalizeReviewerRawFinding(
        candidateFromStoredRawFinding(replaySource, 'reviewer-stable-a'),
        { ledger: originalLedger },
      ).canonical;
      return { canonical, wire: toLedgerRawFinding(canonical) };
    });
    const pairRawIds = (pairIndex: number): [string, string] => [
      replayItems[pairIndex * 2]!.wire.rawFindingId,
      replayItems[pairIndex * 2 + 1]!.wire.rawFindingId,
    ];
    const freshLedger: FindingLedger = {
      ...originalLedger,
      findings: originalLedger.findings.map((finding) => {
        const processIndex = processes.findIndex((process) => process.id === finding.id);
        return processIndex >= 0 && processIndex % 2 === 0
          ? { ...finding, revision: finding.revision + 1 }
          : finding;
      }),
    };
    const origins = new Map(replayItems.map((item, offset) => {
      const process = processes[offset]!;
      return [item.wire.rawFindingId, {
        provisionalFindingId: process.id,
        sourceRawFindingId: actionSources[offset]!.rawFindingId,
        expectedProvisionalRevision: process.revision,
        attempt: 1,
        recoveryOrigin: snapshotProvisionalRecoveryOrigin({
          ...process,
          provisional: process.provisional!,
        }),
      }] as const;
    }));
    const output = {
      matches: [{
        findingId: targets[0]!.id,
        rawFindingIds: pairRawIds(1),
        evidence: 'The issue persists.',
      }],
      newFindings: [{
        rawFindingIds: pairRawIds(0),
        title: actionSources[0]!.title,
        severity: actionSources[0]!.severity,
      }],
      resolvedFindings: [{
        findingId: targets[1]!.id,
        rawFindingIds: pairRawIds(2),
        evidence: 'The issue is fixed.',
      }],
      reopenedFindings: [{
        findingId: targets[3]!.id,
        rawFindingIds: pairRawIds(3),
        evidence: 'The issue recurred.',
      }],
      conflicts: [{
        findingIds: [targets[2]!.id],
        rawFindingIds: pairRawIds(4),
        description: 'The evidence conflicts with the existing finding.',
      }],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      invalidatedFindings: [],
      duplicateFindings: [],
      dismissedFindings: [],
    };

    const committed = applyRawAdjudicationRecovery({
      freshLedger,
      recovery: {
        intake: {
          items: replayItems,
          overflowRawFindingIds: new Set(),
          overflowSpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output,
        origins,
        failures: new Map(),
        capturedPreconditions: captureFindingPreconditions(originalLedger),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      runInput: makeHarness(originalLedger).runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
    });

    expect(committed.ledger.conflicts).toEqual([]);
    expect(committed.ledger.findings).toHaveLength(originalLedger.findings.length);
    for (const target of targets) {
      expect(committed.ledger.findings.find((finding) => finding.id === target.id))
        .toEqual(freshLedger.findings.find((finding) => finding.id === target.id));
    }
    for (const process of processes) {
      expect(committed.ledger.findings.find((finding) => finding.id === process.id)).toMatchObject({
        status: 'open',
        lifecycle: 'new',
        provisional: expect.objectContaining({ stableKey: process.provisional!.stableKey }),
      });
    }
    expect(committed.ledger.findings.filter((finding) => (
      processes.some((process) => process.id === finding.id)
    )).every((finding) => finding.provisional !== undefined)).toBe(true);
  });

  it('orders older cohorts first, then fewer attempts, observation time, and finding id', async () => {
    const sources = Array.from({ length: 7 }, (_, offset) => sourceRaw(offset + 1));
    const findings = [
      provisionalFinding({ index: 1, source: sources[0]!, firstObservedRound: 2 }),
      provisionalFinding({ index: 2, source: sources[1]!, firstObservedRound: 1, attempts: 1 }),
      provisionalFinding({ index: 3, source: sources[2]!, firstObservedRound: 1 }),
      provisionalFinding({ index: 4, source: sources[3]!, firstObservedRound: 1 }),
      provisionalFinding({
        index: 5,
        source: sources[4]!,
        firstObservedRound: 1,
        firstObservedAt: '2026-07-19T00:00:00.000Z',
        attempts: 1,
      }),
      provisionalFinding({
        index: 6,
        source: sources[5]!,
        firstObservedRound: 1,
        firstObservedAt: '2026-07-19T00:00:00.000Z',
      }),
      provisionalFinding({ index: 7, source: sources[6]!, firstObservedRound: 1 }),
    ];
    const harness = makeHarness({
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      rawFindings: sources,
      findings,
    });

    const reservation = await reserveRawAdjudicationRecovery(harness.store);

    expect(reservation.result.map((item) => item.provisionalFindingId)).toEqual([
      findingId(6),
      findingId(3),
      findingId(4),
      findingId(7),
      findingId(5),
      findingId(2),
      findingId(1),
    ]);
  });
});
