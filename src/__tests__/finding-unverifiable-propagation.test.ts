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
    verifySourceQuoteEvidence: () => ({ outcome: 'unverifiable', reason: 'injected EIO' }),
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
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-07-17T00:00:00.000Z',
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Existing issue',
      location: 'src/a.ts:1',
      reviewers: ['reviewer'],
      rawFindingIds: [],
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
    }],
    rawFindings: [],
    conflicts: [{
      id: 'C-0001',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'disputed',
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-17T00:00:00.000Z' },
    }],
  };
}

describe('unverifiable propagation', () => {
  it('manager admission は source quote の検証不能を anomaly に変換せず停止する', () => {
    const ledger = makeLedger();
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-1',
      relation: 'new',
      title: 'New issue',
      description: 'description',
      severity: 'high',
      familyTag: 'bug',
      location: 'src/a.ts:1',
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'const value = 1;',
      snapshotId: 'snapshot',
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

    expect(computeInvalidLocationCandidates('/project', ledger.findings)).toEqual(new Map());
    expect(ledger.findings[0]?.status).toBe('open');
  });

  it('adjudication は location 検証不能時に invalidated へ遷移しない', () => {
    const ledger = makeLedger();
    expect(() => applyFindingConflictAdjudication({
      ledger,
      output: {
        conflictId: 'C-0001',
        outcome: 'evidence_invalid',
        findingTransition: 'invalidated',
        evidence: ['invalid premise'],
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

  it('adjudication は resolved evidence の検証不能理由を保持して状態を変更しない', () => {
    const ledger = makeLedger();
    expect(() => applyFindingConflictAdjudication({
      ledger,
      output: {
        conflictId: 'C-0001',
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
