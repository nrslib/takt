import type { FindingLedgerStore } from '../../core/workflow/findings/types.js';
import { processAdjudicationLiveClaims } from '../../core/workflow/findings/adjudication-live-claims.js';
import { processInterpretationLiveClaims } from '../../core/workflow/findings/interpretation-live-claims.js';

type FindingAdjudicationReservation = Pick<
  FindingLedgerStore,
  'claimAdjudicationReservation' | 'releaseAdjudicationReservation'
> & {
  adjudicationLiveClaims: typeof processAdjudicationLiveClaims;
  interpretationLiveClaims: typeof processInterpretationLiveClaims;
};

export function createFindingAdjudicationReservation(): FindingAdjudicationReservation {
  const reservations = new Set<string>();
  return {
    adjudicationLiveClaims: processAdjudicationLiveClaims,
    interpretationLiveClaims: processInterpretationLiveClaims,
    claimAdjudicationReservation: (token) => {
      if (reservations.has(token)) return false;
      reservations.add(token);
      return true;
    },
    releaseAdjudicationReservation: (token) => { reservations.delete(token); },
  };
}
