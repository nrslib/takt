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

export interface RunFindingManagerForStepInput {
  contract: FindingContractConfig;
  cwd: string;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingManagerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
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
  interpretationKey: string;
}

export interface LadderResult {
  pendingSameWithProof: Array<{
    target: LadderTarget;
    proof: DeterministicSameProof;
    viaInterpretationKey?: string;
  }>;
  pendingIndependentNew: Array<{ wire: RawFinding; viaInterpretationKey?: string }>;
  pendingConflicts: Array<{
    target: LadderTarget;
    targetFindingId: string;
    viaInterpretationKey?: string;
  }>;
  provisionalSpecs: ProvisionalFindingSpec[];
  provisionalByInterpretationKey: Map<string, ProvisionalFindingSpec>;
  pendingAppliedReattach: Array<{ target: LadderTarget }>;
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
}
