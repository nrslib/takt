import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { evaluateRawAdmission, type ReviewerIntakeResult } from '../core/workflow/findings/manager-admission.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  projectReviewerRawFindingItems,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { issuePathAbsentEngineProof } from '../core/workflow/findings/path-absent-engine-proof.js';
import { buildFindingManagerCommitMutation } from '../core/workflow/findings/manager-commit-plan.js';
import { resolveReviewIntegrityLimits } from '../core/workflow/findings/review-integrity.js';
import { resolveStopBudgetLimits } from '../core/workflow/findings/stop-budget.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  ReviewerRawFinding,
} from '../core/workflow/findings/types.js';
import type {
  LadderResult,
  RunFindingManagerForStepInput,
} from '../core/workflow/findings/manager-contracts.js';

const SNAPSHOT_ID = '1'.repeat(64);
const RUN_ID = 'run-1';
const SCOPE_IDENTITY = 'ledger-identity';
const OBSERVATION = {
  runId: RUN_ID,
  stepName: 'reviewers',
  timestamp: '2026-07-28T00:00:00.000Z',
};
const temporaryDirectories: string[] = [];

function ledgerWithTarget(): FindingLedger {
  return {
    workflowName: 'default',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
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
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
    }],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  };
}

function intakeFor(
  ledger: FindingLedger,
  rawFindings: readonly unknown[],
): ReviewerIntakeResult {
  const candidates = createReviewerRawFindingCandidates(rawFindings, {
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: RUN_ID,
    reviewerStepName: 'reviewer',
    reviewerPersonaKey: 'reviewer',
  });
  return {
    items: candidates.map((candidate) => {
      const { canonical } = canonicalizeReviewerRawFinding(candidate, { ledger });
      return { canonical, wire: toLedgerRawFinding(canonical) };
    }),
    overflowRawFindingIds: new Set(),
    overflowSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(['reviewer']),
  };
}

function evaluate(
  cwd: string,
  ledger: FindingLedger,
  intake: ReviewerIntakeResult,
) {
  return evaluateRawAdmission({
    cwd,
    reviewScopeSnapshotId: SNAPSHOT_ID,
    runId: RUN_ID,
    scopeIdentity: SCOPE_IDENTITY,
    previousLedger: ledger,
    intake,
  });
}

function emptyManagerOutput(): FindingManagerOutput {
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('engine proof admission authority', () => {
  it('audits the exact later quote that fails in a multi-quote evidence set', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-admission-later-quote-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'first\nsecond\n');
    const ledger = ledgerWithTarget();
    const failedExcerpt = 'not second';
    const admission = evaluate(cwd, ledger, intakeFor(ledger, [{
      rawFindingId: 'raw-multi-quote',
      familyTag: 'bug',
      severity: 'high',
      title: 'Multi quote claim',
      description: 'The later quote is stale.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      evidence: [
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'first',
          snapshotId: SNAPSHOT_ID,
        },
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 2,
          endLine: 2,
          verbatimExcerpt: failedExcerpt,
          snapshotId: SNAPSHOT_ID,
        },
      ],
    }]));

    expect(admission.admissionRejections[0]).toMatchObject({
      location: 'src/a.ts:2',
    });
    expect(admission.admissionRejectedItems[0]?.wire.evidence[1]).toMatchObject({
      path: 'src/a.ts',
      verbatimExcerpt: failedExcerpt,
    });
  });

  it('admits a registered path_absent proof from the fresh ledger registry', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-admission-'));
    temporaryDirectories.push(cwd);
    const raw = {
      rawFindingId: 'raw-proof',
      familyTag: 'absence',
      severity: 'high',
      title: 'Required file is absent',
      description: 'The required generated file does not exist.',
      suggestion: 'Generate the file.',
      relation: 'new',
      targetFindingId: null,
    } satisfies Omit<ReviewerRawFinding, 'evidence'>;
    const claimIdentityHash = computeClaimIdentityHash(raw);
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'generated/output.ts' },
      context: {
        cwd,
        workflowName: 'default',
        runId: RUN_ID,
        scopeIdentity: SCOPE_IDENTITY,
        snapshotId: SNAPSHOT_ID,
        claimIdentityHash,
        targetFindingId: null,
      },
      issuedAt: OBSERVATION.timestamp,
    });
    const ledger = {
      ...ledgerWithTarget(),
      evidenceRecords: [proof],
    };
    const admission = evaluate(cwd, ledger, intakeFor(ledger, [{
      ...raw,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
    }]));

    expect(admission.cleanWire).toHaveLength(1);
    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.admissionAnomalySpecs).toEqual([]);
    expect([...admission.verifiedEvidenceRecordsByRawFindingId.values()]).toEqual([[proof]]);
  });

  it('routes an unknown proof to provisional instead of reviewer anomaly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-unknown-'));
    temporaryDirectories.push(cwd);
    const ledger = ledgerWithTarget();
    const admission = evaluate(cwd, ledger, intakeFor(ledger, [{
      rawFindingId: 'raw-unknown',
      familyTag: 'absence',
      severity: 'high',
      title: 'Required file is absent',
      description: 'The required generated file does not exist.',
      suggestion: 'Generate the file.',
      relation: 'new',
      targetFindingId: null,
      evidence: [{ kind: 'engine_proof', proofId: '2'.repeat(64) }],
    }]));

    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
    expect(admission.admissionProvisionalSpecs[0]?.kind).toBe('raw-adjudication-unresolved');
    expect(admission.admissionAnomalySpecs).toEqual([]);
  });

  it('isolates malformed reviewer evidence as a protocol anomaly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-malformed-'));
    temporaryDirectories.push(cwd);
    const ledger = ledgerWithTarget();
    const projectedReviewerOutput = projectReviewerRawFindingItems([{
      rawFindingId: 'raw-malformed',
      familyTag: 'absence',
      severity: 'high',
      title: 'Required file is absent',
      description: 'The required generated file does not exist.',
      suggestion: 'Generate the file.',
      relation: 'new',
      targetFindingId: null,
      evidence: [{
        kind: 'engine_proof',
        proofId: '2'.repeat(64),
        reviewerClaimedVerifier: 'path_absent',
      }],
    }]);
    const intake = intakeFor(ledger, projectedReviewerOutput);

    expect(intake.items[0]?.canonical.provenance.ambiguityCodes)
      .toContain('invalid-evidence-shape');

    const admission = evaluate(cwd, ledger, intake);

    expect(admission.cleanWire).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.admissionAnomalySpecs).toHaveLength(1);
    expect(admission.admissionAnomalySpecs[0]?.kind).toBe('protocol-anomaly');
  });

  it('does not reinterpret malformed persists evidence as a rejected target observation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-malformed-persists-'));
    temporaryDirectories.push(cwd);
    const ledger = ledgerWithTarget();
    const intake = intakeFor(ledger, projectReviewerRawFindingItems([{
      rawFindingId: 'raw-malformed-persists',
      familyTag: 'existing',
      severity: 'high',
      title: 'Existing issue remains',
      description: 'The issue is still present.',
      suggestion: 'Fix it.',
      relation: 'persists',
      targetFindingId: 'F-0001',
      evidence: [{
        kind: 'engine_proof',
        proofId: '3'.repeat(64),
        reviewerClaimedVerifier: 'path_absent',
      }],
    }]));

    const admission = evaluate(cwd, ledger, intake);

    expect(admission.pendingRejectedObservations).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.admissionAnomalySpecs).toHaveLength(1);
    expect(admission.admissionAnomalySpecs[0]?.kind).toBe('protocol-anomaly');
  });

  it('re-verifies proof dependencies against the fresh ledger at commit time', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-commit-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'generated'));
    const raw = {
      rawFindingId: 'raw-commit',
      familyTag: 'absence',
      severity: 'high',
      title: 'Generated output is absent',
      description: 'The generated output is required.',
      suggestion: 'Generate the output.',
      relation: 'new',
      targetFindingId: null,
    } satisfies Omit<ReviewerRawFinding, 'evidence'>;
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'generated/output.ts' },
      context: {
        cwd,
        workflowName: 'default',
        runId: RUN_ID,
        scopeIdentity: SCOPE_IDENTITY,
        snapshotId: SNAPSHOT_ID,
        claimIdentityHash: computeClaimIdentityHash(raw),
        targetFindingId: null,
      },
      issuedAt: OBSERVATION.timestamp,
    });
    const ledger = {
      ...ledgerWithTarget(),
      evidenceRecords: [proof],
    };
    const intake = intakeFor(ledger, [{
      ...raw,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
    }]);
    const initialAdmission = evaluate(cwd, ledger, intake);
    expect(initialAdmission.cleanWire).toHaveLength(1);

    writeFileSync(join(cwd, 'generated/output.ts'), 'export {};\n');
    const managerOutput = emptyManagerOutput();
    const input = {
      contract: {},
      cwd,
      ledgerStore: {
        runId: RUN_ID,
        ledgerIdentity: SCOPE_IDENTITY,
      },
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: {
        kind: 'agent',
        name: 'reviewers',
        persona: 'reviewer',
        edit: false,
      },
      stepIteration: 1,
      subResults: [],
      workflowName: 'default',
      runId: RUN_ID,
      callNamespace: '',
      timestamp: OBSERVATION.timestamp,
    } as RunFindingManagerForStepInput;
    const mutation = buildFindingManagerCommitMutation({
      input,
      previousLedger: ledger,
      intake,
      interpretationRecoveryFailures: [],
      admission: initialAdmission,
      managerDecision: {
        managerOutput,
        invalidAttempts: [],
        cleanProvisionalSpecs: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        ladder: {
          interpretationReservations: new Map(),
          interpretationIntegrityDigests: new Map(),
          integrityStaleInterpretationKeys: new Set(),
          deferredRawFindingIds: new Set(),
          pendingSameWithProof: [],
          pendingIndependentNew: [],
          pendingConflicts: [],
          provisionalSpecs: [],
          provisionalByInterpretationKey: new Map(),
          pendingAppliedReattach: [],
          recoveryProvisionalOrigins: new Map(),
          stats: {
            ambiguousRawCount: 0,
            managerCalls: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            reusedCompletedDecisions: 0,
            interruptedInterpretations: 0,
            budgetExhaustedLineages: 0,
          },
        } satisfies LadderResult,
        rawRecovery: {
          intake: intakeFor(ledger, []),
          output: managerOutput,
          origins: new Map(),
          failures: new Map(),
          capturedPreconditions: new Map(),
          invalidAttempts: [],
          unsupportedRawFindingReports: [],
          cleanWireById: new Map(),
          cleanCanonicalById: new Map(),
          reservationTokens: new Set(),
        },
      },
      observation: OBSERVATION,
      stopBudgetLimits: resolveStopBudgetLimits(undefined),
      stopBudgetRoundMarker: 'round-proof-commit',
      reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
      reviewScopeSnapshotId: SNAPSHOT_ID,
    }, ledger);

    expect(mutation.result.applied).toBe(true);
    expect(mutation.result.admissionRejections).toHaveLength(1);
    expect(mutation.ledger.findings.some(
      (finding) => finding.provisional?.kind === 'raw-adjudication-unresolved',
    )).toBe(true);
    expect(mutation.ledger.findings.find((finding) => finding.id === 'F-0001')?.revision).toBe(1);
  });

  it.each(['persists', 'reopened'] as const)(
    'rejects tainted empty evidence for %s without mutating the target',
    (relation) => {
      const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-empty-'));
      temporaryDirectories.push(cwd);
      const ledger = ledgerWithTarget();
      const intake = intakeFor(ledger, [{
        rawFindingId: `raw-${relation}`,
        severity: 'high',
        title: 'Existing issue remains',
        description: 'The issue is still present.',
        suggestion: 'Fix it.',
        relation,
        targetFindingId: 'F-0001',
        evidence: [],
      }]);
      expect(intake.items[0]?.canonical.provenance.ambiguityOrigin).toBe(true);

      const admission = evaluate(cwd, ledger, intake);

      expect(admission.taintedAdmitted).toEqual([]);
      expect(admission.admissionProvisionalSpecs).toHaveLength(1);
      expect(admission.admissionAnomalySpecs).toEqual([]);
      expect(ledger.findings[0]?.revision).toBe(1);
    },
  );

  it('does not downgrade verified engine proof evidence because of its evidence kind', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-proof-tainted-'));
    temporaryDirectories.push(cwd);
    const title = 'Existing issue remains';
    const description = 'The issue is still present.';
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'required-marker.ts' },
      context: {
        cwd,
        workflowName: 'default',
        runId: RUN_ID,
        scopeIdentity: SCOPE_IDENTITY,
        snapshotId: SNAPSHOT_ID,
        claimIdentityHash: computeClaimIdentityHash({
          title,
          description,
          targetFindingId: 'F-0001',
        }),
        targetFindingId: 'F-0001',
      },
      issuedAt: OBSERVATION.timestamp,
    });
    const ledger = {
      ...ledgerWithTarget(),
      evidenceRecords: [proof],
    };
    const intake = intakeFor(ledger, [{
      rawFindingId: 'raw-tainted-proof',
      severity: 'high',
      title,
      description,
      suggestion: 'Fix it.',
      relation: 'persists',
      targetFindingId: 'F-0001',
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
    }]);
    expect(intake.items[0]?.canonical.provenance.ambiguityOrigin).toBe(true);

    const admission = evaluate(cwd, ledger, intake);

    expect(admission.taintedAdmitted).toHaveLength(1);
    expect(admission.verifiedEvidenceCandidates).toHaveLength(1);
    expect(admission.provisionalOnlyLadderRawIds).toEqual(new Set());
  });
});
