import { describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import {
  candidateFromStoredRawFinding,
  canonicalRawIntegrityDigestOf,
  canonicalizeReviewerRawFinding,
  computeBaseInterpretationKey,
  computeProvisionalStableKey,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  beginInterpretations,
  completeInterpretations,
  releaseInterpretationReservations,
} from '../core/workflow/findings/interpretation-wal.js';
import type { FindingManagerStore } from '../core/workflow/findings/store.js';
import {
  applyInterpretationDecisions,
  classifyInterpretationWal,
  emptyLadderResult,
} from '../core/workflow/findings/manager-interpretation-plan.js';
import {
  captureFindingPreconditions,
  captureFindingMutationPrecondition,
  checkFindingPrecondition,
  computeFindingEvidenceHash,
} from '../core/workflow/findings/finding-preconditions.js';
import { issueOpenConflictOutcomeAuthority } from '../core/workflow/findings/raw-capabilities.js';
import {
  assertRawFindingsAppendOnly,
  computeRawFindingIntegrityDigest,
} from '../core/workflow/findings/finding-integrity.js';
import { normalizeFindingLedgerMutation } from '../core/workflow/findings/ledger-mutation.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';

const observation = {
  runId: 'run-integrity',
  stepName: 'reviewers',
  timestamp: '2026-07-27T00:00:00.000Z',
};

function openFinding(): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'persists',
    severity: 'high',
    title: 'Existing finding',
    evidenceIds: [],
    description: 'Existing description',
    rawFindingIds: [],
    reviewers: ['reviewer'],
    firstSeen: observation,
    lastSeen: observation,
    revision: 1,
  };
}

function ledger(): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 2,
    findings: [openFinding()],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    updatedAt: observation.timestamp,
  });
}

function rawWithEvidence(
  targetPrecondition: NonNullable<RawFinding['targetPrecondition']>,
  explanation: string,
): RawFinding {
  return {
    rawFindingId: 'raw-integrity',
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: 'Same claim',
    description: 'Same claim description',
    suggestion: null,
    relation: 'persists',
    targetFindingId: 'F-0001',
    targetPrecondition,
    evidence: [{
      kind: 'engine_proof',
      proofId: (explanation.endsWith('E1') ? '1' : '2').repeat(64),
    }],
  };
}

function inMemoryStore(initial: FindingLedger): {
  store: FindingManagerStore;
  current: () => FindingLedger;
} {
  let current = initial;
  const claimed = new Set<string>();
  return {
    current: () => current,
    store: {
      ledgerIdentity: '/test/finding-integrity-boundaries/ledger.json',
      interpretationLiveClaims: processInterpretationLiveClaims,
      workflowName: initial.workflowName,
      loadLedger: () => current,
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
      },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    },
  };
}

describe('finding integrity boundaries', () => {
  it('does not reuse a completed decision when typed evidence changes under the same claim identity', async () => {
    const baseLedger = ledger();
    const targetPrecondition = captureFindingMutationPrecondition(baseLedger, 'F-0001')!;
    const canonicalE1 = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(
        rawWithEvidence(targetPrecondition, 'evidence E1'),
        'reviewer-stable',
      ),
      { ledger: baseLedger, preserveAmbiguityOrigin: true },
    ).canonical;
    const canonicalE2 = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(
        rawWithEvidence(targetPrecondition, 'evidence E2'),
        'reviewer-stable',
      ),
      { ledger: baseLedger, preserveAmbiguityOrigin: true },
    ).canonical;
    expect(canonicalE2.claimIdentityHash).toBe(canonicalE1.claimIdentityHash);
    expect(canonicalE2.evidenceSetHash).not.toBe(canonicalE1.evidenceSetHash);
    expect(canonicalRawIntegrityDigestOf(canonicalE2))
      .not.toBe(canonicalRawIntegrityDigestOf(canonicalE1));

    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonicalE1.reviewerStableKey,
      lineageKey: canonicalE1.lineageKey,
      candidateEvidenceHash: canonicalE1.evidenceSetHash,
    });
    const memory = inMemoryStore(baseLedger);
    const first = await beginInterpretations(memory.store, [{
      baseInterpretationKey,
      reviewerStableKey: canonicalE1.reviewerStableKey,
      lineageKey: canonicalE1.lineageKey,
      candidateEvidenceHash: canonicalE1.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonicalE1),
      promptPreconditions: [targetPrecondition],
    }], observation, 'round-integrity');
    const firstKey = first.attemptByBaseKey.get(baseInterpretationKey)!.interpretationKey;
    const firstDecision = {
      decision: 'open_conflict' as const,
      rawFindingId: canonicalE1.rawFindingId,
      targetFindingId: 'F-0001',
    };
    await completeInterpretations(
      memory.store,
      new Map([[firstKey, firstDecision]]),
      first.ownedByKey,
      new Map([[firstKey, canonicalRawIntegrityDigestOf(canonicalE1)]]),
      observation,
      'round-integrity',
    );
    await releaseInterpretationReservations(memory.store, first.ownedByKey, observation);

    const conflict = {
      findingIds: ['F-0001'],
      rawFindingIds: [canonicalE1.rawFindingId],
      description: 'Identity remains ambiguous',
    };
    const provisionalSpec = {
      kind: 'raw-meaning-ambiguous' as const,
      stableKey: computeProvisionalStableKey({
        reviewerStableKey: canonicalE1.reviewerStableKey,
        lineageKey: canonicalE1.lineageKey,
        provisionalKind: 'raw-meaning-ambiguous',
      }),
      lineageKey: canonicalE1.lineageKey,
      sourceRawFindingIds: [canonicalE1.rawFindingId],
      reason: 'Held while the conflict is active',
      title: 'Same claim',
      severity: 'high' as const,
      reviewers: ['reviewer'],
    };
    expect(() => issueOpenConflictOutcomeAuthority({
      canonical: canonicalE2,
      ledger: memory.current(),
      interpretationKey: firstKey,
      conflict,
      provisionalSpec,
    })).toThrow('current canonical WAL decision');

    const second = await beginInterpretations(memory.store, [{
      baseInterpretationKey,
      reviewerStableKey: canonicalE2.reviewerStableKey,
      lineageKey: canonicalE2.lineageKey,
      candidateEvidenceHash: canonicalE2.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonicalE2),
      promptPreconditions: [targetPrecondition],
    }], observation, 'round-integrity');
    const secondAttempt = second.attemptByBaseKey.get(baseInterpretationKey)!;
    expect(secondAttempt.interpretationKey).not.toBe(firstKey);
    expect(second.completedByKey).toEqual(new Map());
    expect(second.integrityStaleKeys).toEqual(new Set([secondAttempt.interpretationKey]));

    const target = {
      canonical: canonicalE2,
      wire: toLedgerRawFinding(canonicalE2),
      baseInterpretationKey,
      ...secondAttempt,
    };
    const classified = classifyInterpretationWal({
      targets: [target],
      begin: second,
      result: emptyLadderResult(1),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const staleDecision = classified.decidedByKey.get(secondAttempt.interpretationKey)!;
    expect(staleDecision.decision).toBe('provisional');
    const completed = await completeInterpretations(
      memory.store,
      new Map([[secondAttempt.interpretationKey, staleDecision]]),
      second.ownedByKey,
      new Map([[
        secondAttempt.interpretationKey,
        canonicalRawIntegrityDigestOf(canonicalE2),
      ]]),
      observation,
      'round-integrity',
    );
    const applied = applyInterpretationDecisions({
      result: classified.result,
      decisions: completed,
      interpretationTargets: [target],
      provisionalOnlyRawFindingIds: new Set(),
      proofsByRawId: new Map(),
    });
    expect(applied.provisionalSpecs).toHaveLength(1);
    expect(applied.pendingConflicts).toEqual([]);
  });

  it('hashes complete raw wire content and rejects same-id replacement at mutation boundaries', () => {
    const baseLedger = ledger();
    const targetPrecondition = captureFindingMutationPrecondition(baseLedger, 'F-0001')!;
    const rawE1 = rawWithEvidence(targetPrecondition, 'evidence E1');
    const rawE2 = rawWithEvidence(targetPrecondition, 'evidence E2');
    const finding = {
      ...baseLedger.findings[0]!,
      rawFindingIds: [rawE1.rawFindingId],
    };
    expect(computeRawFindingIntegrityDigest(rawE2))
      .not.toBe(computeRawFindingIntegrityDigest(rawE1));
    expect(computeFindingEvidenceHash(finding, new Map([[rawE1.rawFindingId, rawE1]])))
      .not.toBe(computeFindingEvidenceHash(finding, new Map([[rawE2.rawFindingId, rawE2]])));
    expect(() => assertRawFindingsAppendOnly([rawE1], [rawE2]))
      .toThrow('cannot be replaced with different content');
    expect(() => assertRawFindingsAppendOnly([rawE1], [{ ...rawE1 }])).not.toThrow();
    expect(() => assertRawFindingsAppendOnly([rawE1, { ...rawE1 }], [rawE1]))
      .toThrow('Duplicate current raw finding');
    expect(() => assertRawFindingsAppendOnly([rawE1], [rawE1, { ...rawE1 }]))
      .toThrow('Duplicate next raw finding');

    const current = {
      ...baseLedger,
      rawFindings: [...baseLedger.rawFindings, rawE1],
    };
    expect(() => normalizeFindingLedgerMutation(current, {
      ledger: {
        ...current,
        rawFindings: [...baseLedger.rawFindings, rawE2],
      },
      result: undefined,
    }, current.workflowName)).toThrow('cannot be replaced with different content');
  });

  it('detects a typed evidence replacement through the finding mutation CAS', () => {
    const baseLedger = ledger();
    const targetPrecondition = captureFindingMutationPrecondition(baseLedger, 'F-0001')!;
    const rawE1 = rawWithEvidence(targetPrecondition, 'evidence E1');
    const rawE2 = rawWithEvidence(targetPrecondition, 'evidence E2');
    const observedLedger = {
      ...baseLedger,
      findings: [{
        ...baseLedger.findings[0]!,
        rawFindingIds: [rawE1.rawFindingId],
      }],
      rawFindings: [rawE1],
    };
    const captured = captureFindingPreconditions(observedLedger).get('F-0001')!;
    const tamperedLedger = {
      ...observedLedger,
      rawFindings: [rawE2],
    };

    expect(checkFindingPrecondition({
      captured,
      freshLedger: observedLedger,
      expectedStatuses: ['open'],
    })).toEqual({ outcome: 'ok' });
    expect(checkFindingPrecondition({
      captured,
      freshLedger: tamperedLedger,
      expectedStatuses: ['open'],
    })).toEqual({
      outcome: 'stale',
      detail: 'target finding "F-0001" evidence changed after the prompt',
    });
  });

  it('converts a completion-time canonical CAS mismatch into a provisional decision', async () => {
    const baseLedger = ledger();
    const targetPrecondition = captureFindingMutationPrecondition(baseLedger, 'F-0001')!;
    const canonicalE1 = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(
        rawWithEvidence(targetPrecondition, 'evidence E1'),
        'reviewer-stable',
      ),
      { ledger: baseLedger, preserveAmbiguityOrigin: true },
    ).canonical;
    const canonicalE2 = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(
        rawWithEvidence(targetPrecondition, 'evidence E2'),
        'reviewer-stable',
      ),
      { ledger: baseLedger, preserveAmbiguityOrigin: true },
    ).canonical;
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonicalE1.reviewerStableKey,
      lineageKey: canonicalE1.lineageKey,
      candidateEvidenceHash: canonicalE1.evidenceSetHash,
    });
    const memory = inMemoryStore(baseLedger);
    const begun = await beginInterpretations(memory.store, [{
      baseInterpretationKey,
      reviewerStableKey: canonicalE1.reviewerStableKey,
      lineageKey: canonicalE1.lineageKey,
      candidateEvidenceHash: canonicalE1.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonicalE1),
      promptPreconditions: [targetPrecondition],
    }], observation, 'completion-cas-round');
    const interpretationKey = begun.attemptByBaseKey.get(baseInterpretationKey)!.interpretationKey;
    const completed = await completeInterpretations(
      memory.store,
      new Map([[interpretationKey, {
        decision: 'create_independent',
        rawFindingId: canonicalE1.rawFindingId,
      }]]),
      begun.ownedByKey,
      new Map([[
        interpretationKey,
        canonicalRawIntegrityDigestOf(canonicalE2),
      ]]),
      observation,
      'completion-cas-round',
    );
    expect(completed.get(interpretationKey)?.decision).toBe('provisional');
    expect(memory.current().interpretations[0]).toMatchObject({
      stage: 'interpretation_completed',
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonicalE2),
      validatedDecision: {
        decision: 'provisional',
      },
    });
  });
});
