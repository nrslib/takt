import { describe, expect, it } from 'vitest';
import {
  computeCandidateIdentityHash,
  computeClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import { FindingEvidenceRecordSchema } from '../core/models/finding-schemas.js';
import type {
  CandidateSourceBinding,
  FindingLedger,
  FindingTarget,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  computeEvidenceSetHash,
  createEngineProofVerifierRegistry,
  createLedgerEngineProofRegistry,
  deduplicateRawEvidence,
  verifyEngineProofEvidence,
} from '../core/workflow/findings/evidence-domain.js';
import {
  createSnapshotEngineProofVerifiers,
  issueFindingEvidenceRequests,
} from '../core/workflow/findings/evidence-request-issuer.js';
import { verifyFindingEvidenceSet } from '../core/workflow/findings/evidence-verification.js';
import { buildManagerInputLedger } from '../core/workflow/findings/manager-agent.js';
import type { ReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';

const snapshotId = 'a'.repeat(64);
const issuedAt = '2026-07-29T00:00:00.000Z';
const workflowTask = 'Remove legacyApi from every UTF-8 file under src.';
const snapshot: ReviewScopeProofSnapshot = {
  reviewScopeSnapshotId: snapshotId,
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [{
    path: 'src/current.ts',
    kind: 'file',
    contentDigest: 'b'.repeat(64),
    content: Buffer.from('export const currentApi = true;\n'),
    coverage: 'complete',
  }],
};
const target: FindingTarget = {
  kind: 'absence',
  predicate: {
    kind: 'exact_literal_search',
    roots: ['src'],
    literal: 'legacyApi',
    textDomain: 'utf8',
  },
};
const claimIdentityHash = computeClaimIdentityHash({
  target,
  familyTag: 'compatibility',
  severity: 'high',
  title: 'Legacy API remains required to be absent',
  description: 'The task requires legacyApi to be absent.',
  suggestion: null,
});

function emptyLedger(
  evidenceRecords: FindingLedger['evidenceRecords'] = [],
): FindingLedger {
  return {
    workflowName: 'workflow',
    nextId: 1,
    updatedAt: issuedAt,
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

function issueAbsenceEvidence() {
  return issueFindingEvidenceRequests({
    cwd: process.cwd(),
    snapshot,
    workflowName: 'workflow',
    runId: 'run',
    scopeIdentity: 'scope',
    workflowTask,
    issuedAt,
  }, {
    target,
    claimIdentityHash,
    targetFindingId: null,
    quoteByteBudget: {
      reviewerRemainingBytes: 256 * 1024,
      stepRemainingBytes: 512 * 1024,
    },
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
}

describe('finding evidence domain', () => {
  it('verifies query and authoritative-quote proofs through the general issuer registry', () => {
    const issued = issueAbsenceEvidence();
    const verification = verifyFindingEvidenceSet({
      cwd: process.cwd(),
      evidence: issued.evidence,
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(
        emptyLedger(issued.engineProofRecords),
      ),
      proofVerifiers: createEngineProofVerifierRegistry(
        createSnapshotEngineProofVerifiers({ snapshot, workflowTask }),
      ),
      proofContext: {
        cwd: process.cwd(),
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
      },
    });

    expect(issued.coverageGaps).toEqual([]);
    expect(verification).toMatchObject({ outcome: 'match' });
    expect(verification.outcome === 'match'
      ? verification.records.map((record) => (
          record.kind === 'engine_proof' ? record.subject.kind : record.kind
        ))
      : []).toEqual(['repository_query', 'authoritative_quote']);
  });

  it('rejects lifecycle authority when it is referenced as public claim evidence', () => {
    const record = createEngineProofRecord({
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      subject: {
        kind: 'finding_target_invalid',
        findingId: 'F-0001',
        reason: 'fixture invalid target',
      },
      dependencyDigests: [],
      resultDigest: 'c'.repeat(64),
      issuedAt,
    });
    const verification = verifyEngineProofEvidence(
      { kind: 'engine_proof', proofId: record.proofId },
      {
        cwd: process.cwd(),
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
        snapshotId,
        claimIdentityHash,
        targetFindingId: null,
      },
      createLedgerEngineProofRegistry(emptyLedger([record])),
      createEngineProofVerifierRegistry([{
        verifierId: record.verifierId,
        verifierVersion: record.verifierVersion,
        verify: () => ({
          outcome: 'evaluated',
          predicateSatisfied: true,
          dependencyDigests: record.dependencyDigests,
          resultDigest: record.resultDigest,
        }),
      }]),
    );

    expect(verification).toEqual({
      outcome: 'mismatch',
      reason: expect.stringContaining('purpose'),
    });
  });

  it('rejects null claim identity and lifecycle subjects in claim_evidence records', () => {
    const record = issueAbsenceEvidence().engineProofRecords[0]!;

    expect(() => FindingEvidenceRecordSchema.parse({
      ...record,
      claimIdentityHash: null,
    })).toThrow();
    expect(() => FindingEvidenceRecordSchema.parse({
      ...record,
      subject: {
        kind: 'finding_target_invalid',
        findingId: 'F-0001',
        reason: 'invalid target',
      },
    })).toThrow();
  });

  it('detects a proof whose stored body no longer matches its content address', () => {
    const issued = issueAbsenceEvidence();
    const record = issued.engineProofRecords[0]!;
    const tampered = {
      ...record,
      resultDigest: 'f'.repeat(64),
    };
    const verification = verifyEngineProofEvidence(
      { kind: 'engine_proof', proofId: record.proofId },
      {
        cwd: process.cwd(),
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
        snapshotId,
        claimIdentityHash,
        targetFindingId: null,
      },
      createLedgerEngineProofRegistry(emptyLedger([tampered])),
      createEngineProofVerifierRegistry(
        createSnapshotEngineProofVerifiers({ snapshot, workflowTask }),
      ),
    );

    expect(verification).toEqual({
      outcome: 'protocol-anomaly',
      reason: expect.stringContaining('canonical content address'),
    });
  });

  it('shows typed proof details and all three identities to the manager', () => {
    const issued = issueAbsenceEvidence();
    const sourceBinding: CandidateSourceBinding = {
      reportDigest: '1'.repeat(64),
      startByte: 8,
      endByte: 40,
      excerptDigest: '2'.repeat(64),
    };
    const raw: RawFinding = {
      rawFindingId: 'raw-1',
      stepName: 'review',
      reviewer: 'reviewer',
      familyTag: 'compatibility',
      severity: 'high',
      title: 'Legacy API remains required to be absent',
      description: 'The task requires legacyApi to be absent.',
      suggestion: null,
      target,
      targetIdentityHash: computeTargetIdentityHash(target),
      claimIdentityHash,
      candidateIdentityHash: computeCandidateIdentityHash({
        claimIdentityHash,
        sourceBinding,
      }),
      sourceBinding,
      relation: 'new',
      targetFindingId: null,
      evidence: issued.evidence,
    };
    const ledger: FindingLedger = {
      ...emptyLedger(issued.engineProofRecords),
      nextId: 2,
      rawFindings: [raw],
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target,
        targetIdentityHash: raw.targetIdentityHash,
        claimIdentityHash,
        severity: 'high',
        title: raw.title!,
        description: raw.description!,
        evidenceIds: issued.engineProofRecords.map((record) => record.evidenceId),
        reviewers: ['reviewer'],
        rawFindingIds: [raw.rawFindingId],
        firstSeen: { runId: 'run', stepName: 'review', timestamp: issuedAt },
        lastSeen: { runId: 'run', stepName: 'review', timestamp: issuedAt },
        revision: 1,
      }],
    };
    const manager = buildManagerInputLedger(ledger) as {
      findings: Array<{
        revision: number;
        targetIdentityHash: string;
        claimIdentityHash: string;
        rawFindings: Array<{
          candidateIdentityHash: string;
          sourceBinding: CandidateSourceBinding;
          evidenceDetails: Array<Record<string, unknown>>;
        }>;
        evidenceDetails: Array<Record<string, unknown>>;
      }>;
    };

    expect(manager.findings[0]).toMatchObject({
      revision: 1,
      targetIdentityHash: raw.targetIdentityHash,
      claimIdentityHash,
      rawFindings: [expect.objectContaining({
        candidateIdentityHash: raw.candidateIdentityHash,
        sourceBinding,
        evidenceDetails: expect.arrayContaining([
          expect.objectContaining({
            purpose: 'claim_evidence',
            subject: expect.objectContaining({ kind: 'repository_query' }),
            resultDigest: expect.any(String),
          }),
        ]),
      })],
      evidenceDetails: expect.arrayContaining([
        expect.objectContaining({
          purpose: 'claim_evidence',
          subject: expect.objectContaining({ kind: 'authoritative_quote' }),
        }),
      ]),
    });
  });

  it('deduplicates evidence by exact canonical payload and hashes only record identities', () => {
    const issued = issueAbsenceEvidence();
    const evidence = deduplicateRawEvidence([
      issued.evidence[1]!,
      issued.evidence[0]!,
      issued.evidence[1]!,
    ]);

    expect(evidence).toHaveLength(2);
    expect(computeEvidenceSetHash(
      issued.engineProofRecords.map((record) => record.evidenceId),
    )).toBe(computeEvidenceSetHash(
      [...issued.engineProofRecords].reverse().map((record) => record.evidenceId),
    ));
  });
});
