import type {
  WorkflowCallInvocationRecord,
  WorkflowResumePointEntry,
} from '../../core/models/index.js';
import { buildWorkflowCallInvocationIdentity } from '../../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallNamespaceSegment } from '../../core/workflow/workflow-call-namespace.js';

export function buildWorkflowCallNamespaceFixture(
  _workflowReference: string,
  step: string,
  _ownerPath: readonly WorkflowResumePointEntry[],
  childWorkflowReference: string,
  callInstance: number | '*',
): string {
  return buildWorkflowCallNamespaceSegment(
    step,
    childWorkflowReference,
    callInstance,
  );
}

export interface WorkflowCallInvocationFixture {
  readonly workflowReference: string;
  readonly step: string;
  readonly ownerPath: readonly WorkflowResumePointEntry[];
  readonly childWorkflowReference: string;
  readonly callInstance: number;
}

export function buildWorkflowCallInvocationRecordsFixture(
  invocations: readonly WorkflowCallInvocationFixture[],
): Record<string, WorkflowCallInvocationRecord> {
  return Object.fromEntries(invocations.map((invocation) => [
    buildWorkflowCallInvocationIdentity(
      invocation.workflowReference,
      invocation.step,
      invocation.ownerPath,
    ),
    {
      call_instance: invocation.callInstance,
      report_namespace_segment: buildWorkflowCallNamespaceFixture(
        invocation.workflowReference,
        invocation.step,
        invocation.ownerPath,
        invocation.childWorkflowReference,
        invocation.callInstance,
      ),
    },
  ]));
}

export function buildWorkflowCallInvocationFixture(
  stack: readonly WorkflowResumePointEntry[],
): Record<string, WorkflowCallInvocationRecord> {
  return buildWorkflowCallInvocationRecordsFixture(stack.flatMap((entry, index) => {
    if (entry.kind !== 'workflow_call' || entry.call_instance === undefined) {
      return [];
    }
    const childEntry = stack[index + 1];
    if (childEntry === undefined) {
      throw new Error(`workflow_call fixture is missing its child entry: ${entry.step}`);
    }
    return [{
      workflowReference: entry.workflow_ref,
      step: entry.step,
      ownerPath: stack.slice(0, index),
      callInstance: entry.call_instance,
      childWorkflowReference: childEntry.workflow_ref,
    }];
  }));
}
