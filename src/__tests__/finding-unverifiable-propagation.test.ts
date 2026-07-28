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

import { applyFindingConflictAdjudication } from '../core/workflow/findings/adjudication-apply.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { computeInvalidLocationCandidates } from '../core/workflow/findings/manager-utils.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';

function makeLedger(): FindingLedger {
  return {
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
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'disputed',
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
    }],
    interpretations: [],
  };
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

  it('adjudication は resolved evidence の検証不能理由を保持して状態を変更しない', () => {
    const ledger = makeLedger();
    expect(() => applyFindingConflictAdjudication({
      ledger,
      output: {
        conflictId: 'C-FA2947446963',
        outcome: 'finding_stale',
        findingTransition: 'resolved',
        evidence: ['src/a.ts:1'],
        actionableFix: '',
      },
      evidenceHash: 'hash',
      cwd: '/project',
      context: {
        workflowName: 'peer-review',
        stepName: 'finding-conflict-adjudication',
        runId: 'run-1',
        timestamp: '2026-07-17T00:00:00.000Z',
      },
    })).toThrow(/could not be verified: injected EIO/);
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('active');
  });
});
