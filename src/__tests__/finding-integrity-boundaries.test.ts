import { describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
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
    updatedAt: observation.timestamp,
  });
}

function rawWithEvidence(
  targetPrecondition: NonNullable<RawFinding['targetPrecondition']>,
  explanation: string,
): RawFinding {
  return canonicalRawFindingFixture({
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
    target: { kind: 'code', paths: ['fixtures/F-0001.ts'] },
    targetPrecondition,
    evidence: [{
      kind: 'engine_proof',
      proofId: (explanation.endsWith('E1') ? '1' : '2').repeat(64),
    }],
  });
}


describe('finding integrity boundaries', () => {
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

});
