import { processInterpretationLiveClaims } from '../../core/workflow/findings/interpretation-live-claims.js';
import type { FindingManagerAttemptKind } from '../../core/models/finding-contract-types.js';
import type { FindingLedgerStore } from '../../core/workflow/findings/store.js';

type FindingInterpretationLiveClaimFixture = {
  interpretationLiveClaims: typeof processInterpretationLiveClaims;
};

export function createFindingAdjudicationReservation(): FindingInterpretationLiveClaimFixture {
  return {
    interpretationLiveClaims: processInterpretationLiveClaims,
  };
}

type AdjudicationPurpose = Extract<
  FindingManagerAttemptKind,
  'terminal_adjudication' | 'conflict_adjudication'
>;

export function crashAfterAdjudicationReservation(input: {
  store: FindingLedgerStore;
  purpose: AdjudicationPurpose;
  errorMessage: string;
}): FindingLedgerStore {
  let crashed = false;
  return new Proxy(input.store, {
    get(target, property, receiver) {
      if (property === 'updateLedger') {
        return async (...args: Parameters<FindingLedgerStore['updateLedger']>) => {
          const mutation = await target.updateLedger(...args);
          const hasReservation = mutation.ledger.findingManagerProviderCalls.some((call) => (
            call.purpose === input.purpose && call.state === 'reserved'
          ));
          if (!crashed && hasReservation) {
            crashed = true;
            throw new Error(input.errorMessage);
          }
          return mutation;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
