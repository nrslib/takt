import { describe, expect, it } from 'vitest';
import type { FindingLedger, FindingLedgerEntry, FindingManagerOutput, RawFinding } from '../core/workflow/findings/types.js';
import {
  applyProvisionalSettlement,
  settleProvisionalsWithCleanEvidence,
} from '../core/workflow/findings/manager-provisional-settlement.js';
import { classifyProvisionalRecovery } from '../core/workflow/findings/provisional-recovery.js';
import {
  computeBaseInterpretationKey,
  computeInterpretationAttemptKey,
  candidateFromLegacyRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  beginInterpretations,
  resolveInterpretationAttempt,
} from '../core/workflow/findings/interpretation-wal.js';
import type { LedgerRepository } from '../core/workflow/findings/store.js';
import {
  applyManagerActionRecovery,
  collectManagerActionRecoveryCandidates,
} from '../core/workflow/findings/manager-action-recovery.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { applyRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-commit.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import {
  attachInterpretationRecoveryOrigins,
  collectInterpretationRecoveryItems,
} from '../core/workflow/findings/interpretation-recovery.js';

const observation = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-20T00:00:00.000Z',
};

function emptyOutput(): FindingManagerOutput {
  return {
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
  };
}

function raw(rawFindingId: string): RawFinding {
  return {
    rawFindingId,
    stepName: 'reviewer-a',
    reviewer: 'reviewer-a',
    familyTag: 'bug',
    severity: 'high',
    title: 'Incorrect state transition',
    description: 'The transition leaves the state inconsistent.',
    kind: 'issue',
    relation: 'new',
    evidence: { kind: 'locationless', explanation: 'State transition is absent.' },
  };
}

function provisional(
  id: string,
  kind: NonNullable<FindingLedgerEntry['provisional']>['kind'],
): FindingLedgerEntry {
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Incorrect state transition',
    description: 'The transition leaves the state inconsistent.',
    reviewers: ['reviewer-a'],
    rawFindingIds: ['source-1'],
    firstSeen: observation,
    lastSeen: observation,
    revision: 1,
    provisional: {
      kind,
      stableKey: `stable-${id}`,
      lineageKey: `lineage-${id}`,
      sourceRawFindingIds: ['source-1'],
      reason: 'pending recovery',
      firstObservedAt: observation,
      lastObservedAt: observation,
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: 1,
      recoveryReviewerStableKey: 'reviewer-stable-a',
    },
  };
}

function ledger(findings: FindingLedgerEntry[], rawFindings: RawFinding[] = []): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 20,
    updatedAt: observation.timestamp,
    findings,
    rawFindings,
    conflicts: [],
  };
}

describe('provisional recovery', () => {
  it('promotes the replay origin instead of creating a second finding', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    const replay = raw('replay-1');
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        newFindings: [{
          rawFindingIds: [replay.rawFindingId],
          title: replay.title,
          severity: replay.severity,
        }],
      },
      cleanRawIds: new Set(),
      wireById: new Map([[replay.rawFindingId, replay]]),
      freshLedger: ledger([process], [raw('source-1')]),
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map([[replay.rawFindingId, {
        provisionalFindingId: process.id,
        expectedProvisionalRevision: 1,
      }]]),
    });

    expect(settlement.output.newFindings).toEqual([]);
    expect(settlement.output.matches).toEqual([
      expect.objectContaining({ findingId: process.id, rawFindingIds: [replay.rawFindingId] }),
    ]);
    expect(settlement.promotedFindingIds).toEqual(new Set([process.id]));
    expect(settlement.settledReplayRawIds).toEqual(new Set([replay.rawFindingId]));
  });

  it('makes failed replay recovery terminal after the bounded attempts are exhausted', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    process.provisional!.adjudicationAttempts = [1, 2].map((attempt) => ({
      attempt,
      replayRawFindingId: `replay-${attempt}`,
      reason: 'manager returned no substantive outcome',
      at: observation,
    }));

    expect(classifyProvisionalRecovery(process.provisional!, 2)).toBe('terminal-adjudication');
  });

  it('records a replay admission failure inside the commit mutation', () => {
    const processFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const replaySource = { ...source, rawFindingId: 'replay-1' };
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromLegacyRawFinding(replaySource, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const recovered = applyRawAdjudicationRecovery({
      freshLedger: current,
      recovery: {
        intake: {
          items: [{ canonical, wire }],
          overflowRawFindingIds: new Set(),
          overflowSpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output: emptyOutput(),
        origins: new Map([[wire.rawFindingId, {
          provisionalFindingId: processFinding.id,
          sourceRawFindingId: source.rawFindingId,
          expectedProvisionalRevision: 1,
          attempt: 1,
        }]]),
        failureReasons: new Map(),
        capturedPreconditions: captureFindingPreconditions(current),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
      },
      runInput: {
        cwd: process.cwd(),
        workflowName: current.workflowName,
        parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
        runId: observation.runId,
        timestamp: observation.timestamp,
      } as RunFindingManagerForStepInput,
      observation,
    });

    expect(recovered.findings[0]?.provisional?.adjudicationAttempts).toEqual([
      expect.objectContaining({ attempt: 1, replayRawFindingId: wire.rawFindingId }),
    ]);
  });

  it('advances a started WAL record to a distinct attempt key and terminates the old attempt', async () => {
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
    });
    let current: FindingLedger = {
      ...ledger([]),
      interpretations: [{
        interpretationKey: computeInterpretationAttemptKey(baseInterpretationKey, 1),
        baseInterpretationKey,
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: 'lineage-a',
        candidateEvidenceHash: 'evidence-a',
        policyVersion: 2 as const,
        stage: 'interpretation_started' as const,
        startedAt: observation,
        promptPreconditions: [],
      }],
    };
    const attempt = resolveInterpretationAttempt({
      ledger: current,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
    });
    const store: LedgerRepository = {
      workflowName: current.workflowName,
      loadLedger: () => current,
      saveLedger: (next) => {
        current = next;
      },
      updateLedger: async (mutator) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
    };

    expect(attempt.attemptOrdinal).toBe(2);
    expect(attempt.interpretationKey).not.toBe(current.interpretations![0]!.interpretationKey);
    const begun = await beginInterpretations(store, [{
      ...attempt,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      promptPreconditions: [],
    }], observation);

    expect(begun.interruptedPriorKeys).toEqual(new Set([
      computeInterpretationAttemptKey(baseInterpretationKey, 1),
    ]));
    expect(current.interpretations?.map((record) => record.stage)).toEqual([
      'interpretation_interrupted',
      'interpretation_started',
    ]);
  });

  it('requeues a saved unresolved lineage without a new reviewer report', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');

    const recovered = collectInterpretationRecoveryItems({
      ledger: ledger([processFinding], [source]),
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(recovered).toEqual([
      expect.objectContaining({
        wire: expect.objectContaining({ rawFindingId: source.rawFindingId }),
        recoveryOrigin: {
          provisionalFindingId: processFinding.id,
          expectedProvisionalRevision: 1,
        },
      }),
    ]);
  });

  it('carries the saved process identity on a same-lineage reviewer report', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromLegacyRawFinding(source, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;

    const attached = attachInterpretationRecoveryOrigins({
      ledger: current,
      currentItems: [{ canonical, wire: toLedgerRawFinding(canonical) }],
      roundsCompleted: 1,
    });

    expect(attached[0]?.recoveryOrigin).toEqual({
      provisionalFindingId: processFinding.id,
      expectedProvisionalRevision: 1,
    });
    expect(collectInterpretationRecoveryItems({
      ledger: current,
      currentItems: attached,
      roundsCompleted: 1,
    })).toEqual([]);
  });

  it('resolves an overflow after an empty healthy envelope and bounds absent recovery rounds', () => {
    const overflow = provisional('F-0001', 'reviewer-output-overflow');
    const current = ledger([overflow]);
    const settlement = settleProvisionalsWithCleanEvidence({
      output: emptyOutput(),
      cleanRawIds: new Set(),
      wireById: new Map(),
      freshLedger: current,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(['reviewer-stable-a']),
      replayOrigins: new Map(),
    });
    const settled = applyProvisionalSettlement(current, settlement, observation.timestamp);

    expect(settled.findings[0]?.status).toBe('resolved');
    expect(classifyProvisionalRecovery(overflow.provisional!, 2)).toBe('envelope');
    expect(classifyProvisionalRecovery(overflow.provisional!, 3)).toBe('terminal-adjudication');
  });

  it('reapplies a source-less stale waiver and settles its process provisional', () => {
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved'),
      provisional: undefined,
      severity: 'medium',
    };
    const processFinding = provisional('F-0002', 'stale-precondition');
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'waive',
        findingId: target.id,
        reason: 'The supported runtime cannot change.',
        evidence: 'Runtime support policy is fixed.',
      },
    };
    const current = ledger([target, processFinding]);
    const candidates = collectManagerActionRecoveryCandidates(current, 1);
    const recovered = applyManagerActionRecovery({
      ledger: current,
      candidates,
      cwd: process.cwd(),
      roundsCompleted: 1,
      context: {
        workflowName: current.workflowName,
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
      observation,
    });

    expect(recovered.findings.find((finding) => finding.id === target.id)?.status).toBe('waived');
    expect(recovered.findings.find((finding) => finding.id === processFinding.id)?.status).toBe('resolved');
  });

  it('allows verified reviewer evidence to reopen a human-auditable dismissal', () => {
    const dismissed = provisional('F-0001', 'unverified-locationless');
    dismissed.status = 'dismissed';
    dismissed.lifecycle = 'dismissed';
    dismissed.dismissal = {
      basis: 'unverifiable_claim',
      reason: 'No verifiable evidence was available.',
      decidedAt: observation,
    };
    const reopenedRaw: RawFinding = {
      ...raw('reopen-1'),
      relation: 'reopened',
      targetFindingId: dismissed.id,
    };
    const reopened = reconcileFindingLedger({
      previousLedger: ledger([dismissed]),
      rawFindings: [reopenedRaw],
      managerOutput: {
        ...emptyOutput(),
        reopenedFindings: [{
          findingId: dismissed.id,
          rawFindingIds: [reopenedRaw.rawFindingId],
          evidence: 'A later reviewer supplied current evidence.',
        }],
      },
      context: {
        workflowName: 'peer-review',
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
    });

    expect(reopened.findings[0]?.status).toBe('open');
    expect(reopened.findings[0]?.provisional).toBeUndefined();
    expect(reopened.findings[0]?.dismissal).toEqual(dismissed.dismissal);
  });
});
