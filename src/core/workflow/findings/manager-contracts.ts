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
  RawFindingDispositionOutcome,
} from './types.js';
import type { CanonicalIntakeItem, ReviewerIntakeResult } from './manager-admission.js';
import type { CapturedFindingPrecondition } from './finding-preconditions.js';
import type { ProvisionalRecoveryOrigin } from './provisional-recovery-origin.js';

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

export type FindingManagerRunResult =
  | {
      status: 'updated';
      ledgerPath: string;
      providerInfo: StepProviderInfo;
      ledger: FindingLedger;
    }
  | {
      status: 'unchanged';
      ledger: FindingLedger;
    };

export interface LadderTarget {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
  baseInterpretationKey: string;
  interpretationKey: string;
  attemptOrdinal: number;
  interpretationRecoveryAttempt?: boolean;
  recoveryOrigins?: ProvisionalRecoveryOrigin[];
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
    recoveryOrigins?: LadderTarget['recoveryOrigins'];
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
  recoveryProvisionalOrigins: Map<string, ProvisionalRecoveryOrigin[]>;
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
  recoveryOrigin: ProvisionalRecoveryOrigin;
}

type AuditOnlyRawAdjudicationFailureKind =
  | 'source_missing'
  | 'reviewer_provenance_missing'
  | 'admission_rejected'
  | 'input_budget_exceeded'
  | 'manager_output_rejected'
  | 'agent_failed'
  | 'provisional_landing'
  | 'unlanded';

type StaleRawAdjudicationFailureKind =
  | 'target_missing'
  | 'precondition_stale'
  | 'reviewer_provenance_mismatch';

export type RawAdjudicationFailure =
  | {
      kind: AuditOnlyRawAdjudicationFailureKind;
      outcome: Extract<RawFindingDispositionOutcome, 'audit_only'>;
      reason: string;
    }
  | {
      kind: StaleRawAdjudicationFailureKind;
      outcome: Extract<RawFindingDispositionOutcome, 'stale'>;
      reason: string;
    }
  | {
      kind: 'manager_unsupported';
      outcome: Extract<RawFindingDispositionOutcome, 'unsupported'>;
      reason: string;
    };

export interface RawAdjudicationRecoveryResult {
  intake: ReviewerIntakeResult;
  output: FindingManagerOutput;
  origins: Map<string, RawAdjudicationReplayOrigin>;
  failures: Map<string, RawAdjudicationFailure>;
  capturedPreconditions: Map<string, CapturedFindingPrecondition>;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  cleanWireById: Map<string, RawFinding>;
  cleanCanonicalById: Map<string, CanonicalIntakeItem['canonical']>;
  reservationTokens: Set<string>;
}
