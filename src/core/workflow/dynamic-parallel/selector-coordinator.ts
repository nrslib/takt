import { executeStructuredAgent } from '../../../agents/structured-caller/transport.js';
import {
  isDynamicParallelSubSteps,
  type AgentResponse,
  type DynamicParallelSelectionSnapshot,
  type WorkflowResumePointEntry,
  type WorkflowState,
  type WorkflowStep,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { recordAgentUsageEvent } from '../engine/agent-usage-event.js';
import { buildDynamicParallelSelectionIdentityFromPath } from './identity.js';
import { createDynamicParallelSelectionSnapshot, resolveDynamicParallelSelection } from './snapshot.js';
import { createSelectorContract, validateSelectorResponse } from '../selector-contract.js';
import { buildDynamicSelectorInstruction } from './selector-input.js';
import { SelectorInputReader } from './selector-input-reader.js';
import type { DynamicParallelSelectionStore } from './selection-store.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../../../shared/utils/sensitiveText.js';

const log = createLogger('dynamic-parallel-selector');
const SELECTOR_RATIONALE_LOG_MAX_BYTES = 1024;

export interface DynamicParallelSelectorCoordinatorDeps {
  readonly engineOptions: WorkflowEngineOptions;
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly failureDir: string;
  readonly selectionStore: DynamicParallelSelectionStore;
  readonly getCwd: () => string;
  readonly getReportDirectory: () => string;
  readonly getReportNames: (step: WorkflowStep, state: WorkflowState) => readonly string[];
  readonly getWorkflowReference: () => string;
  readonly workflowCallPath: readonly WorkflowResumePointEntry[];
  readonly commitSelection: (
    identity: string,
    snapshot: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ) => Promise<void>;
  readonly inputReader?: SelectorInputReader;
}

export class DynamicParallelSelectorCoordinator {
  private readonly inputReader: SelectorInputReader | undefined;

  constructor(private readonly deps: DynamicParallelSelectorCoordinatorDeps) {
    this.inputReader = deps.inputReader;
  }

  private resolveAbortSignal(): AbortSignal | undefined {
    return this.deps.getAbortSignal?.() ?? this.deps.engineOptions.abortSignal;
  }

  async selectParticipants(step: WorkflowStep, state: WorkflowState, task: string): Promise<WorkflowStep[]> {
    const signal = this.resolveAbortSignal();
    signal?.throwIfAborted();
    if (!step.parallel || !isDynamicParallelSubSteps(step.parallel)) {
      throw new Error(`Step "${step.name}" is not a dynamic parallel step`);
    }
    const identity = this.resolveIdentity(step.name);
    const selections = this.deps.selectionStore.snapshot();
    const selectorProvider = this.deps.engineOptions.selectorProvider;
    if (selectorProvider?.provider === undefined) {
      throw new Error(`Dynamic parallel selector for "${step.name}" has no resolved provider`);
    }
    const selectorContract = createSelectorContract(step.parallel.pool.map(({ name, description }) => ({
      name,
      description,
    })));
    const previous = selections.get(identity);
    if (this.inputReader === undefined) {
      throw new Error('Dynamic parallel selector requires an input reader');
    }
    const inputs = await this.inputReader.readInputs(
      this.deps.getReportDirectory(),
      this.deps.getReportNames(step, state),
      this.deps.getCwd(),
      signal,
    );
    signal?.throwIfAborted();
    const instruction = buildDynamicSelectorInstruction({
      task,
      reports: inputs.reports,
      workingTreeDiff: inputs.workingTreeDiff,
      pool: step.parallel.pool,
      selection: step.parallel.selection,
      ...(previous === undefined ? {} : { previousSnapshot: previous }),
    });
    const sensitiveValues = createBoundedSensitiveValues();
    sensitiveValues.collect({
      task,
      reports: inputs.reports,
      working_tree_diff: inputs.workingTreeDiff,
      candidates: step.parallel.pool.map(({ name, description }) => ({ name, description })),
    });
    const redact = (text: string): string =>
      sanitizeSensitiveTextWithKnownValues(text, sensitiveValues);
    let response: AgentResponse | undefined;
    let selectorResult: ReturnType<typeof validateSelectorResponse>;
    let selected: Set<string>;
    let snapshot: DynamicParallelSelectionSnapshot;
    let participants: WorkflowStep[];
    try {
      response = await executeStructuredAgent(
        instruction,
        selectorContract.providerSchema,
        {
          name: 'dynamic-parallel-selector',
          cwd: this.deps.getCwd(),
          projectCwd: this.deps.engineOptions.projectCwd,
          failureDir: this.deps.failureDir,
          abortSignal: signal,
          language: this.deps.engineOptions.language,
          systemPrompt: 'You are TAKT\'s internal dynamic parallel selector. Select only candidate IDs from the provided pool.',
          resolution: {
            provider: selectorProvider.provider,
            model: selectorProvider.model,
            providerOptions: selectorProvider.providerOptions,
            permissionMode: selectorProvider.permissionMode,
          },
        },
      );
      signal?.throwIfAborted();
      selectorResult = validateSelectorResponse(
        response,
        selectorContract.validationSchema,
        step.name,
        redact,
        { label: 'Dynamic parallel' },
      );
      signal?.throwIfAborted();
      const selectedIds = selectorResult.selectedIds;
      selected = new Set(step.parallel.selection.mode === 'cumulative'
        ? [...(previous?.selected_pool_ids ?? []), ...selectedIds]
        : selectedIds);
      snapshot = createDynamicParallelSelectionSnapshot(
        identity,
        step.name,
        (previous?.round ?? 0) + 1,
        step.parallel,
        [...selected],
      );
      participants = resolveDynamicParallelSelection(step.parallel, snapshot);
      signal?.throwIfAborted();
    } catch (error) {
      recordAgentUsageEvent(
        this.deps.engineOptions,
        `dynamic-selector:${identity}`,
        'parallel',
        selectorProvider,
        false,
        response?.providerUsage,
      );
      signal?.throwIfAborted();
      throw new Error(redact(getErrorMessage(error)));
    }
    recordAgentUsageEvent(
      this.deps.engineOptions,
      `dynamic-selector:${identity}`,
      'parallel',
      selectorProvider,
      true,
      response.providerUsage,
    );
    signal?.throwIfAborted();
    await this.deps.commitSelection(identity, snapshot);
    signal?.throwIfAborted();
    state.activeDynamicParallelSelectionIdentity = identity;
    this.logSelection(step, identity, snapshot, 'selector', {
      selectorProvider: selectorProvider.provider,
      selectorProviderSource: selectorProvider.providerSource,
      rationale: truncateUtf8(selectorResult.rationale, SELECTOR_RATIONALE_LOG_MAX_BYTES).value,
    });
    signal?.throwIfAborted();
    return participants;
  }

  private resolveIdentity(stepName: string): string {
    return buildDynamicParallelSelectionIdentityFromPath(
      this.deps.getWorkflowReference(),
      stepName,
      this.deps.workflowCallPath,
    );
  }

  private logSelection(
    step: WorkflowStep,
    identity: string,
    snapshot: DynamicParallelSelectionSnapshot,
    selectionSource: 'selector',
    selectorDetails?: {
      readonly selectorProvider: string;
      readonly selectorProviderSource: string | undefined;
      readonly rationale: string;
    },
  ): void {
    if (!step.parallel || !isDynamicParallelSubSteps(step.parallel)) {
      throw new Error(`Step "${step.name}" is not a dynamic parallel step`);
    }
    const selected = new Set(snapshot.selected_pool_ids);
    log.debug('Dynamic parallel selection resolved', {
      step: step.name,
      identity,
      round: snapshot.round,
      mode: step.parallel.selection.mode,
      selectionSource,
      ...selectorDetails,
      fixed: step.parallel.fixed.map((subStep) => subStep.name),
      selected: step.parallel.pool
        .filter((subStep) => selected.has(subStep.name))
        .map((subStep) => subStep.name),
      unselected: step.parallel.pool
        .filter((subStep) => !selected.has(subStep.name))
        .map((subStep) => subStep.name),
    });
  }
}
