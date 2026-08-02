import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';

vi.mock('../core/workflow/workflow-call-namespace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildWorkflowCallNamespaceSegment: vi.fn(() => (
    `call-v2-${'0'.repeat(64)}-${'1'.repeat(64)}-1`
  )),
}));

const { WorkflowCallInvocationIndex } = await import(
  '../core/workflow/workflow-call-invocation-index.js'
);

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
      child_workflow_ref: 'child',
    });

    expect(() => index.record(makeWorkflow('second'), 'delegate', [], {
      call_instance: 1,
      child_workflow_ref: 'child',
    })).toThrow('Workflow-call storage key is already assigned to invocation');
  });
});
