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
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingManagerOutput,
  FindingManagerAuthority,
  FindingManagerTaskAudit,
  RawFinding,
} from './types.js';
import type {
  CanonicalIntakeItem,
} from './manager-admission.js';
import type {
  InterpretationCaseDirectPlan,
  InterpretationCaseProofFastPathPlan,
} from './interpretation-case-coordinator.js';
import type { ProvisionalTargetConflictCandidate } from './decision-assembly.js';

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
  workflowTask: string;
  runId: string;
  callNamespace: string;
  timestamp: string;
  priorStepResponseText?: string;
  managerAuthority: FindingManagerAuthority;
  reviewPublicationDir?: string;
}

export type FindingManagerRunResult =
  | {
      status: 'updated';
      providerInfo: StepProviderInfo;
      ledger: FindingLedger;
    }
  | {
      status: 'unchanged';
      ledger: FindingLedger;
    };

export interface InterpretationCaseRunResult {
  items: CanonicalIntakeItem[];
  completedAttemptIdsForCommit: string[];
  directPlans: InterpretationCaseDirectPlan[];
  proofFastPathPlans: InterpretationCaseProofFastPathPlan[];
  provisionalOnlyRawFindingIds: Set<string>;
  stats: InterpretationStatsReport;
}

export interface ManagerDecisionStageResult {
  managerOutput: FindingManagerOutput;
  conflictTargetHeads: Map<string, CapturedManagerConflictHead>;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  cleanProvisionalSpecs: ProvisionalFindingSpec[];
  provisionalTargetConflicts: ProvisionalTargetConflictCandidate[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  cleanWireById: Map<string, RawFinding>;
  cleanCanonicalById: Map<string, CanonicalRawFinding>;
  interpretation: InterpretationCaseRunResult;
  taskAudits: FindingManagerTaskAudit[];
}

export interface CapturedManagerConflictHead {
  lifecycleHead: FindingLifecycleEntityHead | null;
  evidenceSetHash: string;
  reviewScopeSnapshotId: string;
}
