import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowRestartPointEntry,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import {
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
  workflowRestartEntryMatchesWorkflow,
} from '../workflow-reference.js';
import { isWorkflowRestartTarget } from '../workflow-restart-target.js';

export class WorkflowRestartNavigator {
  private active = true;

  constructor(private readonly restartPoint: WorkflowRestartPoint) {}

  isActive(): boolean {
    return this.active;
  }

  resolveRootStartStep(
    rootWorkflow: WorkflowConfig,
    explicitStartStep: string | undefined,
  ): string {
    const rootEntry = this.restartPoint.stack[0]!;
    const targetStep = this.resolveEntryStep(rootEntry, rootWorkflow, 'root');
    if (explicitStartStep !== undefined && explicitStartStep !== targetStep.name) {
      throw new Error(
        `Workflow start step "${explicitStartStep}" does not match restart path step "${targetStep.name}"`,
      );
    }
    if (!isWorkflowCallStep(targetStep)) {
      if (this.restartPoint.stack.length !== 1) {
        throw new Error(`Restart path cannot continue after non-call step "${rootEntry.step}"`);
      }
      this.active = false;
    }
    return targetStep.name;
  }

  resolveChildStartStep(
    childWorkflow: WorkflowConfig,
    callStack: readonly WorkflowResumePointEntry[],
    onWarning: (message: string) => void,
  ): string | undefined {
    if (!this.active) {
      return undefined;
    }
    this.assertCallStackMatches(callStack, onWarning);

    const nextEntry = this.restartPoint.stack[callStack.length];
    if (nextEntry === undefined) {
      this.active = false;
      return undefined;
    }
    const targetStep = this.resolveEntryStep(nextEntry, childWorkflow, 'child');
    if (!isWorkflowCallStep(targetStep)) {
      if (callStack.length + 1 !== this.restartPoint.stack.length) {
        throw new Error(`Restart path cannot continue after non-call step "${nextEntry.step}"`);
      }
      this.active = false;
    }
    return targetStep.name;
  }

  private resolveEntryStep(
    entry: WorkflowRestartPointEntry,
    workflow: WorkflowConfig,
    relationship: 'root' | 'child',
  ): WorkflowStep {
    if (!workflowRestartEntryMatchesWorkflow(entry, workflow)) {
      throw new Error(
        `Restart path workflow "${entry.workflow}" (ref "${entry.workflow_ref}") does not match ${relationship} workflow "${workflow.name}" (ref "${getWorkflowReference(workflow)}")`,
      );
    }
    const targetStep = workflow.steps.find((step) => step.name === entry.step);
    if (targetStep === undefined || getWorkflowStepKind(targetStep) !== entry.kind) {
      throw new Error(
        `Restart path step "${entry.step}" does not match workflow "${workflow.name}"`,
      );
    }
    if (!isWorkflowRestartTarget(targetStep)) {
      throw new Error(
        `Restart path step "${entry.step}" is not eligible for an authored restart`,
      );
    }
    return targetStep;
  }

  private assertCallStackMatches(
    callStack: readonly WorkflowResumePointEntry[],
    onWarning: (message: string) => void,
  ): void {
    if (callStack.length > this.restartPoint.stack.length) {
      throw new Error('Runtime workflow_call stack exceeds the selected restart path');
    }
    for (let index = 0; index < callStack.length; index += 1) {
      const runtimeEntry = callStack[index]!;
      const normalizedRuntimeEntry = normalizeWorkflowResumePointEntry(runtimeEntry);
      const selectedEntry = this.restartPoint.stack[index]!;
      if (
        normalizedRuntimeEntry.workflow_ref !== selectedEntry.workflow_ref
        || runtimeEntry.step !== selectedEntry.step
        || runtimeEntry.kind !== selectedEntry.kind
      ) {
        throw new Error(
          `Runtime workflow_call stack does not match restart path at "${selectedEntry.workflow} > ${selectedEntry.step}"`,
        );
      }
      if (normalizedRuntimeEntry.call_instance !== selectedEntry.call_instance) {
        onWarning(
          `Runtime workflow_call call_instance differs from restart path at "${selectedEntry.workflow} > ${selectedEntry.step}" `
          + `(recorded_call_instance=${selectedEntry.call_instance}, runtime_call_instance=${normalizedRuntimeEntry.call_instance}); `
          + 'continuing from the selected restart step',
        );
      }
    }
  }
}
