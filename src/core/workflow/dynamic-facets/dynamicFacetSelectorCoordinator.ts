import { executeIsolatedStructuredInternalAgent } from '../../../agents/agent-usecases.js';
import type {
  AgentResponse,
  DynamicFacetSelectionSnapshot,
  NormalAgentWorkflowStep,
  ResolvedFacetPool,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { recordAgentUsageEvent } from '../engine/agent-usage-event.js';
import { buildDynamicParallelSelectionIdentityFromPath } from '../dynamic-parallel/identity.js';
import {
  createSelectorOutputSchema,
  validateSelectorResponse,
} from '../dynamic-parallel/selector-contract.js';
import { buildDynamicFacetSelectorInstruction } from './dynamicFacetContextBuilder.js';
import { composeDynamicFacets, type FixedFacets } from './dynamicFacetComposer.js';
import type { DynamicFacetSelectionStore } from './dynamicFacetSelectionStore.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../../../shared/utils/sensitiveText.js';
import { SelectorInputReader } from '../dynamic-parallel/selector-input-reader.js';

const log = createLogger('dynamic-facet-selector');
const SELECTOR_RATIONALE_LOG_MAX_BYTES = 1024;

export interface DynamicFacetSelectorCoordinatorDeps {
  readonly engineOptions: WorkflowEngineOptions;
  readonly selectionStore: DynamicFacetSelectionStore;
  readonly getWorkflowReference: () => string;
  readonly workflowCallPath: readonly WorkflowResumePointEntry[];
  readonly commitSelection: (
    step: NormalAgentWorkflowStep,
    iteration: number,
    identity: string,
    snapshot: DynamicFacetSelectionSnapshot,
  ) => Promise<void>;
  readonly getReportDirectory: () => string;
  readonly getReportNames: (step: NormalAgentWorkflowStep, state: WorkflowState) => readonly string[];
  readonly getCwd: () => string;
  readonly inputReader?: SelectorInputReader;
  readonly getUnresolvedFindings: () => string;
}

export interface DynamicFacetSelectionResult {
  readonly selectedIds: readonly string[];
  readonly effectivePolicyContents: readonly string[];
  readonly effectiveKnowledgeContents: readonly string[];
  readonly snapshot: DynamicFacetSelectionSnapshot;
}

export class DynamicFacetSelectorCoordinator {
  constructor(private readonly deps: DynamicFacetSelectorCoordinatorDeps) {}

  async resolveDynamicFacets(
    step: NormalAgentWorkflowStep,
    state: WorkflowState,
    task: string,
    pool: ResolvedFacetPool,
  ): Promise<DynamicFacetSelectionResult> {
    const signal = this.deps.engineOptions.abortSignal;
    signal?.throwIfAborted();
    if (step.dynamicFacets === undefined) {
      throw new Error(`Step "${step.name}" has no dynamic_facets configuration`);
    }
    const identity = this.resolveIdentity(step.name);
    const selections = this.deps.selectionStore.snapshot();
    const resumed = state.resumedDynamicFacetSteps.has(identity)
      ? selections.get(identity)
      : undefined;

    if (resumed !== undefined) {
      signal?.throwIfAborted();
      const result = this.buildResultFromSnapshot(pool, resumed, step);
      state.resumedDynamicFacetSteps.delete(identity);
      state.activeDynamicFacetSelectionIdentity = identity;
      this.logSelection(step, identity, resumed, 'resume');
      signal?.throwIfAborted();
      return result;
    }

    const selectorProvider = this.deps.engineOptions.selectorProvider;
    if (selectorProvider?.provider === undefined) {
      throw new Error(`Dynamic facet selector for "${step.name}" has no resolved provider`);
    }

    const poolIds = pool.candidates.map((candidate) => candidate.id);
    const outputSchema = createSelectorOutputSchema(poolIds);
    const previous = selections.get(identity);

    const reportNames = this.deps.getReportNames(step, state);
    if (this.deps.inputReader === undefined) {
      throw new Error('Dynamic facet selector requires an input reader');
    }
    const inputs = await this.deps.inputReader.readInputs(
      this.deps.getReportDirectory(),
      reportNames,
      this.deps.getCwd(),
      signal,
    );
    signal?.throwIfAborted();
    const unresolvedFindings = this.deps.getUnresolvedFindings();

    const instruction = buildDynamicFacetSelectorInstruction({
      task,
      workflowName: state.workflowName,
      stepName: step.name,
      workflowCallPath: this.deps.workflowCallPath,
      isReentry: previous !== undefined,
      stepIteration: state.stepIterations.get(step.name) ?? 1,
      reports: inputs.reports,
      unresolvedFindings,
      cumulativeDiff: inputs.workingTreeDiff,
      pool,
      maxSelected: step.dynamicFacets.maxSelected,
    });

    const sensitiveValues = createBoundedSensitiveValues();
    sensitiveValues.collect({
      task,
      reports: inputs.reports,
      working_tree_diff: inputs.workingTreeDiff,
      candidates: pool.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description })),
      unresolved_findings: unresolvedFindings,
    });
    const redact = (text: string): string => sanitizeSensitiveTextWithKnownValues(text, sensitiveValues);

    let response: AgentResponse | undefined;
    let selectorResult: ReturnType<typeof validateSelectorResponse>;
    let selectedIds: readonly string[];
    let snapshot: DynamicFacetSelectionSnapshot;
    try {
      response = await executeIsolatedStructuredInternalAgent(
        'You are TAKT\'s internal dynamic facet selector. Select only candidate IDs from the provided pool.',
        instruction,
        outputSchema,
        {
          cwd: this.deps.getCwd(),
          projectCwd: this.deps.engineOptions.projectCwd,
          abortSignal: this.deps.engineOptions.abortSignal,
          language: this.deps.engineOptions.language,
          resolution: {
            provider: selectorProvider.provider,
            model: selectorProvider.model,
            providerOptions: selectorProvider.providerOptions,
          },
        },
      );
      signal?.throwIfAborted();
      selectorResult = validateSelectorResponse(response, outputSchema, step.name, redact, { label: 'Dynamic facet' });
      signal?.throwIfAborted();
      selectedIds = selectorResult.selectedIds;
      if (selectedIds.length > step.dynamicFacets.maxSelected) {
        throw new Error(
          `Dynamic facet selector for "${step.name}" selected ${selectedIds.length} candidates, exceeding max_selected ${step.dynamicFacets.maxSelected}`,
        );
      }
      const knownIds = new Set(poolIds);
      const unknownId = selectedIds.find((id) => !knownIds.has(id));
      if (unknownId !== undefined) {
        throw new Error(
          `Dynamic facet selector for "${step.name}" returned unknown candidate id "${unknownId}"`,
        );
      }
      snapshot = this.createSnapshot(identity, step.name, pool, selectedIds, selectorResult.rationale, previous);
      signal?.throwIfAborted();
    } catch (error) {
      recordAgentUsageEvent(
        this.deps.engineOptions,
        `dynamic-facet-selector:${identity}`,
        'normal',
        selectorProvider,
        false,
        response?.providerUsage,
      );
      signal?.throwIfAborted();
      throw new Error(redact(getErrorMessage(error)));
    }
    recordAgentUsageEvent(
      this.deps.engineOptions,
      `dynamic-facet-selector:${identity}`,
      'normal',
      selectorProvider,
      true,
      response.providerUsage,
    );
    signal?.throwIfAborted();
    await this.deps.commitSelection(step, state.iteration, identity, snapshot);
    signal?.throwIfAborted();
    state.activeDynamicFacetSelectionIdentity = identity;
    this.logSelection(step, identity, snapshot, 'selector', {
      selectorProvider: selectorProvider.provider,
      selectorProviderSource: selectorProvider.providerSource,
      rationale: truncateUtf8(selectorResult.rationale, SELECTOR_RATIONALE_LOG_MAX_BYTES).value,
    });
    signal?.throwIfAborted();
    return this.buildResult(pool, snapshot, selectedIds, step);
  }

  private createSnapshot(
    identity: string,
    stepName: string,
    pool: ResolvedFacetPool,
    selectedIds: readonly string[],
    rationale: string,
    previous: DynamicFacetSelectionSnapshot | undefined,
  ): DynamicFacetSelectionSnapshot {
    const selectedSet = new Set(selectedIds);
    const selectedPolicyRefs: string[] = [];
    const selectedKnowledgeRefs: string[] = [];
    for (const candidate of pool.candidates) {
      if (!selectedSet.has(candidate.id)) continue;
      selectedPolicyRefs.push(...candidate.policyRefs);
      selectedKnowledgeRefs.push(...candidate.knowledgeRefs);
    }
    return {
      identity,
      step_name: stepName,
      round: (previous?.round ?? 0) + 1,
      selected_ids: [...selectedIds],
      selected_policy_refs: selectedPolicyRefs,
      selected_knowledge_refs: selectedKnowledgeRefs,
      rationale,
    };
  }

  private buildResult(
    pool: ResolvedFacetPool,
    snapshot: DynamicFacetSelectionSnapshot,
    selectedIds: readonly string[],
    step: NormalAgentWorkflowStep,
  ): DynamicFacetSelectionResult {
    const fixed: FixedFacets = {
      policyContents: step.policyContents ?? [],
      knowledgeContents: step.knowledgeContents ?? [],
    };
    const composed = composeDynamicFacets(pool, selectedIds, fixed);
    return {
      selectedIds,
      effectivePolicyContents: composed.policyContents,
      effectiveKnowledgeContents: composed.knowledgeContents,
      snapshot,
    };
  }

  private buildResultFromSnapshot(
    pool: ResolvedFacetPool,
    snapshot: DynamicFacetSelectionSnapshot,
    step: NormalAgentWorkflowStep,
  ): DynamicFacetSelectionResult {
    const knownIds = new Set(pool.candidates.map((candidate) => candidate.id));
    const missingId = snapshot.selected_ids.find((id) => !knownIds.has(id));
    if (missingId !== undefined) {
      throw new Error(
        `Restored dynamic facet selection for step "${snapshot.step_name}" references candidate id "${missingId}" that is not in pool "${pool.name}"`,
      );
    }
    return this.buildResult(pool, snapshot, snapshot.selected_ids, step);
  }

  private resolveIdentity(stepName: string): string {
    return buildDynamicParallelSelectionIdentityFromPath(
      this.deps.getWorkflowReference(),
      stepName,
      this.deps.workflowCallPath,
    );
  }

  private logSelection(
    step: NormalAgentWorkflowStep,
    identity: string,
    snapshot: DynamicFacetSelectionSnapshot,
    selectionSource: 'selector' | 'resume',
    selectorDetails?: {
      readonly selectorProvider: string;
      readonly selectorProviderSource: string | undefined;
      readonly rationale: string;
    },
  ): void {
    log.debug('Dynamic facet selection resolved', {
      step: step.name,
      identity,
      round: snapshot.round,
      selectionSource,
      ...selectorDetails,
      selected: snapshot.selected_ids,
    });
  }
}