import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/workflow/findings/snapshot.js', () => ({
  computeReviewScopeSnapshotId: () => 'snapshot',
}));

vi.mock('../core/workflow/findings/admission-validation.js', async () => {
  const actual = await vi.importActual<typeof import('../core/workflow/findings/admission-validation.js')>(
    '../core/workflow/findings/admission-validation.js',
  );
  return {
    ...actual,
    verifyFileQuoteEvidence: () => ({ outcome: 'unverifiable', reason: 'injected EIO' }),
    validateLocationAdmission: () => ({ ok: false, outcome: 'unverifiable', reason: 'injected EIO' }),
  };
});

import {
  createFindingEvidenceBinding,
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { computeInvalidLocationCandidates } from '../core/workflow/findings/manager-utils.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import {
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import {
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
} from './helpers/finding-lifecycle-fixture.js';

function makeLedger(): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-07-17T00:00:00.000Z',
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: 'Existing issue',
      evidenceIds: [],
      reviewers: ['reviewer'],
      rawFindingIds: [],
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
    }],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [{
      id: 'C-FA2947446963',
      status: 'active',
      revision: 1,
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'disputed',
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
    }],
    interpretations: [],
    ...emptyFindingAuthorityProjection(),
  });
}

describe('unverifiable propagation', () => {
  it('manager admission は file quote の検証不能を anomaly に変換せず停止する', () => {
    const ledger = makeLedger();
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-1',
      relation: 'new',
      title: 'New issue',
      description: 'description',
      suggestion: null,
      severity: 'high',
      familyTag: 'bug',
      targetFindingId: null,
      evidence: [{
        kind: 'file_quote',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'const value = 1;',
        snapshotId: '1'.repeat(64),
      }],
    }], {
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-1',
      reviewerStepName: 'reviewer',
      reviewerPersonaKey: 'reviewer',
    });
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger });

    expect(() => evaluateRawAdmission({
      cwd: '/project',
      reviewScopeSnapshotId: 'snapshot',
      previousLedger: ledger,
      intake: {
        items: [{ canonical, wire: toLedgerRawFinding(canonical) }],
        overflowRawFindingIds: new Set(),
        overflowSpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set(),
      },
    })).toThrow(/could not be verified: injected EIO/);
    expect(ledger.findings[0]?.status).toBe('open');
  });

  it('manager の invalidate 候補へ検証不能な open finding を入れない', () => {
    const ledger = makeLedger();

    expect(computeInvalidLocationCandidates('/project', ledger)).toEqual(new Map());
    expect(ledger.findings[0]?.status).toBe('open');
  });

  it('adjudication commit 境界は存在しない evidence binding を拒否して状態を変更しない', () => {
    const ledger = makeLedger();
    const before = structuredClone(ledger);
    const target = {
      entityKind: 'conflict' as const,
      entityId: 'C-FA2947446963',
      expectedHead: captureFindingLifecycleHead(
        ledger,
        'conflict',
        'C-FA2947446963',
      )!,
    };
    const findingTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: captureFindingLifecycleHead(
        ledger,
        'finding',
        'F-0001',
      )!,
    };
    const evidenceHash = '1'.repeat(64);
    const binding = createFindingEvidenceBinding({
      evidenceId: '2'.repeat(64),
      claimIdentityHash: '3'.repeat(64),
      sourceRawFindingId: null,
      sourceRawIntegrityDigest: null,
      operation: 'apply_conflict_adjudication',
      target,
    });
    const reservation = createFindingLifecycleReservation({
      operation: 'apply_conflict_adjudication',
      targets: [target, findingTarget],
      evidenceBindingIds: [binding.bindingId],
      authority: {
        kind: 'conflict_adjudication',
        conflictId: target.entityId,
        findingIds: [findingTarget.entityId],
        evidenceHash,
        inputBindingIds: [binding.bindingId],
        originStep: 'finding-conflict-adjudication',
      },
      context: {
        kind: 'conflict_adjudication',
        conflictId: target.entityId,
        evidenceHash,
        originStep: 'finding-conflict-adjudication',
      },
      reservedAt: {
        runId: 'run-1',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-07-17T00:00:00.000Z',
      },
    });

    expect(() => reserveVerifiedLifecycleMutation(ledger, {
      reservation,
      evidenceBindings: [binding],
    })).toThrow(/references unknown evidence/);
    expect(ledger).toEqual(before);
  });
});
