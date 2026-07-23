import type {
  AgentResponse,
  FindingContractConfig,
  FindingLedger,
  PartDefinition,
  PartResult,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import type {
  DecomposeTaskResponse,
  MorePartsResponse,
} from '../../../agents/decompose-task-usecase.js';
import type {
  StepRunResult,
  WorkflowOperationJournalContext,
} from '../types.js';
import {
  collectActionableFindingIds,
  renderActionableFindingContractSummary,
  renderCompactActionableFindingContractSummary,
} from '../team-leader-finding-contract.js';
import {
  createTeamLeaderArtifactAttemptId,
  writeTeamLeaderPartArtifact,
} from './team-leader-artifacts.js';
import type { TeamLeaderArtifactReference } from './team-leader-aggregation.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { RunPaths } from '../run/run-paths.js';
import {
  FindingContractOperationJournal,
  type FindingContractOperationBoundary,
} from './team-leader-finding-contract-operation-journal.js';
import { FindingContractOperationReplay } from './team-leader-finding-contract-operation-replay.js';
import { recordFindingContractRecoveryAttempt } from './team-leader-finding-contract-recovery-recorder.js';
import type {
  FindingContractRecoveryAttemptEvent,
} from './team-leader-finding-contract-recovery.js';
import type {
  FindingContractRejectedOutputDigest,
} from '../team-leader-finding-contract-control-validation.js';
import type {
  FindingContractRejectedDecompositionDigest,
} from '../team-leader-finding-contract-decomposition-validation.js';
import type {
  FindingContractRejectedDecisionDigest,
} from '../team-leader-finding-contract-decision-validation.js';
import type {
  FindingContractDecisionValidationContext,
} from '../team-leader-finding-contract-decision.js';
import {
  createFindingContractDecisionBoundaryAdapter,
  createFindingContractDecompositionBoundaryAdapter,
} from './team-leader-finding-contract-boundary-adapters.js';
import {
  requestValidFindingContractControlOutput,
  type FindingContractRecoveryRequest,
} from './team-leader-finding-contract-recovery.js';

export interface FindingContractTeamLeaderExecutionContext {
  readonly targetFindingIds: string[];
  readonly actionableFindings: string;
  readonly ledger: FindingLedger;
}

interface FindingContractTeamLeaderCoordinatorDeps {
  readonly engineOptions: {
    readonly runPathNamespace?: string[];
  };
  readonly findingContract?: FindingContractConfig;
  readonly findingLedgerStore?: FindingLedgerStore;
  readonly operationJournal?: WorkflowOperationJournalContext;
  readonly getWorkflowName: () => string;
  readonly getRunPaths: () => RunPaths;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
}

export class FindingContractTeamLeaderCoordinator {
  readonly execution: FindingContractTeamLeaderExecutionContext;
  readonly artifactAttemptId: string;

  private readonly journal: FindingContractOperationJournal;
  private readonly replay: FindingContractOperationReplay;

  constructor(
    private readonly deps: FindingContractTeamLeaderCoordinatorDeps,
    private readonly step: WorkflowStep,
    stepIteration: number,
  ) {
    if (deps.operationJournal === undefined) {
      throw new Error(
        'team_leader.mode "finding_contract_fix" requires an operation journal',
      );
    }
    this.execution = buildExecutionContext(deps);
    this.journal = FindingContractOperationJournal.open({
      context: deps.operationJournal,
      workflowName: deps.getWorkflowName(),
      stepName: step.name,
      stepIteration,
      executionScope: {
        runPathNamespace: deps.engineOptions.runPathNamespace ?? [],
        workflowStack: (deps.getCurrentWorkflowStack?.() ?? []).map((entry) => ({
          workflow: entry.workflow,
          ...(entry.workflow_ref === undefined ? {} : { workflow_ref: entry.workflow_ref }),
          step: entry.step,
          kind: entry.kind,
        })),
      },
    });
    this.replay = new FindingContractOperationReplay(this.journal);
    this.artifactAttemptId = createTeamLeaderArtifactAttemptId(stepIteration);
  }

  readPreparedStepResult(): StepRunResult | undefined {
    return this.replay.readPreparedStepResult();
  }

  prepareStepResult(result: StepRunResult): StepRunResult {
    return this.replay.prepareStepResult(result);
  }

  boundary(id: string, kind: string): FindingContractOperationBoundary {
    return this.journal.boundary(id, kind);
  }

  async recoverDecomposition(input: {
    readonly maxInitialParts: number | undefined;
    readonly abortSignal?: AbortSignal;
    readonly requestRaw: (
      request: FindingContractRecoveryRequest<FindingContractRejectedDecompositionDigest>,
    ) => Promise<AgentResponse>;
    readonly onReplay: () => void;
  }): Promise<DecomposeTaskResponse> {
    const boundary = this.boundary(
      'decomposition',
      'finding_contract_decomposition',
    );
    const completed = boundary.readCompleted<DecomposeTaskResponse>();
    if (completed !== undefined) {
      input.onReplay();
      return completed;
    }
    const accepted = boundary.readAccepted<DecomposeTaskResponse>();
    if (accepted !== undefined) {
      boundary.complete(accepted);
      input.onReplay();
      return accepted;
    }
    const result = await requestValidFindingContractControlOutput<
      AgentResponse,
      DecomposeTaskResponse,
      FindingContractRejectedDecompositionDigest
    >({
      abortSignal: input.abortSignal,
      resumeState: boundary.recoveryResumeState<FindingContractRejectedDecompositionDigest>(),
      adapter: createFindingContractDecompositionBoundaryAdapter({
        maxInitialParts: input.maxInitialParts,
        targetFindingIds: this.execution.targetFindingIds,
        requestRaw: input.requestRaw,
      }),
      onAttempt: (event) => {
        if (event.type === 'late') return;
        this.recordAttempt('decomposition', event);
        boundary.recordAttempt(event);
      },
    });
    boundary.complete(result);
    return result;
  }

  async recoverDecision(input: {
    readonly batchNumber: number;
    readonly abortSignal?: AbortSignal;
    readonly validationContext: FindingContractDecisionValidationContext;
    readonly requestRaw: (
      request: FindingContractRecoveryRequest<FindingContractRejectedDecisionDigest>,
    ) => Promise<AgentResponse>;
    readonly onRejected?: (
      event: FindingContractRecoveryAttemptEvent<FindingContractRejectedDecisionDigest>,
    ) => void;
  }): Promise<MorePartsResponse> {
    const boundary = this.boundary(
      `feedback:${input.batchNumber}`,
      'finding_contract_decision',
    );
    const completed = boundary.readCompleted<MorePartsResponse>();
    if (completed !== undefined) return completed;
    const accepted = boundary.readAccepted<MorePartsResponse>();
    if (accepted !== undefined) {
      boundary.complete(accepted);
      return accepted;
    }
    const result = await requestValidFindingContractControlOutput<
      AgentResponse,
      MorePartsResponse,
      FindingContractRejectedDecisionDigest
    >({
      abortSignal: input.abortSignal,
      resumeState: boundary.recoveryResumeState<FindingContractRejectedDecisionDigest>(),
      adapter: createFindingContractDecisionBoundaryAdapter({
        validationContext: input.validationContext,
        requestRaw: input.requestRaw,
      }),
      onAttempt: (event) => {
        if (event.type === 'late') return;
        this.recordAttempt(`feedback:${input.batchNumber}`, event);
        boundary.recordAttempt(event);
        if (event.type === 'rejected') input.onRejected?.(event);
      },
    });
    boundary.complete(result);
    return result;
  }

  beginTermination(error: unknown): void {
    this.journal.beginTermination(error);
  }

  terminate(error: unknown): void {
    this.journal.terminate(error);
  }

  partSummary(part: PartDefinition): string {
    if (part.findingContract === undefined) {
      throw new Error(`Finding Contract part "${part.id}" is missing its assignment`);
    }
    return renderActionableFindingContractSummary(
      this.execution.ledger,
      part.findingContract.findingIds,
    );
  }

  recordAttempt<TDigest extends FindingContractRejectedOutputDigest>(
    boundaryId: string,
    event: FindingContractRecoveryAttemptEvent<TDigest>,
  ): void {
    recordFindingContractRecoveryAttempt({
      runPaths: this.deps.getRunPaths(),
      stepName: this.step.name,
      attemptId: this.artifactAttemptId,
      boundaryId,
      event,
      ...(event.envelope?.usage === undefined
        ? {}
        : { providerUsage: event.envelope.usage }),
    });
  }

  writeAcceptedPartArtifact(
    batchNumber: number,
    partIndex: number,
    result: PartResult,
  ): TeamLeaderArtifactReference {
    return writeTeamLeaderPartArtifact({
      runPaths: this.deps.getRunPaths(),
      stepName: this.step.name,
      attemptId: this.artifactAttemptId,
      batchNumber,
      partIndex,
      result,
    });
  }
}

function buildExecutionContext(
  deps: FindingContractTeamLeaderCoordinatorDeps,
): FindingContractTeamLeaderExecutionContext {
  if (deps.findingContract === undefined || deps.findingLedgerStore === undefined) {
    throw new Error('team_leader.mode "finding_contract_fix" requires an active finding_contract');
  }
  const ledger = deps.findingLedgerStore.loadLedger();
  const targetFindingIds = collectActionableFindingIds(ledger);
  if (targetFindingIds.length === 0) {
    throw new Error(
      'team_leader.mode "finding_contract_fix" requires at least one actionable open finding',
    );
  }
  return {
    targetFindingIds,
    actionableFindings: renderCompactActionableFindingContractSummary(ledger, targetFindingIds),
    ledger,
  };
}
