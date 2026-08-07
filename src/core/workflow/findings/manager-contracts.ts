import type { InternalAgentSeats } from '../../models/config-types.js';
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
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
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
  /**
   * このラウンドを stop budget / review-integrity 予算のラウンドとして数えるか。
   *
   * `round`（既定）はレビューステップ本体の取り込み。`excluded` は言い直し slot の
   * 各パス — slot はレビューラウンドの内側で回る差し戻しであり、停止保証は
   * 提示予算（presentationLimit）とパス上限が既に与えている。ここを数えると
   * 1ステップで予算を焼き切り、再レビューの機会が残らないまま need_replan へ
   * 固定される（実測）。
   */
  budgetAccounting?: 'round' | 'excluded';
}

export type FindingManagerRunResult =
  | {
      status: 'updated';
      providerInfo: StepProviderInfo;
      ledger: FindingLedger;
      /** このラウンドの round marker（stop budget / review-integrity 予算の共有キー）。 */
      roundMarker: string;
    }
  | {
      status: 'unchanged';
      ledger: FindingLedger;
      roundMarker: string;
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
