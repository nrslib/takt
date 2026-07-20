import type {
  FindingContractConfig,
  WorkflowConfig,
  WorkflowStep,
} from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { StepProviderInfo } from '../types.js';
import type { FindingManagerSubStepResult } from './manager-intake.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type {
  FindingManagerStore,
  FindingManagerValidationAttemptReport,
  InterpretationStatsReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type {
  CanonicalRawFinding,
  DeterministicSameProof,
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from './types.js';
import type { CanonicalIntakeItem, ReviewerIntakeResult } from './manager-admission.js';
import type { CapturedFindingPrecondition } from './finding-preconditions.js';

export interface RunFindingManagerForStepInput {
  contract: FindingContractConfig;
  cwd: string;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingManagerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  parentStep: WorkflowStep;
  stepIteration: number;
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  runId: string;
  callNamespace: string;
  timestamp: string;
  ledgerCopyPath?: string;
  priorStepResponseText?: string;
}

export type FindingManagerRunResult = {
  status: 'updated';
  ledgerPath: string;
  providerInfo: StepProviderInfo;
  ledger: FindingLedger;
};

export interface LadderTarget {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
  baseInterpretationKey: string;
  interpretationKey: string;
  attemptOrdinal: number;
  interpretationRecoveryAttempt?: boolean;
  recoveryOrigin?: {
    provisionalFindingId: string;
    expectedProvisionalRevision: number;
  };
}

export interface LadderResult {
  interpretationReservations: Map<string, string>;
  deferredRawFindingIds: Set<string>;
  pendingSameWithProof: Array<{
    target: LadderTarget;
    proof: DeterministicSameProof;
    viaInterpretationKey?: string;
  }>;
  pendingIndependentNew: Array<{
    wire: RawFinding;
    viaInterpretationKey?: string;
    recoveryOrigin?: LadderTarget['recoveryOrigin'];
  }>;
  pendingConflicts: Array<{
    target: LadderTarget;
    targetFindingId: string;
    viaInterpretationKey?: string;
  }>;
  provisionalSpecs: ProvisionalFindingSpec[];
  provisionalByInterpretationKey: Map<string, ProvisionalFindingSpec>;
  pendingAppliedReattach: Array<{
    target: LadderTarget;
    applicationResult: 'created' | 'matched_with_proof' | 'conflict_created';
  }>;
  recoveryProvisionalInterpretationKeys: Set<string>;
  stats: InterpretationStatsReport;
}

export interface ManagerDecisionStageResult {
  managerOutput: FindingManagerOutput;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  cleanProvisionalSpecs: ProvisionalFindingSpec[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  cleanWireById: Map<string, RawFinding>;
  cleanCanonicalById: Map<string, CanonicalRawFinding>;
  ladder: LadderResult;
  rawRecovery: RawAdjudicationRecoveryResult;
}

export interface RawAdjudicationReplayOrigin {
  provisionalFindingId: string;
  sourceRawFindingId: string;
  expectedProvisionalRevision: number;
  attempt: number;
}

export interface RawAdjudicationRecoveryResult {
  intake: ReviewerIntakeResult;
  output: FindingManagerOutput;
  origins: Map<string, RawAdjudicationReplayOrigin>;
  failureReasons: Map<string, string>;
  capturedPreconditions: Map<string, CapturedFindingPrecondition>;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  cleanWireById: Map<string, RawFinding>;
  cleanCanonicalById: Map<string, CanonicalIntakeItem['canonical']>;
  reservationTokens: Set<string>;
}
