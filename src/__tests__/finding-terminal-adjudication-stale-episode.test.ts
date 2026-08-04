import { describe, expect, it } from 'vitest';
import {
  computeTerminalAttemptId,
  computeTerminalSettlementId,
  findingContentAddress,
} from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import {
  dispatchFindingManagerProviderCall,
  reserveFindingManagerProviderCall,
  settleFindingManagerProviderCall,
} from '../core/workflow/findings/finding-manager-provider-call.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { buildTerminalAdjudicationCandidateSnapshot } from '../core/workflow/findings/terminal-adjudication-candidates.js';
import { createTerminalAdjudicationRound } from '../core/workflow/findings/terminal-adjudication-model.js';
import { selectReconstructableTerminalEpisode } from '../core/workflow/findings/terminal-adjudication-runner.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import {
  applyFindingLedgerFixtureRevision,
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-stale-terminal-episode',
  stepName: 'findings-terminal-adjudication',
  timestamp: '2026-08-02T00:00:00.000Z',
};

function provisional(
  id: string,
  raw: ReturnType<typeof canonicalRawFindingFixture>,
): FindingLedgerEntry {
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    target: raw.target,
    targetIdentityHash: raw.targetIdentityHash,
    claimIdentityHash: raw.claimIdentityHash,
    semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
    severity: raw.severity,
    title: raw.title ?? `Provisional ${id}`,
    description: raw.description ?? undefined,
    evidenceIds: [],
    reviewers: ['reviewer'],
    rawFindingIds: [raw.rawFindingId],
    firstSeen: OBSERVATION,
    lastSeen: OBSERVATION,
    revision: 1,
    provisional: {
      kind: 'raw-meaning-ambiguous',
      stableKey: `stable-${id}`,
      lineageKey: `lineage-${id}`,
      sourceRawFindingIds: [raw.rawFindingId],
      reason: 'Requires terminal adjudication.',
      firstObservedAt: OBSERVATION,
      lastObservedAt: OBSERVATION,
      gateEffect: 'block',
      firstObservedRound: 1,
    },
  };
}

function withoutRevision(
  finding: FindingLedgerEntry,
): Omit<FindingLedgerEntry, 'revision'> {
  const { revision: _revision, ...change } = finding;
  void _revision;
  return change;
}

function landProvisional(
  ledger: FindingLedger,
  finding: FindingLedgerEntry,
): FindingLedger {
  const proof = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: ledger.workflowName,
    runId: OBSERVATION.runId,
    scopeIdentity: 'finding-storage:test:root',
    snapshotId: findingContentAddress('stale-terminal-scope', {}),
    claimIdentityHash: finding.claimIdentityHash,
    targetFindingId: null,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId: finding.id,
      provisionalKind: finding.provisional!.kind,
      stableKey: finding.provisional!.stableKey,
      claimBindingAuthorizationReferences: [],
    },
    dependencyDigests: [findingContentAddress('stale-terminal-absent-head', {
      findingId: finding.id,
    })],
    resultDigest: findingContentAddress('stale-terminal-isolation', {
      findingId: finding.id,
    }),
    issuedAt: OBSERVATION.timestamp,
  });
  return applyFindingLifecycleCommands({
    ledger: {
      ...ledger,
      evidenceRecords: [...ledger.evidenceRecords, proof],
    },
    commands: [{
      operation: 'update_provisional',
      changes: {
        findings: [{
          ...withoutRevision(finding),
          evidenceIds: [proof.evidenceId],
        }],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `finding\0${finding.id}`,
        {
          sourceRawFindingIds: [...finding.provisional!.sourceRawFindingIds],
          authorityEvidenceIds: [proof.evidenceId],
        },
      ]]),
    }],
    occurredAt: OBSERVATION,
  });
}

function initialLedger(options: { onlyB?: boolean } = {}): FindingLedger {
  const rawA = canonicalRawFindingFixture({
    rawFindingId: 'raw-a',
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'terminal',
    severity: 'medium',
    title: 'A',
    description: 'A',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/a.ts'] },
    evidence: [],
  });
  const rawB = canonicalRawFindingFixture({
    ...rawA,
    rawFindingId: 'raw-b',
    title: 'B',
    description: 'B',
    target: { kind: 'code', paths: ['src/b.ts'] },
  });
  const rawFindings = options.onlyB === true ? [rawB] : [rawA, rawB];
  const findings = options.onlyB === true
    ? [provisional('F-0002', rawB)]
    : [provisional('F-0001', rawA), provisional('F-0002', rawB)];
  let ledger: FindingLedger = {
    workflowName: 'stale-terminal-episode',
    nextId: 3,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings,
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
    rawCanonicalSnapshots: rawFindings.map((rawFinding) => (
      rawCanonicalSnapshotFixture(rawFinding, OBSERVATION)
    )),
  };
  for (const finding of findings) {
    ledger = landProvisional(ledger, finding);
  }
  return ledger;
}

function addInterruptedAttempt(input: {
  ledger: FindingLedger;
  episode: ReturnType<typeof createTerminalAdjudicationRound>['episodes'][number];
  candidate: ReturnType<typeof buildTerminalAdjudicationCandidateSnapshot>;
}): FindingLedger {
  if (input.candidate === undefined) {
    throw new Error('Interrupted attempt fixture requires a terminal candidate');
  }
  const attemptId = computeTerminalAttemptId({
    episodeId: input.episode.episodeId,
    attemptOrdinal: 1,
    retryOrdinal: 0,
  });
  const requestBytes = JSON.stringify({ episodeId: input.episode.episodeId });
  const reserved = reserveFindingManagerProviderCall({
    scopes: input.ledger.findingManagerProviderBudgetScopes,
    calls: input.ledger.findingManagerProviderCalls,
    scopeIdentity: findingContentAddress('terminal-scope', { attemptId }),
    workflowName: input.ledger.workflowName,
    roundMarker: input.episode.roundIdentity,
    limits: {
      maxCallsPerRound: 2,
      maxAdapterVisibleInputTokensPerCall: 1_000,
      maxOutputTokensPerCall: 1_000,
      maxChargedInputTokensPerRound: 2_000,
      maxChargedOutputTokensPerRound: 2_000,
    },
    purpose: 'terminal_adjudication',
    ownerAttemptKind: 'terminal_adjudication',
    attemptIds: [attemptId],
    requestBytes,
    adapterSupportsUtf8ByteUpperBound: true,
    reservedAt: OBSERVATION,
  });
  const dispatched = dispatchFindingManagerProviderCall({
    calls: reserved.calls,
    providerCallId: reserved.call.providerCallId,
    requestBytes,
    adapterSupportsUtf8ByteUpperBound: true,
    dispatchedAt: OBSERVATION,
  });
  const settled = settleFindingManagerProviderCall({
    calls: dispatched.calls,
    providerCallId: reserved.call.providerCallId,
    settledAt: OBSERVATION,
    resultKind: 'interrupted_unknown',
    failurePhase: 'provider_result_unknown',
  });
  return {
    ...input.ledger,
    findingManagerProviderBudgetScopes: reserved.scopes,
    findingManagerProviderCalls: settled.calls,
    terminalAdjudicationAttempts: [{
      attemptId,
      episodeId: input.episode.episodeId,
      selectionId: input.episode.selectionId,
      roundIdentity: input.episode.roundIdentity,
      findingId: input.episode.findingId,
      expectedHead: input.episode.expectedHead,
      candidateSnapshotDigest: input.episode.candidateSnapshotDigest,
      attemptOrdinal: 1,
      retryOrdinal: 0,
      providerCallId: reserved.call.providerCallId,
      requestDigest: reserved.call.requestDigest,
      sourceClaimRefIds: input.candidate.sourceClaims.map(({ sourceClaimRefId }) => sourceClaimRefId),
      stage: 'interrupted',
      startedAt: OBSERVATION,
      interruptedAt: OBSERVATION,
      reason: 'provider_result_unknown',
    }],
  };
}

describe('terminal adjudication stale episode settlement', () => {
  it('supersedes stale B episode and advances to the fresh B episode after A promotion', () => {
    let ledger = initialLedger();
    const candidates = ledger.findings.map((finding) => (
      buildTerminalAdjudicationCandidateSnapshot({ ledger, finding, currentRound: 2 })!
    ));
    const firstRound = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: findingContentAddress('terminal-round', { round: 1 }),
      candidates,
      selectedAt: OBSERVATION,
    });
    ledger = {
      ...ledger,
      terminalAdjudicationRounds: [firstRound.round],
      terminalAdjudicationEpisodes: firstRound.episodes,
    };
    const episodeA = firstRound.episodes.find(({ findingId }) => findingId === 'F-0001')!;
    const episodeBOld = firstRound.episodes.find(({ findingId }) => findingId === 'F-0002')!;
    ledger = {
      ...ledger,
      findings: ledger.findings.map((finding) => {
        if (finding.id !== 'F-0001') {
          return finding;
        }
        const { provisional: _provisional, ...promoted } = finding;
        void _provisional;
        return { ...promoted, lifecycle: 'persists' as const };
      }),
    };
    ledger = {
      ...ledger,
      terminalAdjudicationSettlements: [{
        settlementId: computeTerminalSettlementId(episodeA.episodeId),
        episodeId: episodeA.episodeId,
        provisionalFindingId: episodeA.findingId,
        expectedHead: episodeA.expectedHead,
        candidateSnapshotDigest: episodeA.candidateSnapshotDigest,
        outcome: 'superseded',
        reason: 'subject_no_longer_candidate',
        supersedingEpisodeId: null,
        supersedingCandidateSnapshotDigest: null,
        recordedAt: OBSERVATION,
      }],
    };
    const findingB = ledger.findings.find(({ id }) => id === 'F-0002')!;
    const candidateBNew = buildTerminalAdjudicationCandidateSnapshot({
      ledger,
      finding: findingB,
      currentRound: 3,
    })!;
    expect(candidateBNew.candidateSnapshotDigest).not.toBe(episodeBOld.candidateSnapshotDigest);
    const secondRound = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: findingContentAddress('terminal-round', { round: 2 }),
      candidates: [candidateBNew],
      selectedAt: OBSERVATION,
    });
    ledger = {
      ...ledger,
      terminalAdjudicationRounds: [...ledger.terminalAdjudicationRounds, secondRound.round],
      terminalAdjudicationEpisodes: [...ledger.terminalAdjudicationEpisodes, ...secondRound.episodes],
    };

    const selected = selectReconstructableTerminalEpisode({
      ledger,
      currentRound: 3,
      observation: OBSERVATION,
    });

    expect(selected.selected?.episode.episodeId).toBe(secondRound.episodes[0]!.episodeId);
    expect(selected.ledger.terminalAdjudicationSettlements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        episodeId: episodeBOld.episodeId,
        outcome: 'superseded',
        reason: 'candidate_snapshot_changed',
        supersedingEpisodeId: secondRound.episodes[0]!.episodeId,
      }),
    ]));
    expect(selected.ledger.findings.find(({ id }) => id === 'F-0002')).toMatchObject({
      status: 'open',
      provisional: expect.objectContaining({ stableKey: 'stable-F-0002' }),
    });
  });

  it('exhausts an interrupted stale episode and continues with the new digest episode', () => {
    let ledger = initialLedger({ onlyB: true });
    const candidates = ledger.findings.map((finding) => (
      buildTerminalAdjudicationCandidateSnapshot({ ledger, finding, currentRound: 2 })!
    ));
    const firstRound = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: findingContentAddress('terminal-round', { round: 'interrupted-1' }),
      candidates,
      selectedAt: OBSERVATION,
    });
    ledger = {
      ...ledger,
      terminalAdjudicationRounds: [firstRound.round],
      terminalAdjudicationEpisodes: firstRound.episodes,
    };
    const episodeBOld = firstRound.episodes.find(({ findingId }) => findingId === 'F-0002')!;
    const oldCandidateB = candidates.find(({ findingId }) => findingId === 'F-0002')!;
    ledger = addInterruptedAttempt({ ledger, episode: episodeBOld, candidate: oldCandidateB });
    const interruptedAttemptId = ledger.terminalAdjudicationAttempts[0]!.attemptId;

    const findingB = ledger.findings.find(({ id }) => id === 'F-0002')!;
    ledger = applyFindingLedgerFixtureRevision({
      ledger,
      entityKind: 'finding',
      entity: {
        ...findingB,
        revision: findingB.revision + 1,
        provisional: {
          ...findingB.provisional!,
          reason: 'The candidate premise changed after interruption.',
        },
      },
    });
    const changedFindingB = ledger.findings.find(({ id }) => id === 'F-0002')!;
    const candidateBNew = buildTerminalAdjudicationCandidateSnapshot({
      ledger,
      finding: changedFindingB,
      currentRound: 3,
    })!;
    const secondRound = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: findingContentAddress('terminal-round', { round: 'interrupted-2' }),
      candidates: [candidateBNew],
      selectedAt: OBSERVATION,
    });
    ledger = {
      ...ledger,
      terminalAdjudicationRounds: [...ledger.terminalAdjudicationRounds, secondRound.round],
      terminalAdjudicationEpisodes: [...ledger.terminalAdjudicationEpisodes, ...secondRound.episodes],
    };

    const selected = selectReconstructableTerminalEpisode({
      ledger,
      currentRound: 3,
      observation: OBSERVATION,
    });

    expect(selected.selected?.episode.episodeId).toBe(secondRound.episodes[0]!.episodeId);
    expect(selected.ledger.terminalAdjudicationSettlements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        episodeId: episodeBOld.episodeId,
        attemptId: selected.ledger.terminalAdjudicationAttempts[0]!.attemptId,
        outcome: 'exhausted',
        reason: 'stale_precondition',
        supersedingEpisodeId: secondRound.episodes[0]!.episodeId,
      }),
    ]));
    expect(selected.ledger.terminalAdjudicationAttempts.find(
      ({ attemptId }) => attemptId === interruptedAttemptId,
    )).toMatchObject({
      stage: 'completed',
      result: {
        kind: 'stale_precondition',
        proposal: null,
        proposalDigest: null,
      },
    });
    expect(selected.ledger.findings.find(({ id }) => id === 'F-0002')).toMatchObject({
      status: 'open',
      provisional: expect.objectContaining({ stableKey: 'stable-F-0002' }),
    });
    expect(() => parseFindingLedger(selected.ledger)).not.toThrow();
  });

  it('rejects a completed null stale result without an exhausted settlement at load', () => {
    let ledger = initialLedger({ onlyB: true });
    const candidate = buildTerminalAdjudicationCandidateSnapshot({
      ledger,
      finding: ledger.findings[0]!,
      currentRound: 2,
    })!;
    const firstRound = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: findingContentAddress('terminal-round', { round: 'missing-exhausted' }),
      candidates: [candidate],
      selectedAt: OBSERVATION,
    });
    ledger = {
      ...ledger,
      terminalAdjudicationRounds: [firstRound.round],
      terminalAdjudicationEpisodes: firstRound.episodes,
    };
    ledger = addInterruptedAttempt({
      ledger,
      episode: firstRound.episodes[0]!,
      candidate,
    });
    const finding = ledger.findings[0]!;
    ledger = applyFindingLedgerFixtureRevision({
      ledger,
      entityKind: 'finding',
      entity: {
        ...finding,
        revision: finding.revision + 1,
        provisional: {
          ...finding.provisional!,
          reason: 'The candidate changed before stale closure.',
        },
      },
    });
    const actualHead = buildTerminalAdjudicationCandidateSnapshot({
      ledger,
      finding: ledger.findings[0]!,
      currentRound: 3,
    })!.expectedHead;
    const malformed: FindingLedger = {
      ...ledger,
      terminalAdjudicationAttempts: ledger.terminalAdjudicationAttempts.map((attempt) => {
        if (attempt.stage !== 'interrupted') {
          throw new Error('Expected an interrupted terminal attempt fixture');
        }
        return {
          attemptId: attempt.attemptId,
          episodeId: attempt.episodeId,
          selectionId: attempt.selectionId,
          roundIdentity: attempt.roundIdentity,
          findingId: attempt.findingId,
          expectedHead: attempt.expectedHead,
          candidateSnapshotDigest: attempt.candidateSnapshotDigest,
          attemptOrdinal: attempt.attemptOrdinal,
          retryOrdinal: attempt.retryOrdinal,
          providerCallId: attempt.providerCallId,
          requestDigest: attempt.requestDigest,
          sourceClaimRefIds: attempt.sourceClaimRefIds,
          stage: 'completed' as const,
          startedAt: attempt.startedAt,
          completedAt: OBSERVATION,
          result: {
            kind: 'stale_precondition' as const,
            proposal: null,
            proposalDigest: null,
            actualHead,
          },
        };
      }),
    };

    expect(() => parseFindingLedger(malformed))
      .toThrow(/invalid exhausted settlement ownership/u);
  });
});
