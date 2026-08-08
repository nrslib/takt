import {
  computeFindingManagerRequestDigest,
  computeConflictAttemptId,
} from '../../models/finding-contract-identity.js';
import type {
  ConflictAdjudicationAttempt,
  ConflictAdjudicationEpisode,
  ConflictAdjudicationSnapshot,
  FindingManagerProviderCall,
} from '../../models/finding-contract-types.js';
import {
  createConflictAdjudicationEpisode,
  freshConflictAdjudicationSnapshot,
  isConflictSnapshotAdjudicated,
} from './conflict-adjudication-model.js';
import {
  releaseFindingManagerProviderCall,
  reserveFindingManagerProviderCall,
} from './finding-manager-provider-call.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';
import type { FindingObservation } from './types.js';

export type AdjudicationAttemptReservation =
  | { started: false }
  | {
      started: true;
      snapshot: ConflictAdjudicationSnapshot;
      episode: ConflictAdjudicationEpisode;
      attempt: Extract<ConflictAdjudicationAttempt, { stage: 'started' }>;
      providerCall: FindingManagerProviderCall;
      originStep: string | undefined;
    };

function exactEpisode(
  episodes: readonly ConflictAdjudicationEpisode[],
  snapshot: ConflictAdjudicationSnapshot,
  observation: FindingObservation,
): { episodes: ConflictAdjudicationEpisode[]; episode: ConflictAdjudicationEpisode } {
  const matches = episodes.filter((episode) => (
    episode.conflictSnapshotId === snapshot.conflictSnapshotId
  ));
  if (matches.length > 1) {
    throw new Error(`Conflict snapshot "${snapshot.conflictSnapshotId}" has multiple episodes`);
  }
  const episode = matches[0] ?? createConflictAdjudicationEpisode({
    snapshot,
    createdAt: observation,
  });
  return {
    episodes: matches.length === 0 ? [...episodes, episode] : [...episodes],
    episode,
  };
}

export async function reserveFindingConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  conflictId: string;
  expectedSnapshotId: string;
  requestedOriginStep: string | undefined;
  observation: FindingObservation;
  requestBytes: string;
  scopeIdentity: string;
  workflowName: string;
  roundMarker: string;
  allowGroundingRetry?: boolean;
}): Promise<FindingLedgerMutation<AdjudicationAttemptReservation>> {
  return input.ledgerStore.updateLedger<AdjudicationAttemptReservation>((fresh) => {
    const conflict = fresh.conflicts.find((candidate) => candidate.id === input.conflictId);
    if (conflict === undefined || conflict.status !== 'active') {
      return { ledger: fresh, result: { started: false } };
    }
    const snapshot = freshConflictAdjudicationSnapshot(fresh, conflict.id);
    const started = fresh.conflictAdjudicationAttempts.find((attempt) => (
      attempt.conflictId === conflict.id && attempt.stage === 'started'
    ));
    if (started?.stage === 'started') {
      const call = fresh.findingManagerProviderCalls.find(
        (candidate) => candidate.providerCallId === started.providerCallId,
      );
      if (call === undefined) {
        throw new Error(`Started conflict attempt "${started.attemptId}" has no provider call`);
      }
      if (call.state === 'dispatched') {
        const replaySnapshot = fresh.conflictAdjudicationSnapshots.find(
          (candidate) => candidate.conflictSnapshotId === started.conflictSnapshotId,
        );
        const replayEpisode = fresh.conflictAdjudicationEpisodes.find(
          (candidate) => candidate.episodeId === started.episodeId,
        );
        if (replaySnapshot === undefined || replayEpisode === undefined) {
          throw new Error(`Started conflict attempt "${started.attemptId}" cannot be replayed without its snapshot`);
        }
        if (call.requestBytes === undefined) {
          throw new Error(`Dispatched conflict provider call "${call.providerCallId}" has no saved request`);
        }
        return {
          ledger: fresh,
          result: {
            started: true,
            snapshot: replaySnapshot,
            episode: replayEpisode,
            attempt: started,
            providerCall: call,
            originStep: started.originStep ?? undefined,
          },
        };
      }
      if (call.state === 'reserved') {
        const requestChanged = call.requestDigest !== computeFindingManagerRequestDigest(input.requestBytes);
        if (started.conflictSnapshotId !== snapshot.conflictSnapshotId || requestChanged) {
          const released = releaseFindingManagerProviderCall({
            calls: fresh.findingManagerProviderCalls,
            providerCallId: call.providerCallId,
            releasedAt: input.observation,
          });
          fresh = {
            ...fresh,
            findingManagerProviderCalls: released.calls,
            conflictAdjudicationAttempts: fresh.conflictAdjudicationAttempts.map((attempt) => (
              attempt.attemptId === started.attemptId
                ? {
                    ...started,
                    stage: 'interrupted' as const,
                    interruptedAt: structuredClone(input.observation),
                    reason: 'reservation_released' as const,
                  }
                : attempt
            )),
          };
        } else {
          if (snapshot.conflictSnapshotId !== input.expectedSnapshotId) {
            return { ledger: fresh, result: { started: false } };
          }
          const ensured = exactEpisode(
            fresh.conflictAdjudicationEpisodes,
            snapshot,
            input.observation,
          );
          return {
            ledger: fresh,
            result: {
              started: true,
              snapshot,
              episode: ensured.episode,
              attempt: started,
              providerCall: call,
              originStep: started.originStep ?? undefined,
            },
          };
        }
      } else if (call.state !== 'released') {
        throw new Error(`Started conflict attempt "${started.attemptId}" has no live provider call`);
      }
    }
    if (snapshot.conflictSnapshotId !== input.expectedSnapshotId) {
      return { ledger: fresh, result: { started: false } };
    }
    const ensured = exactEpisode(
      fresh.conflictAdjudicationEpisodes,
      snapshot,
      input.observation,
    );
    const episodeAttempts = fresh.conflictAdjudicationAttempts.filter(
      (attempt) => attempt.episodeId === ensured.episode.episodeId,
    );
    const groundingRetryAlreadyUsed = episodeAttempts.some((attempt) => (
      attempt.attemptOrdinal === 2
      && fresh.findingManagerProviderCalls
        .filter((call) => call.providerCallId === attempt.providerCallId)
        .some((call) => (
          fresh.findingManagerProviderBudgetScopes.some((scope) => (
            scope.budgetScopeId === call.budgetScopeId
            && scope.roundMarker === input.roundMarker
          ))
        ))
    ));
    const groundingRetryAllowed = input.allowGroundingRetry === true
      && !groundingRetryAlreadyUsed
      && episodeAttempts.some((attempt) => (
        attempt.stage === 'completed'
        && attempt.attemptOrdinal === 1
        && attempt.result.kind === 'verification_undetermined'
      ));
    if (isConflictSnapshotAdjudicated(fresh, snapshot) && !groundingRetryAllowed) {
      return { ledger: fresh, result: { started: false } };
    }
    const used = fresh.conflictAdjudicationAttempts.filter(
      (attempt) => attempt.episodeId === ensured.episode.episodeId,
    ).length;
    if (used >= ensured.episode.maxAttempts) {
      return { ledger: fresh, result: { started: false } };
    }
    const attemptOrdinal = (used + 1) as 1 | 2;
    const retryOrdinal = used as 0 | 1;
    const attemptId = computeConflictAttemptId({
      episodeId: ensured.episode.episodeId,
      attemptOrdinal,
      retryOrdinal,
    });
    const reserved = reserveFindingManagerProviderCall({
      scopes: fresh.findingManagerProviderBudgetScopes,
      calls: fresh.findingManagerProviderCalls,
      scopeIdentity: input.scopeIdentity,
      workflowName: input.workflowName,
      roundMarker: input.roundMarker,
      limits: {
        maxCallsPerRound: MANAGER_INTERPRETATION_LIMITS.maxManagerCallsPerStep,
        maxAdapterVisibleInputBytesPerCall: MANAGER_INTERPRETATION_LIMITS.maxInputBytesPerCall,
        maxOutputTokensPerCall: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerCall,
        maxChargedInputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep,
        maxChargedOutputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerStep,
      },
      purpose: 'conflict_adjudication',
      ownerAttemptKind: 'conflict_adjudication',
      attemptIds: [attemptId],
      requestBytes: input.requestBytes,
      adapterSupportsUtf8ByteUpperBound: true,
      reservedAt: input.observation,
    });
    const attempt: Extract<ConflictAdjudicationAttempt, { stage: 'started' }> = {
      attemptId,
      episodeId: ensured.episode.episodeId,
      conflictSnapshotId: snapshot.conflictSnapshotId,
      conflictId: snapshot.conflictId,
      expectedConflictHead: structuredClone(snapshot.expectedConflictHead),
      attemptOrdinal,
      retryOrdinal,
      providerCallId: reserved.call.providerCallId,
      requestDigest: reserved.call.requestDigest,
      subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId),
      originStep: input.requestedOriginStep ?? null,
      stage: 'started',
      startedAt: structuredClone(input.observation),
    };
    const ledger = {
      ...fresh,
      updatedAt: input.observation.timestamp,
      findingManagerProviderBudgetScopes: reserved.scopes,
      findingManagerProviderCalls: reserved.calls,
      conflictAdjudicationEpisodes: ensured.episodes,
      conflictAdjudicationAttempts: [...fresh.conflictAdjudicationAttempts, attempt],
    };
    return {
      ledger,
      result: {
        started: true,
        snapshot,
        episode: ensured.episode,
        attempt,
        providerCall: reserved.call,
        originStep: attempt.originStep ?? undefined,
      },
    };
  });
}
