import type { WorkflowEvents } from '../../core/workflow/types.js';

type WorkflowCallStart = Parameters<WorkflowEvents['workflow_call:start']>[0];
type WorkflowCallComplete = Parameters<WorkflowEvents['workflow_call:complete']>[0];

const start = {
  parentWorkflow: 'parent',
  step: 'delegate',
  childWorkflow: 'shared/review',
  callInstance: 1,
  stack: [
    {
      workflow: 'parent',
      workflow_ref: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      occurrence: 1,
      call_instance: 1,
    },
  ],
} satisfies WorkflowCallStart;

const complete = {
  ...start,
  result: {
    status: 'completed' as const,
    returnValue: 'approved',
  },
} satisfies WorkflowCallComplete;

const aborted = {
  ...start,
  result: {
    status: 'aborted' as const,
    abortKind: 'iteration_limit' as const,
    abortReason: 'Maximum steps reached',
  },
} satisfies WorkflowCallComplete;

void start;
void complete;
void aborted;
