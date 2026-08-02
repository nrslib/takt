import { describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import { findingContentAddress } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import type {
  ProductFindingProjection,
  TerminalAdjudicationAttempt,
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationEpisode,
} from '../core/models/finding-contract-types.js';
import type {
  EngineProofRecord,
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingLifecycleEvent,
} from '../core/workflow/findings/types.js';
import {
  createTerminalAdjudicationRound,
  selectActiveTerminalAdjudicationEpisode,
} from '../core/workflow/findings/terminal-adjudication-model.js';
import { resolveTerminalAdjudicationPlan } from '../core/workflow/findings/terminal-adjudication-verifier.js';
import {
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-terminal',
  stepName: 'findings-terminal-adjudication',
  timestamp: '2026-08-02T00:00:00.000Z',
};

const VERIFIER_CONTEXT = {
  workflowTask: 'Fix terminal finding handling.',
  findingContractDigest: 'a'.repeat(64),
  reviewScopeSnapshotId: 'b'.repeat(64),
  adjudicationTaskId: 'terminal-attempt-1',
};

function findingHead(revision = 1): FindingLifecycleEntityHead {
  return {
    entityKind: 'finding',
    entityId: 'F-0001',
    revision,
    eventId: `event-F-0001-${revision}`,
    projectionDigest: `projection-F-0001-${revision}`,
  };
}

function lifecycleEvent(after: FindingLifecycleEntityHead): FindingLifecycleEvent {
  return {
    eventId: after.eventId,
    mutationId: `mutation-${after.eventId}`,
    reservationId: `reservation-${after.eventId}`,
    operation: 'update_provisional',
    transitions: [{ before: null, after }],
    evidenceBindingIds: [],
    outcome: { kind: 'projection_applied' },
    resultDigest: `result-${after.eventId}`,
    occurredAt: OBSERVATION,
  };
}

const SOURCE_RAW = canonicalRawFindingFixture({
  rawFindingId: 'raw-terminal-1',
  stepName: 'reviewer',
  reviewer: 'reviewer',
  familyTag: 'bug',
  severity: 'high',
  title: 'Terminal candidate',
  description: 'A durable claim requires terminal adjudication.',
  suggestion: 'Preserve it until verified.',
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/terminal.ts'] },
  evidence: [],
});
const RAW_SNAPSHOT = rawCanonicalSnapshotFixture(SOURCE_RAW, OBSERVATION);

function candidate(expectedHead = findingHead()): TerminalAdjudicationCandidateSnapshot {
  return {
    candidateSnapshotDigest: 'candidate-snapshot-1',
    findingId: 'F-0001',
    expectedHead,
    provisionalKind: 'raw-meaning-ambiguous',
    provisionalStableKey: 'stable-key-1',
    lineageKey: 'lineage-key-1',
    sourceClaims: [{
      sourceClaimRefId: 'source-claim-ref-1',
      rawFindingId: SOURCE_RAW.rawFindingId,
      rawCanonicalSnapshotId: RAW_SNAPSHOT.rawCanonicalSnapshotId,
      rawPayloadDigest: RAW_SNAPSHOT.rawPayloadDigest,
      provenanceEventId: expectedHead.eventId,
    }],
    targetCandidates: [],
  };
}

function episode(expectedHead = findingHead()): TerminalAdjudicationEpisode {
  return {
    episodeId: 'terminal-episode-1',
    selectionId: 'terminal-selection-1',
    roundIdentity: 'round-1',
    findingId: 'F-0001',
    expectedHead,
    candidateSnapshotDigest: 'candidate-snapshot-1',
    maxAttempts: 2,
    createdAt: OBSERVATION,
  };
}

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [SOURCE_RAW],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [lifecycleEvent(findingHead())],
    ...createEmptyFindingContractRegistries(),
    rawCanonicalSnapshots: [RAW_SNAPSHOT],
    ...overrides,
  };
}

function product(): ProductFindingProjection {
  const target = SOURCE_RAW.target;
  const base = {
    target,
    familyTag: SOURCE_RAW.familyTag ?? 'bug',
    severity: SOURCE_RAW.severity ?? 'high',
    title: SOURCE_RAW.title ?? 'Terminal candidate',
    description: SOURCE_RAW.description ?? 'Terminal candidate description',
    suggestion: SOURCE_RAW.suggestion,
  };
  return {
    ...base,
    targetIdentityHash: computeTargetIdentityHash(target),
    claimIdentityHash: computeClaimIdentityHash(base),
    semanticClaimIdentityHash: computeSemanticClaimIdentityHash(base),
    evidenceRecordIds: [],
  };
}

function proof(subject: EngineProofRecord['subject']): EngineProofRecord {
  return {
    evidenceId: 'proof-record-1',
    proofId: 'proof-1',
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    claimIdentityHash: null,
    verifierId: 'fixture-verifier',
    verifierVersion: '1',
    workflowName: 'peer-review',
    runId: OBSERVATION.runId,
    scopeIdentity: 'scope-1',
    snapshotId: 'snapshot-1',
    targetFindingId: 'F-0001',
    dependencyDigests: [],
    resultDigest: 'result-1',
    issuedAt: OBSERVATION.timestamp,
    subject,
  } as EngineProofRecord;
}

describe('terminal adjudication durable contract', () => {
  it('persists one deterministic selection and reuses it after resume', () => {
    const first = createTerminalAdjudicationRound({
      ledger: ledger(),
      roundIdentity: 'round-1',
      candidates: [candidate()],
      selectedAt: OBSERVATION,
    });
    const resumedLedger = ledger({
      terminalAdjudicationRounds: [first.round],
      terminalAdjudicationEpisodes: first.episodes,
    });
    const resumed = createTerminalAdjudicationRound({
      ledger: resumedLedger,
      roundIdentity: 'round-1',
      candidates: [],
      selectedAt: { ...OBSERVATION, timestamp: '2026-08-02T00:01:00.000Z' },
    });
    expect(resumed).toEqual(first);
  });

  it('processes the second terminal candidate after the first episode completes', () => {
    const secondCandidate: TerminalAdjudicationCandidateSnapshot = {
      ...candidate(),
      candidateSnapshotDigest: 'candidate-snapshot-2',
      findingId: 'F-0002',
      expectedHead: {
        ...findingHead(),
        entityId: 'F-0002',
        eventId: 'event-F-0002-1',
        projectionDigest: 'projection-F-0002-1',
      },
      provisionalStableKey: 'stable-key-2',
      lineageKey: 'lineage-key-2',
    };
    const planned = createTerminalAdjudicationRound({
      ledger: ledger(),
      roundIdentity: 'round-two-candidates',
      candidates: [candidate(), secondCandidate],
      selectedAt: OBSERVATION,
    });
    const firstEpisode = planned.episodes[0]!;
    const completedAttempt: TerminalAdjudicationAttempt = {
      attemptId: 'terminal-attempt-completed',
      episodeId: firstEpisode.episodeId,
      selectionId: firstEpisode.selectionId,
      roundIdentity: firstEpisode.roundIdentity,
      findingId: firstEpisode.findingId,
      expectedHead: firstEpisode.expectedHead,
      candidateSnapshotDigest: firstEpisode.candidateSnapshotDigest,
      attemptOrdinal: 1,
      retryOrdinal: 0,
      providerCallId: 'provider-call-completed',
      requestDigest: 'request-completed',
      sourceClaimRefIds: ['source-claim-ref-1'],
      stage: 'completed',
      startedAt: OBSERVATION,
      completedAt: OBSERVATION,
      result: {
        kind: 'diagnostic_undetermined',
        code: 'provider_failed',
        responseDigest: null,
        diagnosticDigest: 'diagnostic-completed',
      },
    };
    const resumed = ledger({
      terminalAdjudicationRounds: [planned.round],
      terminalAdjudicationEpisodes: planned.episodes,
      terminalAdjudicationAttempts: [completedAttempt],
    });

    expect(selectActiveTerminalAdjudicationEpisode(resumed)?.episodeId)
      .toBe(planned.episodes[1]!.episodeId);
  });

  it('promotes saved raw evidence only with an exactly bound positive proof', () => {
    const projection = product();
    const projectionDigest = findingContentAddress('product-finding-projection', { ...projection });
    const positive = proof({
      kind: 'finding_claim_supported_after_verification',
      adjudicationKind: 'terminal',
      subjectId: candidate().candidateSnapshotDigest,
      findingId: 'F-0001',
      expectedHead: findingHead(),
      rawClaimRefIds: ['source-claim-ref-1'],
      productProjectionDigest: projectionDigest,
    });
    const proposal = {
      kind: 'promote_independent' as const,
      proposedProduct: projection,
      authorityRefIds: [positive.evidenceId],
    };
    const plan = resolveTerminalAdjudicationPlan({
      ledger: ledger({ evidenceRecords: [positive] }),
      episode: episode(),
      candidate: candidate(),
      proposal,
      ...VERIFIER_CONTEXT,
    });
    expect(plan).toMatchObject({
      kind: 'promote_independent',
      authority: {
        kind: 'promote_independent',
        findingId: 'F-0001',
        sourceClaimRefIds: ['source-claim-ref-1'],
        productProjectionDigest: projectionDigest,
        proofRecordIds: ['proof-record-1'],
      },
    });
  });

  it('rejects a positive landing when referenced evidence is not currently stored', () => {
    const proposedProduct = { ...product(), evidenceRecordIds: ['missing-evidence'] };
    const plan = resolveTerminalAdjudicationPlan({
      ledger: ledger(),
      episode: episode(),
      candidate: candidate(),
      proposal: {
        kind: 'promote_independent',
        proposedProduct,
        authorityRefIds: ['missing-proof'],
      },
      ...VERIFIER_CONTEXT,
    });
    expect(plan).toEqual({ kind: 'undetermined', reasonCodes: ['positive_evidence_not_current'] });
  });

  it('requires an exactly bound terminal proof before dismissing a claim-bearing provisional', () => {
    const proposal = {
      kind: 'dismiss' as const,
      basis: 'no_issue_after_verification' as const,
      authorityRefIds: ['proof-record-1'],
    };
    expect(resolveTerminalAdjudicationPlan({
      ledger: ledger(),
      episode: episode(),
      candidate: candidate(),
      proposal,
      ...VERIFIER_CONTEXT,
    })).toEqual({ kind: 'undetermined', reasonCodes: ['authority_not_found'] });

    const verified = proof({
      kind: 'finding_no_issue_after_verification',
      adjudicationKind: 'terminal',
      subjectId: candidate().candidateSnapshotDigest,
      findingId: 'F-0001',
      expectedHead: findingHead(),
      rawClaimRefIds: ['source-claim-ref-1'],
    });
    expect(resolveTerminalAdjudicationPlan({
      ledger: ledger({ evidenceRecords: [verified] }),
      episode: episode(),
      candidate: candidate(),
      proposal,
      ...VERIFIER_CONTEXT,
    })).toMatchObject({
      kind: 'dismiss',
      authority: {
        kind: 'dismiss',
        findingId: 'F-0001',
        proofRecordIds: ['proof-record-1'],
      },
    });
  });

  it('fails closed when the episode head is stale', () => {
    const stale = findingHead(2);
    const plan = resolveTerminalAdjudicationPlan({
      ledger: ledger({ lifecycleEvents: [lifecycleEvent(stale)] }),
      episode: episode(),
      candidate: candidate(),
      proposal: { kind: 'undetermined' },
      ...VERIFIER_CONTEXT,
    });
    expect(plan).toEqual({ kind: 'undetermined', reasonCodes: ['head_not_fresh'] });
  });
});
