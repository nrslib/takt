import { describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';

function makeWorkflow(name: string): WorkflowConfig {
  return {
    name,
    initialStep: 'delegate',
    maxSteps: 3,
    steps: [],
  };
}

describe('WorkflowCallInvocationIndex storage collision handling', () => {
  it('should reject one storage key assigned to different logical identities', () => {
    const index = new WorkflowCallInvocationIndex(new Map());

    index.record(makeWorkflow('first'), 'delegate', [], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-child',
    });

    expect(() => index.record(makeWorkflow('second'), 'delegate', [], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-child',
    })).toThrow('Workflow-call report namespace is already assigned to another invocation');
  });
});
