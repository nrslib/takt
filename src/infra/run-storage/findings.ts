import type { RunReadContext } from './context.js';
import {
  FindingLedgerRepository,
  type FindingLedgerRecord,
} from './finding-ledger.js';

export interface FindingCounts {
  readonly raw: number;
  readonly canonical: number;
  readonly conflicts: number;
  readonly interpretations: number;
  readonly reviewerAnomalies: number;
}

export class FindingRepository extends FindingLedgerRepository {
  counts(
    context: RunReadContext,
    input: {
      readonly runId: string;
      readonly scopeId: string;
      readonly workflowName: string;
    },
  ): FindingCounts {
    const ledger = this.loadLedger(context, input).ledger;
    return {
      raw: ledger.rawFindings.length,
      canonical: ledger.findings.length,
      conflicts: ledger.conflicts.length,
      interpretations: ledger.interpretations.length,
      reviewerAnomalies: ledger.reviewerAnomalies?.length ?? 0,
    };
  }

  projection(
    context: RunReadContext,
    input: {
      readonly runId: string;
      readonly scopeId: string;
      readonly workflowName: string;
    },
  ): FindingLedgerRecord {
    return this.loadLedger(context, input);
  }
}
