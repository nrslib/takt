import {
  executeStructuredAgent,
  StructuredAgentResponseError,
} from '../../../agents/structured-caller/transport.js';
import type {
  AgentResponse,
  DynamicFacetSelectionSnapshot,
  AgentWorkflowStep,
  ResolvedFacetPool,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { recordAgentUsageEvent } from '../engine/agent-usage-event.js';
import { buildDynamicParallelSelectionIdentityFromPath } from '../dynamic-parallel/identity.js';
import {
  createSelectorContract,
  SELECTOR_READ_ONLY_TOOLS,
  validateSelectorResponse,
} from '../selector-contract.js';
import {
  buildDynamicFacetSelectorInstruction,
  buildDynamicFacetTargetAgentPrompt,
} from './dynamicFacetContextBuilder.js';
import { resolveSelectorReportNames } from '../dynamic-parallel/selector-input.js';
import { composeDynamicFacets, type FixedFacets } from './dynamicFacetComposer.js';
import type { DynamicFacetSelectionStore } from './dynamicFacetSelectionStore.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../../../shared/utils/sensitiveText.js';
import { SelectorInputReader } from '../dynamic-parallel/selector-input-reader.js';
import type {
  ProviderActivityCallback,
  StreamCallback,
} from '../../../shared/types/provider.js';
import { resolveSelectorPermissionMode } from '../selector-permission-resolution.js';

const log = createLogger('dynamic-facet-selector');
const SELECTOR_RATIONALE_LOG_MAX_BYTES = 1024;

export interface DynamicFacetSelectorCoordinatorDeps {
  readonly engineOptions: WorkflowEngineOptions;
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly onStream?: StreamCallback;
  readonly onActivity?: ProviderActivityCallback;
  readonly failureDir: string;
  readonly selectionStore: DynamicFacetSelectionStore;
  readonly getWorkflowReference: () => string;
  readonly workflowCallPath: readonly WorkflowResumePointEntry[];
  readonly commitSelection: (
    identity: string,
    snapshot: DynamicFacetSelectionSnapshot,
  ) => Promise<void>;
  readonly getReportDirectory: () => string;
  readonly getReportsRootDirectory: () => string;
  readonly getReportNames: (step: AgentWorkflowStep, state: WorkflowState) => readonly string[];
  readonly getCwd: () => string;
  readonly inputReader?: SelectorInputReader;
}

export interface DynamicFacetSelectionContext {
  readonly identityPath?: readonly WorkflowResumePointEntry[];
  readonly stepIteration?: number;
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
    step: AgentWorkflowStep,
    state: WorkflowState,
    task: string,
    pool: ResolvedFacetPool,
    context?: DynamicFacetSelectionContext,
  ): Promise<DynamicFacetSelectionResult> {
    const signal = this.deps.getAbortSignal?.() ?? this.deps.engineOptions.abortSignal;
    signal?.throwIfAborted();
    if (step.dynamicFacets === undefined) {
      throw new Error(`Step "${step.name}" has no dynamic_facets configuration`);
    }
    const identityPath = context?.identityPath ?? this.deps.workflowCallPath;
    const identity = this.resolveIdentity(step.name, identityPath);
    const stepIteration = context?.stepIteration ?? state.stepIterations.get(step.name);
    if (stepIteration === undefined) {
      throw new Error(`Dynamic facet selector for "${step.name}" requires a resolved step iteration`);
    }
    const selections = this.deps.selectionStore.snapshot();
    const selectorProvider = this.deps.engineOptions.selectorProvider;
    if (selectorProvider?.provider === undefined) {
      throw new Error(`Dynamic facet selector for "${step.name}" has no resolved provider`);
    }

    const poolIds = pool.candidates.map((candidate) => candidate.id);
    const selectorContract = createSelectorContract(
      pool.candidates.map(({ id, description }) => ({ name: id, description })),
      step.dynamicFacets.maxSelected,
    );
    const previous = selections.get(identity);

    const reportDirectory = this.deps.getReportDirectory();
    const reportNames = resolveSelectorReportNames({
      reportDirectory,
      reportsRootDirectory: this.deps.getReportsRootDirectory(),
      reportNames: this.deps.getReportNames(step, state),
      stepName: step.name,
      workflowReference: this.deps.getWorkflowReference(),
      workflowCallPath: identityPath,
    });
    if (this.deps.inputReader === undefined) {
      throw new Error('Dynamic facet selector requires an input reader');
    }
    const targetAgentPrompt = buildDynamicFacetTargetAgentPrompt(step);
    const inputs = await this.deps.inputReader.readInputs(
      reportDirectory,
      reportNames,
      this.deps.getCwd(),
      signal,
    );
    signal?.throwIfAborted();
    const instruction = buildDynamicFacetSelectorInstruction({
      task,
      workflowName: state.workflowName,
      stepName: step.name,
      workflowCallPath: identityPath,
      ...(previous === undefined ? {} : { previousSnapshot: previous }),
      stepIteration,
      reportDirectory: inputs.reportDirectory,
      reportNames: inputs.reportNames,
      changedPaths: inputs.changedPaths,
      targetAgentPrompt,
      pool,
      maxSelected: step.dynamicFacets.maxSelected,
      selectorInstruction: step.dynamicFacets.selector?.instruction,
    });

    const sensitiveValues = createBoundedSensitiveValues();
    sensitiveValues.collect({
      task,
      report_directory: inputs.reportDirectory,
      report_names: inputs.reportNames,
      changed_paths: inputs.changedPaths,
      targetAgentPrompt,
      candidates: pool.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description })),
    });
    const redact = (text: string): string => sanitizeSensitiveTextWithKnownValues(text, sensitiveValues);

    let response: AgentResponse | undefined;
    let selectorResult: ReturnType<typeof validateSelectorResponse>;
    let selectedIds: readonly string[];
    let snapshot: DynamicFacetSelectionSnapshot;
    try {
      response = await executeStructuredAgent(
        instruction,
        selectorContract.providerSchema,
        {
          name: 'dynamic-facet-selector',
          cwd: this.deps.getCwd(),
          projectCwd: this.deps.engineOptions.projectCwd,
          persona: step.dynamicFacets.selector?.persona,
          workflowBundleResourceRoot: this.deps.engineOptions.workflowBundleResourceRoot,
          systemPrompt: 'You are TAKT\'s internal dynamic facet selector. Select only candidate IDs from the provided pool.',
          abortSignal: signal,
          onStream: this.deps.onStream,
          onActivity: this.deps.onActivity,
          language: this.deps.engineOptions.language,
          failureDir: this.deps.failureDir,
          personaPath: step.dynamicFacets.selector?.personaPath,
          allowedTools: [...SELECTOR_READ_ONLY_TOOLS],
          allowedToolsSource: 'synthetic',
          resolution: {
            provider: selectorProvider.provider,
            model: selectorProvider.model,
            providerOptions: selectorProvider.providerOptions ?? {},
            ...resolveSelectorPermissionMode(selectorProvider.permissionMode),
          },
        },
      );
      signal?.throwIfAborted();
      selectorResult = validateSelectorResponse(
        response,
        selectorContract.validationSchema,
        step.name,
        redact,
        { label: 'Dynamic facet' },
      );
      signal?.throwIfAborted();
      selectedIds = selectorResult.selectedIds;
      if (
        step.dynamicFacets.maxSelected !== undefined
        && selectedIds.length > step.dynamicFacets.maxSelected
      ) {
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
      if (error instanceof StructuredAgentResponseError) {
        response = error.response;
      }
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
    await this.deps.commitSelection(identity, snapshot);
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
    step: AgentWorkflowStep,
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

  private resolveIdentity(
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
  ): string {
    return buildDynamicParallelSelectionIdentityFromPath(
      this.deps.getWorkflowReference(),
      stepName,
      workflowCallPath,
    );
  }

  private logSelection(
    step: AgentWorkflowStep,
    identity: string,
    snapshot: DynamicFacetSelectionSnapshot,
    selectionSource: 'selector',
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
