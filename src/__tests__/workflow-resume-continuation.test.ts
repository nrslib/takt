import { describe, expect, it } from 'vitest';

import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowState,
} from '../core/models/index.js';
import { WorkflowResumeContinuation } from '../core/workflow/engine/workflow-resume-continuation.js';
import { buildScopedStepIterationIdentity } from '../core/workflow/step-iteration-identity.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { ResumeArtifactOccurrenceIndex } from '../core/workflow/run/resume-artifact-occurrence-index.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';

const ARTIFACT_HASH = '0'.repeat(64);

function invocationRecord(
  workflow: WorkflowConfig,
  stepName: string,
  childWorkflow: WorkflowConfig,
  workflowCallPath: WorkflowResumePoint['stack'],
  occurrence: number,
) {
  const frame = buildWorkflowResumePointEntry(
    workflow,
    stepName,
    'workflow_call',
    occurrence,
    undefined,
    occurrence,
  );
  return {
    identity: buildWorkflowCallInvocationIdentity(workflow.name, stepName, workflowCallPath),
    namespace: buildWorkflowCallSiteIdentity({
      stack: [...workflowCallPath, frame],
      childWorkflow,
    }).runPathSegment,
    occurrence,
  };
}

function artifactManifest(namespaces: readonly string[]) {
  return {
    version: 1 as const,
    sourceRunSlug: 'source-run',
    targetRunSlug: 'target-run',
    createdAt: new Date(0).toISOString(),
    files: namespaces.map((namespace) => ({
      path: `subworkflows/${namespace}/result.md`,
      size: 1,
      sha256: ARTIFACT_HASH,
    })),
  };
}

function withLegacyOccurrenceDigest(namespace: string, digestCharacter: string): string {
  return namespace.replace(/--site-[a-f0-9]{64}$/, `--site-${digestCharacter.repeat(64)}`);
}

function sourceResumePoint(records: readonly ReturnType<typeof invocationRecord>[]): WorkflowResumePoint {
  return {
    version: 2,
    stack: [],
    iteration: 1,
    elapsed_ms: 0,
    workflow_call_invocations: Object.fromEntries(records.map((record) => [record.identity, {
      call_instance: record.occurrence,
      report_namespace_segment: record.namespace,
    }])),
    workflow_step_participations: {},
  };
}

describe('WorkflowResumeContinuation', () => {
  it('通常実行の nested workflow_call namespace を祖先 invocation ごとに分離する', () => {
    const parent = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const grandchild = { name: 'grandchild', steps: [] } as unknown as WorkflowConfig;
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

    const first = invocationRecord(child, 'nested', grandchild, [firstParentCall], 1);
    const second = invocationRecord(child, 'nested', grandchild, [secondParentCall], 1);

    expect(first.namespace).not.toBe(second.namespace);
  });

  it('requeue で継承した workflow_call 成果物の最大 occurrence の続きから採番する', () => {
    const workflow = {
      name: 'parent',
      initialStep: 'remediation',
      maxSteps: 10,
      steps: [{
        name: 'remediation',
        kind: 'workflow_call',
        call: 'experimental-remediation',
        rules: [],
      }],
    } as WorkflowConfig;
    const state: WorkflowState = {
      workflowName: workflow.name,
      currentStep: 'remediation',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };
    const childWorkflow = {
      name: 'experimental-remediation',
      subworkflow: { callable: true },
      initialStep: 'fix',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const records = [1, 2, 6].map((occurrence) => invocationRecord(
      workflow,
      'remediation',
      childWorkflow,
      [],
      occurrence,
    ));
    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest(records.map((record) => record.namespace)),
      sourceResumePoint([records.at(-1)!]),
    );
    const continuation = new WorkflowResumeContinuation(workflow, undefined, index);

    expect(continuation.claimStepOccurrence({
      step: workflow.steps[0]!,
      resumeStackPrefix: [],
      state,
    })).toBe(7);
    expect(continuation.claimStepOccurrence({
      step: workflow.steps[0]!,
      resumeStackPrefix: [],
      state,
    })).toBe(8);
    expect(state.stepIterations.get('remediation')).toBe(8);
  });

  it('top-level と parallel 内の同名 workflow_call artifact を混同しない', () => {
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const workflow = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child', rules: [] }],
    } as WorkflowConfig;
    const parallelFrame = buildWorkflowResumePointEntry(workflow, 'reviewers', 'parallel', 4);
    const top = invocationRecord(workflow, 'delegate', child, [], 5);
    const nested = invocationRecord(workflow, 'delegate', child, [parallelFrame], 1);
    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest([top.namespace, nested.namespace]),
      sourceResumePoint([top, nested]),
    );

    expect(index.getMaxOccurrence(workflow, 'delegate', [])).toBe(5);
    expect(index.getMaxOccurrence(workflow, 'delegate', [parallelFrame])).toBe(1);
  });

  it('異なる parallel 親の同名 workflow_call artifact を混同しない', () => {
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const workflow = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const siteAFrame = buildWorkflowResumePointEntry(workflow, 'review-a', 'parallel', 3);
    const siteBFrame = buildWorkflowResumePointEntry(workflow, 'review-b', 'parallel', 9);
    const siteA = invocationRecord(workflow, 'delegate', child, [siteAFrame], 6);
    const siteB = invocationRecord(workflow, 'delegate', child, [siteBFrame], 2);
    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest([siteA.namespace, siteB.namespace]),
      sourceResumePoint([siteA, siteB]),
    );

    expect(index.getMaxOccurrence(workflow, 'delegate', [siteAFrame])).toBe(6);
    expect(index.getMaxOccurrence(workflow, 'delegate', [siteBFrame])).toBe(2);
  });

  it('nested workflow_call artifact を祖先 call-site ごとに分離する', () => {
    const parent = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const grandchild = { name: 'grandchild', steps: [] } as unknown as WorkflowConfig;
    const outerA = buildWorkflowResumePointEntry(parent, 'outer-a', 'workflow_call', 2, undefined, 2);
    const outerB = buildWorkflowResumePointEntry(parent, 'outer-b', 'workflow_call', 7, undefined, 7);
    const nestedA = invocationRecord(child, 'delegate', grandchild, [outerA], 4);
    const nestedB = invocationRecord(child, 'delegate', grandchild, [outerB], 1);
    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest([nestedA.namespace, nestedB.namespace]),
      sourceResumePoint([nestedA, nestedB]),
    );

    expect(index.getMaxOccurrence(child, 'delegate', [outerA])).toBe(4);
    expect(index.getMaxOccurrence(child, 'delegate', [outerB])).toBe(1);
  });

  it('partial manifest に artifact がない call-site の occurrence を進めない', () => {
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const workflow = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const siteAFrame = buildWorkflowResumePointEntry(workflow, 'review-a', 'parallel', 1);
    const siteBFrame = buildWorkflowResumePointEntry(workflow, 'review-b', 'parallel', 1);
    const siteA = invocationRecord(workflow, 'delegate', child, [siteAFrame], 6);
    const siteB = invocationRecord(workflow, 'delegate', child, [siteBFrame], 2);
    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest([siteA.namespace]),
      sourceResumePoint([siteA, siteB]),
    );

    expect(index.getMaxOccurrence(workflow, 'delegate', [siteAFrame])).toBe(6);
    expect(index.getMaxOccurrence(workflow, 'delegate', [siteBFrame])).toBeUndefined();
  });

  it('旧 digest の最新 invocation に成果物がなくても一意な call-site の artifact を移行する', () => {
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const workflow = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const occurrence1 = invocationRecord(workflow, 'delegate', child, [], 1);
    const occurrence2 = invocationRecord(workflow, 'delegate', child, [], 2);
    const legacyOccurrence1 = {
      ...occurrence1,
      namespace: withLegacyOccurrenceDigest(occurrence1.namespace, '1'),
    };
    const legacyOccurrence2 = {
      ...occurrence2,
      namespace: withLegacyOccurrenceDigest(occurrence2.namespace, '2'),
    };

    const index = new ResumeArtifactOccurrenceIndex(
      artifactManifest([legacyOccurrence1.namespace]),
      sourceResumePoint([legacyOccurrence2]),
    );

    expect(index.getMaxOccurrence(workflow, 'delegate', [])).toBe(1);
  });

  it('旧 digest artifact の論理 call-site が複数候補なら明示的に停止する', () => {
    const child = { name: 'child', steps: [] } as unknown as WorkflowConfig;
    const workflow = { name: 'parent', steps: [] } as unknown as WorkflowConfig;
    const siteAFrame = buildWorkflowResumePointEntry(workflow, 'review-a', 'parallel', 1);
    const siteBFrame = buildWorkflowResumePointEntry(workflow, 'review-b', 'parallel', 1);
    const siteAArtifact = invocationRecord(workflow, 'delegate', child, [siteAFrame], 1);
    const siteALatest = invocationRecord(workflow, 'delegate', child, [siteAFrame], 2);
    const siteBLatest = invocationRecord(workflow, 'delegate', child, [siteBFrame], 2);

    expect(() => new ResumeArtifactOccurrenceIndex(
      artifactManifest([
        withLegacyOccurrenceDigest(siteAArtifact.namespace, '1'),
      ]),
      sourceResumePoint([
        { ...siteALatest, namespace: withLegacyOccurrenceDigest(siteALatest.namespace, '2') },
        { ...siteBLatest, namespace: withLegacyOccurrenceDigest(siteBLatest.namespace, '3') },
      ]),
    )).toThrow('logical call-site is ambiguous');
  });

  it('通常 resume は artifact occurrence index を適用しない', () => {
    const workflow = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child', rules: [] }],
    } as WorkflowConfig;
    const state = {
      workflowName: workflow.name,
      currentStep: 'delegate',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    } as WorkflowState;
    const continuation = new WorkflowResumeContinuation(workflow, undefined);

    expect(continuation.claimStepOccurrence({
      step: workflow.steps[0]!,
      resumeStackPrefix: [],
      state,
    })).toBe(1);
  });
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
