import {
  computeTerminalEpisodeId,
  computeTerminalSelectionId,
} from '../../models/finding-contract-identity.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationAttempt,
  TerminalAdjudicationEpisode,
  TerminalAdjudicationRound,
} from '../../models/finding-contract-types.js';
import type { FindingLedger, FindingObservation } from './types.js';

function activeEpisodes(ledger: FindingLedger): TerminalAdjudicationEpisode[] {
  return ledger.terminalAdjudicationEpisodes.filter((episode) => {
    if (ledger.terminalAdjudicationSettlements.some(
      (settlement) => settlement.episodeId === episode.episodeId,
    )) {
      return false;
    }
    const attempts = ledger.terminalAdjudicationAttempts.filter(
      (attempt) => attempt.episodeId === episode.episodeId,
    );
    const latest = attempts[attempts.length - 1];
    return latest === undefined
      || latest.stage === 'started'
      || (latest.stage === 'interrupted' && attempts.length < episode.maxAttempts);
  });
}

function attemptPriority(
  episode: TerminalAdjudicationEpisode,
  attempts: readonly TerminalAdjudicationAttempt[],
  completedAttemptCount: number,
): { phase: number; timestamp: string; count: number; findingId: string } {
  const latest = attempts[attempts.length - 1];
  if (latest?.stage === 'started') {
    return { phase: 1, timestamp: latest.startedAt.timestamp, count: 0, findingId: episode.findingId };
  }
  if (latest?.stage === 'interrupted') {
    return { phase: 2, timestamp: latest.interruptedAt.timestamp, count: latest.retryOrdinal, findingId: episode.findingId };
  }
  return { phase: 3, timestamp: episode.createdAt.timestamp, count: completedAttemptCount, findingId: episode.findingId };
}

export function listActiveTerminalAdjudicationEpisodes(
  ledger: FindingLedger,
): TerminalAdjudicationEpisode[] {
  const attemptsByEpisodeId = new Map<string, TerminalAdjudicationAttempt[]>();
  for (const attempt of ledger.terminalAdjudicationAttempts) {
    const attempts = attemptsByEpisodeId.get(attempt.episodeId) ?? [];
    attempts.push(attempt);
    attemptsByEpisodeId.set(attempt.episodeId, attempts);
  }
  const completedAttemptCountByFindingId = new Map<string, number>();
  for (const attempt of ledger.terminalAdjudicationAttempts) {
    if (attempt.stage !== 'completed') {
      continue;
    }
    completedAttemptCountByFindingId.set(
      attempt.findingId,
      (completedAttemptCountByFindingId.get(attempt.findingId) ?? 0) + 1,
    );
  }
  const ranked = activeEpisodes(ledger).map((episode) => ({
    episode,
    priority: attemptPriority(
      episode,
      attemptsByEpisodeId.get(episode.episodeId) ?? [],
      completedAttemptCountByFindingId.get(episode.findingId) ?? 0,
    ),
  }));
  return ranked.sort((left, right) => {
    const leftPriority = left.priority;
    const rightPriority = right.priority;
    if (leftPriority.phase !== rightPriority.phase) {
      return leftPriority.phase - rightPriority.phase;
    }
    if (leftPriority.phase === 3 && leftPriority.count !== rightPriority.count) {
      return leftPriority.count - rightPriority.count;
    }
    const timestampComparison = compareBinaryStrings(
      leftPriority.timestamp,
      rightPriority.timestamp,
    );
    if (timestampComparison !== 0) {
      return timestampComparison;
    }
    return compareBinaryStrings(leftPriority.findingId, rightPriority.findingId)
      || compareBinaryStrings(left.episode.episodeId, right.episode.episodeId);
  }).map(({ episode }) => episode);
}

export function selectActiveTerminalAdjudicationEpisode(
  ledger: FindingLedger,
): TerminalAdjudicationEpisode | undefined {
  return listActiveTerminalAdjudicationEpisodes(ledger)[0];
}

export function createTerminalAdjudicationRound(input: {
  ledger: FindingLedger;
  roundIdentity: string;
  candidates: readonly TerminalAdjudicationCandidateSnapshot[];
  selectedAt: FindingObservation;
}): { round: TerminalAdjudicationRound; episodes: TerminalAdjudicationEpisode[] } {
  const existing = input.ledger.terminalAdjudicationRounds.filter(
    (round) => round.roundIdentity === input.roundIdentity,
  );
  if (existing.length > 1) {
    throw new Error(`Terminal round "${input.roundIdentity}" has multiple selections`);
  }
  if (existing.length === 1) {
    const round = existing[0]!;
    return {
      round,
      episodes: round.members.map((member) => {
        const episode = input.ledger.terminalAdjudicationEpisodes.find(
          (candidate) => candidate.episodeId === member.episodeId,
        );
        if (episode === undefined) {
          throw new Error(`Terminal selection references missing episode "${member.episodeId}"`);
        }
        return episode;
      }),
    };
  }
  const members = input.candidates.map((candidate) => ({
    findingId: candidate.findingId,
    episodeId: computeTerminalEpisodeId({
      findingId: candidate.findingId,
      expectedHead: candidate.expectedHead,
      candidateSnapshotDigest: candidate.candidateSnapshotDigest,
    }),
    candidateSnapshotDigest: candidate.candidateSnapshotDigest,
  }));
  const selectionId = computeTerminalSelectionId(input.roundIdentity, members);
  const round: TerminalAdjudicationRound = {
    roundIdentity: input.roundIdentity,
    selectionId,
    members,
    selectedAt: structuredClone(input.selectedAt),
  };
  const episodes = input.candidates.map((candidate, index): TerminalAdjudicationEpisode => ({
    episodeId: members[index]!.episodeId,
    selectionId,
    roundIdentity: input.roundIdentity,
    findingId: candidate.findingId,
    expectedHead: structuredClone(candidate.expectedHead),
    candidateSnapshotDigest: candidate.candidateSnapshotDigest,
    maxAttempts: 2,
    createdAt: structuredClone(input.selectedAt),
  }));
  return { round, episodes };
}
