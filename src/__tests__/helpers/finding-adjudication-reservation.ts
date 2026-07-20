import type { FindingLedgerStore } from '../../core/workflow/findings/types.js';

type FindingAdjudicationReservation = Pick<
  FindingLedgerStore,
  'claimAdjudicationReservation' | 'releaseAdjudicationReservation'
>;

export function createFindingAdjudicationReservation(): FindingAdjudicationReservation {
  const reservations = new Set<string>();
  return {
    claimAdjudicationReservation: (token) => {
      if (reservations.has(token)) return false;
      reservations.add(token);
      return true;
    },
    releaseAdjudicationReservation: (token) => { reservations.delete(token); },
  };
}
