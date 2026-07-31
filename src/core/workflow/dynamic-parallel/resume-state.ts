import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type DynamicParallelSelectionSnapshot,
  type WorkflowConfig,
  type WorkflowStep,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { getWorkflowReference } from '../workflow-reference.js';
import {
  isWithinDynamicParallelSelectionScope,
  parseDynamicParallelSelectionIdentity,
} from './identity.js';
import { cloneDynamicParallelSelectionSnapshot, resolveDynamicParallelSelection } from './snapshot.js';

export function restoreAndValidateDynamicParallelSelections(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): Map<string, DynamicParallelSelectionSnapshot> {
  const selections = restoreDynamicParallelSelections(options.resumePoint);
  validateDynamicParallelSelections(config, options, selections);
  return selections;
}

function restoreDynamicParallelSelections(
  resumePoint: WorkflowEngineOptions['resumePoint'],
): Map<string, DynamicParallelSelectionSnapshot> {
  return new Map(Object.entries(resumePoint?.dynamic_parallel_selections ?? {}).map(([identity, snapshot]) => {
    if (snapshot.identity !== identity) {
      throw new Error(`Invalid dynamic parallel selection snapshot for identity "${identity}"`);
    }
    return [identity, cloneDynamicParallelSelectionSnapshot(snapshot)];
  }));
}

function resolveDynamicStep(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
  identity: string,
  prefixLength: number,
): WorkflowStep | undefined {
  const parsed = parseDynamicParallelSelectionIdentity(identity);
  if (parsed === undefined) return undefined;
  let workflow = config;
  const references = new Set([getWorkflowReference(workflow)]);
  for (const call of parsed.calls.slice(prefixLength)) {
    if (call.workflow !== getWorkflowReference(workflow) || call.kind !== 'workflow_call') return undefined;
    const step = workflow.steps
      .flatMap((candidate) => candidate.parallel === undefined
        ? [candidate]
        : [candidate, ...getAllParallelSubSteps(candidate.parallel)])
      .find((candidate) => candidate.name === call.step);
    if (step === undefined || !isWorkflowCallStep(step) || options.workflowCallResolver === undefined) {
      return undefined;
    }
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
  return workflow.steps.find((step) =>
    step.name === parsed.step
    && step.parallel !== undefined
    && isDynamicParallelSubSteps(step.parallel));
}

function validateDynamicParallelSelections(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
  selections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>,
): void {
  if (selections.size === 0) return;
  const prefix = options.resumeStackPrefix ?? [];
  for (const [identity, snapshot] of selections) {
    if (!isWithinDynamicParallelSelectionScope(identity, prefix)) {
      if (prefix.length === 0) throw new Error(`Dynamic parallel selection snapshot identity "${identity}" does not match a reachable dynamic parallel step`);
      continue;
    }
    const step = resolveDynamicStep(config, options, identity, prefix.length);
    if (!step) throw new Error(`Dynamic parallel selection snapshot identity "${identity}" does not match a reachable dynamic parallel step`);
    if (!step.parallel || !isDynamicParallelSubSteps(step.parallel)) throw new Error(`Dynamic parallel selection snapshot references non-dynamic step "${step.name}"`);
    if (snapshot.step_name !== step.name) throw new Error(`Dynamic parallel selection snapshot step_name does not match resumed step "${step.name}"`);
    resolveDynamicParallelSelection(step.parallel, snapshot);
  }
}
