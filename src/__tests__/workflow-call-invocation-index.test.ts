import { describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import {
  WorkflowCallInvocationIndex,
  buildWorkflowCallInvocationIdentity,
  restoreWorkflowCallInvocationEvidence,
  serializeWorkflowCallInvocationEvidence,
} from '../core/workflow/workflow-call-invocation-index.js';

function makeWorkflow(name: string): WorkflowConfig {
  return {
    name,
    initialStep: 'delegate',
    maxSteps: 3,
    steps: [],
  };
}

describe('WorkflowCallInvocationIndex', () => {
  it('should distinguish the same nested call step under different ancestor invocations', () => {
    const parent = makeWorkflow('parent');
    const child = makeWorkflow('child');
    const firstParentCall = buildWorkflowResumePointEntry(
      parent,
      'delegate',
      'workflow_call',
      1,
      undefined,
      1,
    );
    const secondParentCall = buildWorkflowResumePointEntry(
      parent,
      'delegate',
      'workflow_call',
      2,
      undefined,
      2,
    );
    const index = new WorkflowCallInvocationIndex(new Map());

    index.record(child, 'nested', [firstParentCall], {
      call_instance: 4,
      report_namespace_segment: 'iteration-10--step-nested--workflow-grandchild',
    });
    index.record(child, 'nested', [secondParentCall], {
      call_instance: 7,
      report_namespace_segment: 'iteration-20--step-nested--workflow-grandchild',
    });

    expect(index.get(child, 'nested', [firstParentCall])).toEqual({
      call_instance: 4,
      report_namespace_segment: 'iteration-10--step-nested--workflow-grandchild',
    });
    expect(index.get(child, 'nested', [secondParentCall])).toEqual({
      call_instance: 7,
      report_namespace_segment: 'iteration-20--step-nested--workflow-grandchild',
    });
  });

  it('removes only older invocations of a repeated static parallel parent', () => {
    const outer = makeWorkflow('outer');
    const workflow = makeWorkflow('parent');
    const outerCall = buildWorkflowResumePointEntry(outer, 'delegate', 'workflow_call', 1, undefined, 1);
    const firstParent = buildWorkflowResumePointEntry(workflow, 'reviewers', 'parallel', 1);
    const secondParent = buildWorkflowResumePointEntry(workflow, 'reviewers', 'parallel', 2);
    const otherParent = buildWorkflowResumePointEntry(workflow, 'other', 'parallel', 1);
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(outer, 'delegate', [], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-parent',
      completed: true,
    });
    index.record(workflow, 'child', [outerCall, firstParent], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-child--workflow-review',
      completed: true,
    });
    index.record(workflow, 'child', [outerCall, secondParent], {
      call_instance: 2,
      report_namespace_segment: 'iteration-2--step-child--workflow-review',
    });
    index.record(workflow, 'other-child', [outerCall, otherParent], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-other-child--workflow-review',
      completed: true,
    });

    index.clearPreviousParallelChildInvocations(workflow, 'reviewers', ['child'], [outerCall], 2);

    expect(index.get(workflow, 'child', [outerCall, firstParent])).toBeUndefined();
    expect(index.get(workflow, 'child', [outerCall, secondParent])).toMatchObject({ call_instance: 2 });
    expect(index.get(workflow, 'other-child', [outerCall, otherParent])).toMatchObject({ completed: true });
    expect(index.get(outer, 'delegate', [])).toMatchObject({ completed: true });
  });

  it('should reject a persisted invocation that disagrees with the resume stack', () => {
    const parent = makeWorkflow('parent');
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);
    const invocation = {
      call_instance: 1,
      report_namespace_segment: 'iteration-11--step-delegate--workflow-child',
    };
    const index = new WorkflowCallInvocationIndex(new Map([[identity, invocation]]));

    expect(() => index.validateResumePoint({
      version: 2,
      stack: [buildWorkflowResumePointEntry(
        parent,
        'delegate',
        'workflow_call',
        2,
        new Map([['delegate', 2]]),
        2,
      )],
      iteration: 2,
      elapsed_ms: 0,
      workflow_call_invocations: { [identity]: invocation },
      workflow_step_participations: {},
    })).toThrow('Workflow-call invocation identity does not match resume entry "delegate"');
  });

  it('should serialize a defensive snapshot of the current invocation per canonical path', () => {
    const workflow = makeWorkflow('parent');
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(workflow, 'delegate', [], {
      call_instance: 1,
      report_namespace_segment: 'iteration-8--step-delegate--workflow-child',
    });
    index.record(workflow, 'delegate', [], {
      call_instance: 2,
      report_namespace_segment: 'iteration-21--step-delegate--workflow-child',
    });

    const serialized = index.serialized();

    expect(serialized).toEqual({
      [buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]: {
        call_instance: 2,
        report_namespace_segment: 'iteration-21--step-delegate--workflow-child',
      },
    });
    serialized[buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]!.call_instance = 9;
    expect(index.get(workflow, 'delegate', [])).toEqual({
      call_instance: 2,
      report_namespace_segment: 'iteration-21--step-delegate--workflow-child',
    });
  });

  it('should preserve an explicit empty exact index when serializing current evidence', () => {
    const evidence = restoreWorkflowCallInvocationEvidence({
      version: 2,
      stack: [{
        workflow: 'parent',
        workflow_ref: 'parent',
        step: 'prepare',
        kind: 'agent',
        occurrence: 1,
      }],
      iteration: 0,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    });

    expect(evidence.kind).toBe('exact');
    expect(serializeWorkflowCallInvocationEvidence(evidence)).toEqual({});
  });

  it('should reject an invalid persisted report namespace segment', () => {
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);

    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      report_namespace_segment: 'iteration-*--step-delegate--workflow-child',
    }]]))).toThrow('has an invalid report namespace segment');
  });

  it.each([
    {
      label: 'an extra property',
      identity: '{"workflow":"parent","step":"delegate","calls":[],"extra":true}',
    },
    {
      label: 'a non-canonical key order',
      identity: '{"step":"delegate","workflow":"parent","calls":[]}',
    },
    {
      label: 'a non-canonical JSON representation',
      identity: '{ "workflow":"parent","step":"delegate","calls":[]}',
    },
    {
      label: 'a qualified parallel participation identity',
      identity: '{"workflow":"parent","step":"delegate","calls":[],"parallel_parent":"reviewers"}',
    },
  ])('should reject persisted invocation identity with $label', ({ identity }) => {
    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-child',
    }]]))).toThrow('Invalid workflow-call invocation identity');
  });

  it.each([
    {
      label: 'an unknown ancestor frame kind',
      identity: '{"workflow":"child","step":"nested","calls":[{"workflow":"parent","step":"delegate","kind":"unknown","instance":1}]}',
    },
    {
      label: 'a zero nested call instance',
      identity: '{"workflow":"child","step":"nested","calls":[{"workflow":"parent","step":"delegate","kind":"workflow_call","instance":0}]}',
    },
    {
      label: 'an extra nested call property',
      identity: '{"workflow":"child","step":"nested","calls":[{"workflow":"parent","step":"delegate","kind":"workflow_call","instance":1,"extra":true}]}',
    },
  ])('should reject persisted nested invocation identity with $label', ({ identity }) => {
    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-nested--workflow-grandchild',
    }]]))).toThrow('Invalid workflow-call invocation identity');
  });

  it('should reject a persisted invocation namespace with iteration zero', () => {
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);

    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      report_namespace_segment: 'iteration-0--step-delegate--workflow-child',
    }]]))).toThrow('has an invalid report namespace segment');
  });

  it('should reject one report namespace assigned to different logical identities', () => {
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
