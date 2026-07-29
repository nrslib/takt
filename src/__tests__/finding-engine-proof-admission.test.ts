import { describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
} from '../core/models/finding-claim-identity.js';
import type {
  FindingLedger,
  FindingTarget,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  issueFindingEvidenceRequests,
} from '../core/workflow/findings/evidence-request-issuer.js';
import {
  evaluateRawAdmission,
  type ReviewerIntakeResult,
} from '../core/workflow/findings/manager-admission.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import type {
  ReviewScopeProofSnapshot,
} from '../core/workflow/findings/snapshot.js';
import {
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

const snapshotId = 'a'.repeat(64);
const workflowTask = 'Remove legacyApi under src and keep package.json present.';
const completeSnapshot: ReviewScopeProofSnapshot = {
  reviewScopeSnapshotId: snapshotId,
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [{
    path: 'package.json',
    kind: 'file',
    contentDigest: 'b'.repeat(64),
    content: Buffer.from('{"name":"fixture"}\n'),
    coverage: 'complete',
  }, {
    path: 'src/current.ts',
    kind: 'file',
    contentDigest: 'c'.repeat(64),
    content: Buffer.from('export const currentApi = true;\n'),
    coverage: 'complete',
  }],
};

function emptyLedger(
  evidenceRecords: FindingLedger['evidenceRecords'] = [],
): FindingLedger {
  return {
    workflowName: 'workflow',
    nextId: 1,
    updatedAt: '2026-07-29T00:00:00.000Z',
    findings: [],
    evidenceRecords,
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  };
}

function claim(target: FindingTarget) {
  return {
    target,
    familyTag: 'compatibility',
    severity: 'high' as const,
    title: 'Required repository state',
    description: 'The repository must satisfy the declared state.',
    suggestion: null,
  };
}

function rawWithEvidence(input: {
  target: FindingTarget;
  evidence: RawFinding['evidence'];
}): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId: 'raw-1',
    stepName: 'review',
    reviewer: 'reviewer',
    ...claim(input.target),
    relation: 'new',
    targetFindingId: null,
    evidence: input.evidence,
  });
}

function intakeFor(
  ledger: FindingLedger,
  raw: RawFinding,
): ReviewerIntakeResult {
  const canonical = canonicalizeReviewerRawFinding(
    candidateFromStoredRawFinding(raw, 'reviewer-stable'),
    { ledger },
  ).canonical;
  return {
    items: [{
      canonical,
      wire: toLedgerRawFinding(canonical),
    }],
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(['reviewer-stable']),
  };
}

function evaluate(input: {
  snapshot: ReviewScopeProofSnapshot;
  ledger: FindingLedger;
  raw: RawFinding;
}) {
  return evaluateRawAdmission({
    cwd: process.cwd(),
    reviewScopeSnapshotId: snapshotId,
    runId: 'run',
    scopeIdentity: 'scope',
    previousLedger: input.ledger,
    intake: intakeFor(input.ledger, input.raw),
    reviewScopeSnapshot: input.snapshot,
    workflowTask,
  });
}

function issue(input: {
  snapshot?: ReviewScopeProofSnapshot;
  target: FindingTarget;
  requests: Parameters<typeof issueFindingEvidenceRequests>[1]['requests'];
}) {
  const claimIdentityHash = computeClaimIdentityHash(claim(input.target));
  return issueFindingEvidenceRequests({
    snapshot: input.snapshot ?? completeSnapshot,
    workflowName: 'workflow',
    runId: 'run',
    scopeIdentity: 'scope',
    workflowTask,
    issuedAt: '2026-07-29T00:00:00.000Z',
  }, {
    target: input.target,
    claimIdentityHash,
    targetFindingId: null,
    requests: input.requests,
  });
}

describe('engine proof admission', () => {
  it('admits absence only with a complete query proof and authoritative task quote', () => {
    const target: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['src'],
        literal: 'legacyApi',
        textDomain: 'utf8',
      },
    };
    const issued = issue({
      target,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }, {
        kind: 'engine_proof',
        subject: {
          kind: 'authoritative_quote',
          source: 'task',
          declarationId: 'workflow_task',
          verbatimExcerpt: 'Remove legacyApi',
        },
      }],
    });
    const ledger = emptyLedger(issued.engineProofRecords);
    const admission = evaluate({
      snapshot: completeSnapshot,
      ledger,
      raw: rawWithEvidence({ target, evidence: issued.evidence }),
    });

    expect(issued.coverageGaps).toEqual([]);
    expect(admission.cleanWire).toHaveLength(1);
    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.verifiedEvidenceRecordsByRawFindingId.get('raw-1'))
      .toHaveLength(2);
  });

  it('keeps a complete zero result provisional when the authoritative quote is missing', () => {
    const target: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'path_state',
        path: 'src/removed.ts',
        expected: 'absent',
      },
    };
    const issued = issue({
      target,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });
    const ledger = emptyLedger(issued.engineProofRecords);
    const admission = evaluate({
      snapshot: completeSnapshot,
      ledger,
      raw: rawWithEvidence({ target, evidence: issued.evidence }),
    });

    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
  });

  it('turns excluded or capped query coverage into a gap, never a zero proof', () => {
    const target: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['src'],
        literal: 'legacyApi',
        textDomain: 'utf8',
      },
    };
    const incompleteSnapshot: ReviewScopeProofSnapshot = {
      ...completeSnapshot,
      queryInventory: completeSnapshot.queryInventory.map((entry) => (
        entry.path === 'src/current.ts'
          ? { ...entry, coverage: 'resource_cap' as const }
          : entry
      )),
    };
    const issued = issue({
      snapshot: incompleteSnapshot,
      target,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });
    const ledger = emptyLedger(issued.engineProofRecords);
    const admission = evaluate({
      snapshot: incompleteSnapshot,
      ledger,
      raw: rawWithEvidence({ target, evidence: issued.evidence }),
    });

    expect(issued.engineProofRecords).toEqual([]);
    expect(issued.coverageGaps).toEqual([
      'query coverage gap at "src/current.ts" (resource_cap)',
    ]);
    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
  });

  it('admits a complete repository manifest proof for a structure target', () => {
    const target: FindingTarget = {
      kind: 'structure',
      scope: {
        kind: 'review_scope',
        roots: ['.'],
      },
      manifestTargets: ['package.json'],
    };
    const issued = issue({
      target,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_manifest' },
      }],
    });
    const ledger = emptyLedger(issued.engineProofRecords);
    const admission = evaluate({
      snapshot: completeSnapshot,
      ledger,
      raw: rawWithEvidence({ target, evidence: issued.evidence }),
    });

    expect(admission.cleanWire).toHaveLength(1);
    expect(admission.verifiedEvidenceRecordsByRawFindingId.get('raw-1')?.[0])
      .toMatchObject({
        kind: 'engine_proof',
        purpose: 'claim_evidence',
        subject: { kind: 'repository_manifest' },
      });
  });

  it('re-verifies query dependencies against the supplied immutable snapshot', () => {
    const target: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'path_state',
        path: 'src/removed.ts',
        expected: 'absent',
      },
    };
    const issued = issue({
      target,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }, {
        kind: 'engine_proof',
        subject: {
          kind: 'authoritative_quote',
          source: 'task',
          declarationId: 'workflow_task',
          verbatimExcerpt: 'Remove legacyApi',
        },
      }],
    });
    const ledger = emptyLedger(issued.engineProofRecords);
    const changedSnapshot: ReviewScopeProofSnapshot = {
      ...completeSnapshot,
      queryInventory: [...completeSnapshot.queryInventory, {
        path: 'src/removed.ts',
        kind: 'file',
        contentDigest: 'd'.repeat(64),
        content: Buffer.from('export {};\n'),
        coverage: 'complete',
      }],
    };
    const admission = evaluate({
      snapshot: changedSnapshot,
      ledger,
      raw: rawWithEvidence({ target, evidence: issued.evidence }),
    });

    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
  });

  it('isolates an unregistered proof reference as unresolved evidence', () => {
    const target: FindingTarget = {
      kind: 'structure',
      scope: {
        kind: 'review_scope',
        roots: ['.'],
      },
      manifestTargets: ['package.json'],
    };
    const ledger = emptyLedger();
    const admission = evaluate({
      snapshot: completeSnapshot,
      ledger,
      raw: rawWithEvidence({
        target,
        evidence: [{ kind: 'engine_proof', proofId: 'f'.repeat(64) }],
      }),
    });

    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
    expect(admission.admissionAnomalySpecs).toEqual([]);
  });
});
