import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type DynamicParallelSelectionSnapshot,
  type WorkflowConfig,
  type WorkflowStep,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { getWorkflowStepKind } from '../step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { serializeWorkflowExecutionOwnerIdentity } from '../../models/workflow-resume-contract.js';
import {
  isWithinDynamicParallelSelectionScope,
  parseDynamicParallelSelectionIdentity,
} from './identity.js';
import { cloneDynamicParallelSelectionSnapshot, resolveDynamicParallelSelection } from './snapshot.js';
import { workflowOwnerPathFromStack } from '../workflow-execution-scope.js';

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
  let containingOwner: WorkflowStep | undefined;
  const references = new Set([getWorkflowReference(workflow)]);
  for (let index = prefixLength; index < parsed.owners.length; index += 1) {
    const owner = parsed.owners[index]!;
    if (owner.workflow !== getWorkflowReference(workflow)) return undefined;
    if (owner.kind !== 'workflow_call') {
      if (containingOwner !== undefined) return undefined;
      const step = workflow.steps.find((candidate) => candidate.name === owner.step);
      if (step === undefined || getWorkflowStepKind(step) !== owner.kind) return undefined;
      containingOwner = step;
      continue;
    }
    const candidates = containingOwner === undefined
      ? workflow.steps
      : containingOwner.parallel === undefined
        ? []
        : getAllParallelSubSteps(containingOwner.parallel);
    const step = candidates.find((candidate) => candidate.name === owner.step);
    if (step === undefined || !isWorkflowCallStep(step) || options.workflowCallResolver === undefined) {
      return undefined;
    }
    const invocationIdentity = serializeWorkflowExecutionOwnerIdentity({
      workflow: owner.workflow,
      step: owner.step,
      owners: parsed.owners.slice(0, index),
    });
    const invocation = options.resumePoint?.workflow_call_invocations[invocationIdentity];
    if (invocation === undefined || invocation.call_instance !== owner.instance) {
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
    if (invocation.child_workflow_ref !== childReference) return undefined;
    if (references.has(childReference) || references.size + 1 > MAX_WORKFLOW_CALL_DEPTH) return undefined;
    references.add(childReference);
    workflow = child;
    containingOwner = undefined;
  }
  if (containingOwner !== undefined) return undefined;
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
  const prefix = workflowOwnerPathFromStack(options.resumeStackPrefix ?? []);
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
