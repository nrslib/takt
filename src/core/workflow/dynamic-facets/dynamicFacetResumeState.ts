import type {
  DynamicFacetSelectionSnapshot,
  NormalAgentWorkflowStep,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowStep,
} from '../../models/types.js';
import {
  getAllParallelSubSteps,
  isNormalAgentWorkflowStep,
} from '../../models/workflow-types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { getWorkflowReference } from '../workflow-reference.js';
import {
  isWithinDynamicParallelSelectionScope,
  parseDynamicParallelSelectionIdentity,
} from '../dynamic-parallel/identity.js';
import { cloneDynamicFacetSelectionSnapshot } from './dynamicFacetSelectionStore.js';

function restoreDynamicFacetSelections(
  resumePoint: WorkflowResumePoint | undefined,
): Map<string, DynamicFacetSelectionSnapshot> {
  const raw = resumePoint?.dynamic_facet_selections;
  if (!raw) return new Map();
  const selections = new Map<string, DynamicFacetSelectionSnapshot>();
  for (const [identity, snapshot] of Object.entries(raw)) {
    if (snapshot.identity !== identity) {
      throw new Error(`Invalid dynamic facet selection snapshot for identity "${identity}"`);
    }
    selections.set(identity, cloneDynamicFacetSelectionSnapshot(snapshot));
  }
  return selections;
}

function resolveDynamicFacetStep(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
  identity: string,
  prefixLength: number,
): NormalAgentWorkflowStep | undefined {
  const parsed = parseDynamicParallelSelectionIdentity(identity);
  if (parsed === undefined) return undefined;
  let workflow = config;
  const references = new Set([getWorkflowReference(workflow)]);
  for (const call of parsed.calls.slice(prefixLength)) {
    if (call.workflow !== getWorkflowReference(workflow)) return undefined;
    const step = workflow.steps
      .flatMap((candidate): readonly WorkflowStep[] =>
        candidate.parallel === undefined
          ? [candidate]
          : [candidate, ...getAllParallelSubSteps(candidate.parallel)],
      )
      .find((candidate) => candidate.name === call.step);
    if (step === undefined) {
      return undefined;
    }
    if (call.kind !== 'workflow_call') {
      continue;
    }
    if (!isWorkflowCallStep(step) || options.workflowCallResolver === undefined) return undefined;
    const child = options.workflowCallResolver({
      parentWorkflow: workflow,
      step,
      projectCwd: options.projectCwd,
      lookupCwd: options.projectCwd,
    });
    if (child === null || child === undefined || child.subworkflow?.callable !== true) return undefined;
    const childReference = getWorkflowReference(child);
    if (references.has(childReference) || references.size + 1 > MAX_WORKFLOW_CALL_DEPTH) return undefined;
    references.add(childReference);
    workflow = child;
  }
  if (parsed.workflow !== getWorkflowReference(workflow)) return undefined;
  const step = workflow.steps.find((candidate) => candidate.name === parsed.step);
  if (step === undefined || !isNormalAgentWorkflowStep(step) || step.dynamicFacets === undefined) return undefined;
  return step;
}

function validateDynamicFacetSelections(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
  selections: ReadonlyMap<string, DynamicFacetSelectionSnapshot>,
): void {
  if (selections.size === 0) return;
  const prefix = options.resumeStackPrefix ?? [];
  for (const [identity, snapshot] of selections) {
    if (!isWithinDynamicParallelSelectionScope(identity, prefix)) {
      if (prefix.length === 0) throw new Error(`Dynamic facet selection snapshot identity "${identity}" does not match a reachable dynamic facet step`);
      continue;
    }
    const step = resolveDynamicFacetStep(config, options, identity, prefix.length);
    if (!step) throw new Error(`Dynamic facet selection snapshot identity "${identity}" does not match a reachable dynamic facet step`);
    if (snapshot.step_name !== step.name) throw new Error(`Dynamic facet selection snapshot step_name does not match resumed step "${step.name}"`);
    if (step.dynamicFacets !== undefined) {
      const pool = config.facetPools?.[step.dynamicFacets.pool];
      if (pool === undefined) {
        throw new Error(
          `Dynamic facet selection snapshot for step "${step.name}" references pool "${step.dynamicFacets.pool}" that is not loaded`,
        );
      }
      const knownIds = new Set(pool.candidates.map((candidate) => candidate.id));
      const missingId = snapshot.selected_ids.find((id) => !knownIds.has(id));
      if (missingId !== undefined) {
        throw new Error(
          `Dynamic facet selection snapshot for step "${step.name}" references candidate id "${missingId}" that is not in pool "${pool.name}"`,
        );
      }
      if (snapshot.selected_ids.length > step.dynamicFacets.maxSelected) {
        throw new Error(
          `Dynamic facet selection snapshot for step "${step.name}" has ${snapshot.selected_ids.length} selected ids but max_selected is ${step.dynamicFacets.maxSelected}`,
        );
      }
    }
  }
}

export function restoreAndValidateDynamicFacetSelections(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): Map<string, DynamicFacetSelectionSnapshot> {
  const selections = restoreDynamicFacetSelections(options.resumePoint);
  validateDynamicFacetSelections(config, options, selections);
  return selections;
}