import type { FindingLedger } from '../../core/workflow/findings/types.js';
import type { OperationRecord } from './operation-record.js';

export type SnapshotRow = Readonly<Record<string, unknown>>;

export interface ScopeResumeSnapshot extends SnapshotRow {
  readonly scopeId: string;
  readonly runtime: SnapshotRow;
  readonly events: readonly SnapshotRow[];
  readonly responses: readonly SnapshotRow[];
  readonly stepIterations: readonly SnapshotRow[];
  readonly stepExecutions: readonly SnapshotRow[];
  readonly phaseExecutions: readonly SnapshotRow[];
  readonly judgeStageResults: readonly SnapshotRow[];
  readonly stepOutputs: readonly SnapshotRow[];
  readonly structuredOutputs: readonly SnapshotRow[];
  readonly systemContexts: readonly SnapshotRow[];
  readonly effectResults: readonly SnapshotRow[];
  readonly userInputs: readonly SnapshotRow[];
  readonly personaSessions: readonly SnapshotRow[];
  readonly personaSessionHistory: readonly SnapshotRow[];
  readonly fallbackAttempts: readonly SnapshotRow[];
  readonly recoveryItems: readonly SnapshotRow[];
}

export interface CompleteResumeSnapshot {
  readonly run: SnapshotRow & {
    readonly runId: string;
    readonly findingContractEnabled: number;
    readonly createdAt: number;
  };
  readonly workflowDefinitions: readonly SnapshotRow[];
  readonly engineBuilds: readonly SnapshotRow[];
  readonly ancestry: readonly SnapshotRow[];
  readonly scopes: readonly ScopeResumeSnapshot[];
  readonly sessions: readonly SnapshotRow[];
  readonly leases: readonly SnapshotRow[];
  readonly operations: readonly OperationRecord[];
  readonly operationAttempts: readonly SnapshotRow[];
  readonly operationTransitions: readonly SnapshotRow[];
  readonly reports: readonly SnapshotRow[];
  readonly findingPublications: readonly SnapshotRow[];
  readonly findingRevisions: readonly SnapshotRow[];
  readonly findingHeads: readonly SnapshotRow[];
  readonly findingEntries: readonly SnapshotRow[];
  readonly findingControls: readonly SnapshotRow[];
  readonly findingLedger: {
    readonly revision: number;
    readonly updatedAt: number;
    readonly ledger: FindingLedger;
  } | null;
}
