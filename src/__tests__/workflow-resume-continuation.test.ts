import { describe, expect, it } from 'vitest';
import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowState,
} from '../core/models/index.js';
import { WorkflowResumeContinuation } from '../core/workflow/engine/workflow-resume-continuation.js';
import { buildScopedStepIterationIdentity } from '../core/workflow/step-iteration-identity.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';

describe('WorkflowResumeContinuation', () => {
  it('nested workflow_callのsource continuationを一度だけ消費する', () => {
    const parentWorkflow = {
      name: 'parent',
      initialStep: 'outer-call',
      maxSteps: 10,
      steps: [{
        name: 'outer-call',
        kind: 'workflow_call',
        call: 'child',
        rules: [],
      }],
    } as WorkflowConfig;
    const childWorkflow = {
      name: 'child',
      subworkflow: { callable: true },
      initialStep: 'nested-call',
      maxSteps: 10,
      steps: [{
        name: 'nested-call',
        kind: 'workflow_call',
        call: 'grandchild',
        rules: [],
      }],
    } as WorkflowConfig;
    const parentFrame = buildWorkflowResumePointEntry(
      parentWorkflow,
      'outer-call',
      'workflow_call',
      2,
      new Map([['outer-call', 2]]),
    );
    const nestedFrame = buildWorkflowResumePointEntry(
      childWorkflow,
      'nested-call',
      'workflow_call',
      3,
      new Map([['nested-call', 3]]),
    );
    const source: WorkflowResumePoint = {
      version: 1,
      stack: [parentFrame, nestedFrame],
      iteration: 8,
      elapsed_ms: 100,
    };
    const state: WorkflowState = {
      workflowName: childWorkflow.name,
      currentStep: 'nested-call',
      iteration: 8,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map([['nested-call', 3]]),
      status: 'running',
    };
    const step = childWorkflow.steps[0]!;
    const continuation = new WorkflowResumeContinuation(childWorkflow, source);

    const sourceOccurrence = continuation.claimStepOccurrence({
      step,
      resumeStackPrefix: [parentFrame],
      state,
    });
    expect(sourceOccurrence).toBe(3);
    expect(continuation.consumeWorkflowCallFrame({
      step,
      occurrence: sourceOccurrence,
      resumeStackPrefix: [parentFrame],
    })).toEqual(nestedFrame);

    const nextOccurrence = continuation.claimStepOccurrence({
      step,
      resumeStackPrefix: [parentFrame],
      state,
    });
    expect(nextOccurrence).toBe(4);
    expect(continuation.consumeWorkflowCallFrame({
      step,
      occurrence: nextOccurrence,
      resumeStackPrefix: [parentFrame],
    })).toBeUndefined();
  });

  it('parallel source frameを同名の通常agentがclaimしない', () => {
    const workflow = {
      name: 'parent',
      initialStep: 'reviewers',
      maxSteps: 10,
      steps: [{
        name: 'reviewers',
        kind: 'agent',
        persona: 'reviewer',
        personaDisplayName: 'reviewer',
        instruction: 'Review normally',
        rules: [],
      }],
    } as WorkflowConfig;
    const source: WorkflowResumePoint = {
      version: 1,
      stack: [{
        workflow: 'parent',
        workflow_ref: 'parent',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 4,
        step_iterations: { reviewers: 4 },
      }],
      iteration: 8,
      elapsed_ms: 100,
    };
    const state: WorkflowState = {
      workflowName: workflow.name,
      currentStep: 'reviewers',
      iteration: 8,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };
    const continuation = new WorkflowResumeContinuation(workflow, source);

    expect(continuation.claimStepOccurrence({
      step: workflow.steps[0]!,
      resumeStackPrefix: [],
      state,
    })).toBe(1);
    expect(state.stepIterations.get('reviewers')).toBe(1);
  });

  it('top-levelとparallel descendantの同名workflow_call occurrenceを独立してresumeする', () => {
    const descendantIdentity = buildScopedStepIterationIdentity(
      'delegate',
      ['reviewers'],
    );
    const workflow = {
      name: 'parent',
      initialStep: 'reviewers',
      maxSteps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [],
        },
        {
          name: 'reviewers',
          parallel: [{
            name: 'delegate',
            kind: 'workflow_call',
            call: 'child',
            rules: [],
          }],
          rules: [],
        },
      ],
    } as WorkflowConfig;
    const parentFrame = buildWorkflowResumePointEntry(
      workflow,
      'reviewers',
      'parallel',
      2,
      new Map([
        ['delegate', 4],
        ['reviewers', 2],
        [descendantIdentity, 3],
      ]),
    );
    const descendantFrame = buildWorkflowResumePointEntry(
      workflow,
      'delegate',
      'workflow_call',
      3,
    );
    const source: WorkflowResumePoint = {
      version: 1,
      stack: [parentFrame, descendantFrame],
      iteration: 9,
      elapsed_ms: 100,
    };
    const state: WorkflowState = {
      workflowName: workflow.name,
      currentStep: 'reviewers',
      iteration: 9,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map([
        ['delegate', 4],
        ['reviewers', 2],
        [descendantIdentity, 3],
      ]),
      status: 'running',
    };
    const continuation = new WorkflowResumeContinuation(workflow, source);
    const parentOccurrence = continuation.claimStepOccurrence({
      step: workflow.steps[1]!,
      resumeStackPrefix: [],
      state,
    });
    const descendantOccurrence = continuation.claimStepOccurrence({
      step: workflow.steps[1]!.parallel![0]!,
      resumeStackPrefix: [parentFrame],
      state,
    });

    expect(parentOccurrence).toBe(2);
    expect(descendantOccurrence).toBe(3);
    expect(state.stepIterations.get('delegate')).toBe(4);
    expect(state.stepIterations.get(descendantIdentity)).toBe(3);
  });
});
