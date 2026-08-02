import {
  computeTerminalEpisodeId,
  computeTerminalSelectionId,
} from '../../models/finding-contract-identity.js';
import type {
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationEpisode,
  TerminalAdjudicationRound,
} from '../../models/finding-contract-types.js';
import type { FindingLedger, FindingObservation } from './types.js';

export function selectActiveTerminalAdjudicationEpisode(
  ledger: FindingLedger,
): TerminalAdjudicationEpisode | undefined {
  return ledger.terminalAdjudicationEpisodes.find((episode) => {
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
