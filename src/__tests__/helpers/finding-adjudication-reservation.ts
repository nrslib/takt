import { processInterpretationLiveClaims } from '../../core/workflow/findings/interpretation-live-claims.js';

type FindingInterpretationLiveClaimFixture = {
  interpretationLiveClaims: typeof processInterpretationLiveClaims;
};

export function createFindingAdjudicationReservation(): FindingInterpretationLiveClaimFixture {
  return {
    interpretationLiveClaims: processInterpretationLiveClaims,
  };
}
