import type { AgentResponse } from '../../models/types.js';
import type { StepRunResult, StepTransitionReceipt } from '../types.js';
import { FindingContractOperationJournal } from './team-leader-finding-contract-operation-journal.js';

export class FindingContractOperationReplay {
  constructor(
    private readonly journal: FindingContractOperationJournal,
  ) {}

  readPreparedStepResult(): StepRunResult | undefined {
    const result = this.journal.readResultReady<StepRunResult>();
    if (result === undefined) return undefined;
    return this.withTransitionReceipt({
      ...result,
      response: hydrateAgentResponse(result.response),
    });
  }

  prepareStepResult(result: StepRunResult): StepRunResult {
    this.journal.markResultReady(result);
    return this.withTransitionReceipt(result);
  }

  private withTransitionReceipt(result: StepRunResult): StepRunResult {
    return {
      ...result,
      commitTransition: (receipt: StepTransitionReceipt) => {
        this.journal.completeTransition(receipt);
      },
    };
  }
}

function hydrateAgentResponse(response: AgentResponse): AgentResponse {
  const timestamp: unknown = response.timestamp;
  return {
    ...response,
    timestamp: timestamp instanceof Date ? timestamp : new Date(String(timestamp)),
  };
}
