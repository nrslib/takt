import { describe, expect, it, vi } from 'vitest';
import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../core/models/types.js';
import {
  resolveInheritedReviewReportNamesWithDiagnostics,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../core/workflow/review-report-discovery.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';
import { makeStep } from './test-helpers.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';
import {
  buildWorkflowCallInvocationIdentity,
  WorkflowCallInvocationIndex,
} from '../core/workflow/workflow-call-invocation-index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import type { ReviewReportParticipationEvidence } from '../core/workflow/review-report-participation.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { getReportFiles } from '../core/workflow/output-contract-files.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';

function makeWorkflow(
  name: string,
  steps: WorkflowStep[],
  initialStep: string = steps[0]?.name ?? 'step',
): WorkflowConfig {
  return {
    name,
    maxSteps: 10,
    initialStep,
    steps,
  };
}

function callNamespace(
  workflow: WorkflowConfig,
  step: string,
  ownerPath: readonly WorkflowResumePointEntry[],
  childWorkflow: WorkflowConfig | string,
  callInstance: number,
): string {
  return buildWorkflowCallNamespaceSegment(
    buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), step, ownerPath),
    typeof childWorkflow === 'string' ? childWorkflow : getWorkflowReference(childWorkflow),
    callInstance,
  );
}

function participation(
  workflow: WorkflowConfig,
  stepOutputNames: readonly string[],
  dynamicParallelSelections = new Map(),
  workflowCallInvocations = new Map(),
  workflowStepParticipations = new Map(),
): ReviewReportParticipationEvidence {
  const stepIndex = new WorkflowStepParticipationIndex(workflowStepParticipations);
  for (const stepName of stepOutputNames) {
    const step = workflow.steps.find((candidate) => candidate.name === stepName)
      ?? workflow.steps.flatMap((candidate) => candidate.parallel === undefined
        ? []
        : getAllParallelSubSteps(candidate.parallel))
        .find((candidate) => candidate.name === stepName);
    if (step !== undefined) {
      const parallelParent = workflow.steps.find((candidate) => candidate.parallel !== undefined
        && getAllParallelSubSteps(candidate.parallel).some((subStep) => subStep === step));
      const ownerPath = parallelParent === undefined
        ? []
        : [buildWorkflowResumePointEntry(workflow, parallelParent.name, 'agent')];
      stepIndex.record(workflow, step.name, ownerPath, getReportFiles(step.outputContracts));
    }
  }
  return {
    activeWorkflowReference: getWorkflowReference(workflow),
    stepOutputNames: new Set(stepOutputNames),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections,
    workflowCallInvocations: {
      kind: 'exact',
      records: workflowCallInvocations,
    },
    workflowStepParticipations: stepIndex.snapshot(),
  };
}

function makeWorkflowCallChain(workflowCount: number): {
  workflow: WorkflowConfig;
  workflowsByName: ReadonlyMap<string, WorkflowConfig>;
  reportName: string;
  invocationIndex: WorkflowCallInvocationIndex;
  stepParticipationIndex: WorkflowStepParticipationIndex;
} {
  const workflows: WorkflowConfig[] = [];

  for (let index = workflowCount - 1; index >= 0; index -= 1) {
    const workflowName = `workflow-${index + 1}`;
    if (index === workflowCount - 1) {
      workflows[index] = makeWorkflow(workflowName, [
        makeStep({
          name: 'review',
          outputContracts: [{ name: 'review.md', format: '# Review' }],
        }),
      ]);
      continue;
    }

    const childWorkflowName = `workflow-${index + 2}`;
    const callStepName = `delegate-${index + 1}`;
    workflows[index] = makeWorkflow(workflowName, [
      makeNormalizedWorkflowCallStep({
        name: callStepName,
        call: childWorkflowName,
      }),
      ...(index === 0 ? [makeStep({ name: 'fix' })] : []),
    ]);
  }

  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  const workflowCallPath = [];
  const namespace: string[] = [];
  for (let index = 0; index < workflowCount - 1; index += 1) {
    const parent = workflows[index]!;
    const step = parent.steps[0]!;
    const segment = callNamespace(parent, step.name, workflowCallPath, workflows[index + 1]!, 1);
    invocationIndex.record(parent, step.name, workflowCallPath, {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(workflows[index + 1]!),
    });
    namespace.push('subworkflows', segment);
    workflowCallPath.push(
      buildWorkflowResumePointEntry(parent, step.name, 'workflow_call', undefined, 1),
    );
  }
  const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
  stepParticipationIndex.record(
    workflows[workflowCount - 1]!,
    'review',
    workflowCallPath,
    ['review.md'],
  );
  return {
    workflow: workflows[0]!,
    workflowsByName: new Map(workflows.map((workflow) => [workflow.name, workflow])),
    reportName: [...namespace, 'review.md'].join('/'),
    invocationIndex,
    stepParticipationIndex,
  };
}

function makeDepthBoundaryFixture(workflowCallCount: number) {
  const call = makeNormalizedWorkflowCallStep({
    name: 'review',
    call: 'child',
  });
  const fix = makeStep({ name: 'fix' });
  const workflow = makeWorkflow('parent', [call, fix]);
  const child = makeWorkflow('child', [
    makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    }),
  ]);
  const workflowCallPrefix = Array.from(
    { length: workflowCallCount },
    (_, index): WorkflowResumePointEntry => ({
      workflow: `ancestor-${index}`,
      step: `call-${index}`,
      kind: 'workflow_call',
      call_instance: 1,
    }),
  );
  const resumeStackPrefix: WorkflowResumePointEntry[] = [
    {
      workflow: 'parallel-owner',
      step: 'fanout',
      kind: 'agent',
    },
    workflowCallPrefix[0]!,
    {
      workflow: 'system-owner',
      step: 'gate',
      kind: 'system',
    },
    ...workflowCallPrefix.slice(1),
  ];
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  const segment = callNamespace(workflow, 'review', resumeStackPrefix, child, 1);
  invocationIndex.record(workflow, 'review', resumeStackPrefix, {
    call_instance: 1,
    child_workflow_ref: getWorkflowReference(child),
  });
  const childCallPath = [
    ...resumeStackPrefix,
    buildWorkflowResumePointEntry(workflow, 'review', 'workflow_call', undefined, 1),
  ];
  const stepIndex = new WorkflowStepParticipationIndex(new Map());
  stepIndex.record(child, 'review', childCallPath, ['review.md']);

  return {
    call,
    context: {
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix,
      participation: participation(
        workflow,
        [],
        new Map(),
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    },
    reportName: `subworkflows/${segment}/review.md`,
  };
}

describe('review report discovery', () => {
  it('discovers a non-initial report from exact child workflow participation evidence', () => {
    const delegate = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child' });
    const fix = makeStep({ name: 'fix' });
    const parent = makeWorkflow('parent', [delegate, fix]);
    const prepare = makeStep({ name: 'prepare' });
    const review = makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    });
    const child = makeWorkflow('child', [prepare, review], 'prepare');
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const segment = callNamespace(parent, 'delegate', [], child, 4);
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 4,
      child_workflow_ref: getWorkflowReference(child),
    });
    const callPath = [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 4),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'prepare', callPath, []);
    stepIndex.record(child, 'review', callPath, ['review.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow: parent,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        parent,
        [],
        new Map(),
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        `subworkflows/${segment}/review.md`,
      ],
      failures: [],
    });
  });

  it('fails fast when a saved call namespace references a different child workflow', () => {
    const delegate = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child' });
    const fix = makeStep({ name: 'fix' });
    const parent = makeWorkflow('parent', [delegate, fix]);
    const child = makeWorkflow('child', [makeStep({ name: 'review' })]);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 1,
      child_workflow_ref: 'other-child',
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow: parent,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        parent,
        [],
        new Map(),
        invocationIndex.snapshot(),
        new Map(),
      ),
    })).toEqual({
      reportNames: [],
      failures: [{
        kind: 'fatal',
        reason: 'workflow_call_invocation_namespace_mismatch:delegate',
      }],
    });
  });

  it('discovers ordinary parallel and workflow-call reports for selector input', () => {
    const parallel = {
      ...makeStep({ name: 'parallel-review' }),
      parallel: [
        makeStep({
          name: 'architecture',
          outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
        }),
      ],
    } as WorkflowStep;
    const call = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child-review' });
    const workflow = makeWorkflow('parent', [parallel, call, makeStep({ name: 'reviewers' })]);
    const child = makeWorkflow('child-review', [
      makeStep({
        name: 'security',
        outputContracts: [{ name: 'security.md', format: '# Security' }],
      }),
    ]);
    const childCallPath = [
      buildWorkflowResumePointEntry(workflow, 'delegate', 'workflow_call', undefined, 1),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'security', childCallPath, ['security.md']);
    const segment = callNamespace(workflow, 'delegate', [], child, 1);
    const context = {
      step: workflow.steps[2]!,
      workflow,
      workflowCallResolver: vi.fn(() => child),
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        workflow,
        ['parallel-review', 'architecture', 'delegate'],
        new Map(),
        new Map([[
          buildWorkflowCallInvocationIdentity('parent', 'delegate', []),
          {
            call_instance: 1,
            child_workflow_ref: getWorkflowReference(child),
          },
        ]]),
        stepIndex.snapshot(),
      ),
    };

    expect(resolveWorkflowStepReportNamesWithDiagnostics(parallel, context)).toEqual({
      reportNames: ['architecture.md'],
      failures: [],
    });
    expect(resolveWorkflowStepReportNamesWithDiagnostics(call, context)).toEqual({
      reportNames: [`subworkflows/${segment}/security.md`],
      failures: [],
    });
  });

  it('keeps an earlier parallel call report distinct after a same-named later call to another child', () => {
    const firstCall = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'first-child' });
    const secondCall = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'second-child' });
    const firstFanout = {
      ...makeStep({ name: 'fanout_a' }),
      parallel: [firstCall],
    } as WorkflowStep;
    const secondFanout = {
      ...makeStep({ name: 'fanout_b' }),
      parallel: [secondCall],
    } as WorkflowStep;
    const parent = makeWorkflow('parent', [firstFanout, secondFanout]);
    const firstChild = makeWorkflow('first-child', [
      makeStep({
        name: 'review',
        outputContracts: [{ name: 'first-review.md', format: '# First review' }],
      }),
    ]);
    const secondChild = makeWorkflow('second-child', [
      makeStep({
        name: 'review',
        outputContracts: [{ name: 'second-review.md', format: '# Second review' }],
      }),
    ]);
    const firstOwner = buildWorkflowResumePointEntry(parent, 'fanout_a', 'agent');
    const secondOwner = buildWorkflowResumePointEntry(parent, 'fanout_b', 'agent');
    const firstCallEntry = buildWorkflowResumePointEntry(
      parent,
      'delegate',
      'workflow_call',
      undefined,
      1,
    );
    const secondCallEntry = buildWorkflowResumePointEntry(
      parent,
      'delegate',
      'workflow_call',
      undefined,
      1,
    );
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    const firstSegment = callNamespace(parent, 'delegate', [firstOwner], firstChild, 1);
    const secondSegment = callNamespace(parent, 'delegate', [secondOwner], secondChild, 1);

    invocationIndex.record(parent, 'delegate', [firstOwner], {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(firstChild),
    });
    stepIndex.record(parent, 'delegate', [firstOwner], []);
    stepIndex.record(firstChild, 'review', [firstOwner, firstCallEntry], ['first-review.md']);

    invocationIndex.record(parent, 'delegate', [secondOwner], {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(secondChild),
    });
    stepIndex.record(parent, 'delegate', [secondOwner], []);
    stepIndex.record(secondChild, 'review', [secondOwner, secondCallEntry], ['second-review.md']);

    const result = resolveWorkflowStepReportNamesWithDiagnostics(firstCall, {
      step: firstCall,
      workflow: parent,
      workflowCallResolver: ({ step }) => step.call === 'first-child' ? firstChild : secondChild,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        parent,
        [],
        new Map(),
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    });

    expect(result).toEqual({
      reportNames: [
        `subworkflows/${firstSegment}/first-review.md`,
      ],
      failures: [],
    });
  });

  it('keeps a missing invocation fatal when an exact invocation index is present', () => {
    const call = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child-review' });
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('parent', [call, fix]);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: vi.fn(),
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['delegate']),
    })).toEqual({
      reportNames: [],
      failures: [{
        kind: 'fatal',
        reason: 'workflow_call_invocation_missing:delegate',
      }],
    });
  });

  it('finds the nearest earlier report-producing step across intermediate steps', () => {
    const review = makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    });
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('sequential', [
      review,
      makeStep({ name: 'triage' }),
      fix,
    ]);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['review']),
    })).toEqual({
      reportNames: ['review.md'],
      failures: [],
    });
  });

  it('skips unexecuted dynamic and workflow-call steps while finding an earlier report', () => {
    const review = makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    });
    const skippedDynamic = {
      ...makeStep({ name: 'skipped-dynamic' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [makeStep({
          name: 'frontend',
          description: 'Review frontend',
          outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
        })],
        selection: { mode: 'replace' as const },
      },
    };
    const skippedCall = makeNormalizedWorkflowCallStep({
      name: 'skipped-call',
      call: 'child',
    });
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('branched', [
      review,
      skippedDynamic,
      skippedCall,
      fix,
    ]);
    const resolver = vi.fn();

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: resolver,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['review']),
    })).toEqual({
      reportNames: ['review.md'],
      failures: [],
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('uses the saved dynamic participant manifest instead of every pool reviewer', () => {
    const architecture = makeStep({
      name: 'architecture',
      outputContracts: [{ name: 'architecture.md', format: '# Review' }],
    });
    const frontend = makeStep({
      name: 'frontend',
      description: 'Review frontend changes',
      outputContracts: [{ name: 'frontend.md', format: '# Review' }],
    });
    const backend = makeStep({
      name: 'backend',
      description: 'Review backend changes',
      outputContracts: [{ name: 'backend.md', format: '# Review' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic',
        fixed: [architecture],
        pool: [frontend, backend],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('dynamic-reports', [reviewers, fix]);
    const identity = buildDynamicParallelSelectionIdentity(workflow, 'reviewers', []);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['reviewers', 'architecture', 'frontend'], new Map([[
        identity,
        {
          identity,
          step_name: 'reviewers',
          round: 2,
          selected_pool_ids: ['frontend'],
          effective_selection_ids: ['architecture', 'frontend'],
        },
      ]])),
    })).toEqual({
      reportNames: ['architecture.md', 'frontend.md'],
      failures: [],
    });
  });

  it('reports a missing dynamic selection snapshot instead of treating it as no reports', () => {
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic',
        fixed: [],
        pool: [makeStep({
          name: 'frontend',
          description: 'Review frontend changes',
          outputContracts: [{ name: 'frontend.md', format: '# Review' }],
        })],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const workflow = makeWorkflow('dynamic-reports', [reviewers, makeStep({ name: 'fix' })]);

    expect(resolveWorkflowStepReportNamesWithDiagnostics(reviewers, {
      step: workflow.steps[1]!,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['reviewers']),
    })).toEqual({
      reportNames: [],
      failures: [
        {
          kind: 'fatal',
          reason: expect.stringContaining(
            'dynamic_parallel_report_identity_unresolved:Dynamic parallel report selection snapshot is missing',
          ),
        },
      ],
    });
  });

  it('discovers namespaced reports through a workflow call', () => {
    const fix = makeStep({ name: 'fix' });
    const call = makeNormalizedWorkflowCallStep({
      name: 'final-gate',
      call: 'child-review',
    });
    const workflow = makeWorkflow('parent', [call, fix]);
    const child = makeWorkflow('child-review', [
      makeStep({
        name: 'review',
        outputContracts: [{ name: 'nested-review.md', format: '# Review' }],
      }),
    ]);
    const resolver = vi.fn(() => child);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const segment = callNamespace(workflow, 'final-gate', [], child, 2);
    invocationIndex.record(workflow, 'final-gate', [], {
      call_instance: 2,
      child_workflow_ref: getWorkflowReference(child),
    });
    const callPath = [
      buildWorkflowResumePointEntry(workflow, 'final-gate', 'workflow_call', undefined, 2),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'review', callPath, ['nested-review.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: resolver,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        workflow,
        [],
        new Map(),
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        `subworkflows/${segment}/nested-review.md`,
      ],
      failures: [],
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('uses a child workflow-call selection manifest when discovering dynamic reports', () => {
    const fixed = makeStep({
      name: 'architecture',
      outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
    });
    const selected = makeStep({
      name: 'frontend',
      description: 'Review frontend changes',
      outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
    });
    const unselected = makeStep({
      name: 'backend',
      description: 'Review backend changes',
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic',
        fixed: [fixed],
        pool: [selected, unselected],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const parent = makeWorkflow('parent', [
      makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child' }),
      makeStep({ name: 'fix' }),
    ]);
    const child = makeWorkflow('child', [reviewers]);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const segment = callNamespace(parent, 'delegate', [], child, 2);
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 2,
      child_workflow_ref: getWorkflowReference(child),
    });
    const firstIdentity = buildDynamicParallelSelectionIdentity(child, 'reviewers', [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 1),
    ]);
    const currentIdentity = buildDynamicParallelSelectionIdentity(child, 'reviewers', [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 2),
    ]);
    const currentCallPath = [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 2),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'reviewers', currentCallPath, []);
    const reviewerOwnerPath = [
      ...currentCallPath,
      buildWorkflowResumePointEntry(child, 'reviewers', 'agent'),
    ];
    stepIndex.record(child, 'architecture', reviewerOwnerPath, ['architecture.md']);
    stepIndex.record(child, 'frontend', reviewerOwnerPath, ['frontend.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: parent.steps[1]!,
      workflow: parent,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(parent, [], new Map([
        [firstIdentity, {
          identity: firstIdentity,
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: ['backend'],
          effective_selection_ids: ['architecture', 'backend'],
        }],
        [currentIdentity, {
          identity: currentIdentity,
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: ['frontend'],
          effective_selection_ids: ['architecture', 'frontend'],
        }],
      ]), invocationIndex.snapshot(), stepIndex.snapshot()),
    })).toEqual({
      reportNames: [
        `subworkflows/${segment}/architecture.md`,
        `subworkflows/${segment}/frontend.md`,
      ],
      failures: [],
    });
  });

  it('uses exact call instances when discovering a grandchild dynamic selection', () => {
    const selected = makeStep({
      name: 'frontend',
      description: 'Review frontend',
      outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
    });
    const unselected = makeStep({
      name: 'backend',
      description: 'Review backend',
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [selected, unselected],
        selection: { mode: 'replace' as const },
      },
    };
    const grandchild = makeWorkflow('grandchild', [reviewers]);
    grandchild.subworkflow = { callable: true };
    const childCall = makeNormalizedWorkflowCallStep({ name: 'nested', call: 'grandchild' });
    const child = makeWorkflow('child', [childCall]);
    child.subworkflow = { callable: true };
    const rootCall = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child' });
    const parent = makeWorkflow('parent', [rootCall]);
    const callPath = [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', new Map(), 2),
      buildWorkflowResumePointEntry(child, 'nested', 'workflow_call', new Map(), 3),
    ];
    const identity = buildDynamicParallelSelectionIdentity(grandchild, 'reviewers', callPath);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const rootSegment = callNamespace(parent, 'delegate', [], child, 2);
    const nestedSegment = callNamespace(child, 'nested', callPath.slice(0, 1), grandchild, 3);
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 2,
      child_workflow_ref: getWorkflowReference(child),
    });
    invocationIndex.record(child, 'nested', callPath.slice(0, 1), {
      call_instance: 3,
      child_workflow_ref: getWorkflowReference(grandchild),
    });
    const workflows = new Map([
      ['child', child],
      ['grandchild', grandchild],
    ]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(grandchild, 'reviewers', callPath, []);
    stepIndex.record(grandchild, 'frontend', [
      ...callPath,
      buildWorkflowResumePointEntry(grandchild, 'reviewers', 'agent'),
    ], ['frontend.md']);

    expect(resolveWorkflowStepReportNamesWithDiagnostics(rootCall, {
      step: rootCall,
      workflow: parent,
      workflowCallResolver: ({ step }) => workflows.get(step.call) ?? null,
      projectCwd: '/worktree',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(parent, [], new Map([[identity, {
        identity,
        step_name: 'reviewers',
        round: 1,
        selected_pool_ids: ['frontend'],
        effective_selection_ids: ['frontend'],
      }]]), invocationIndex.snapshot(), stepIndex.snapshot()),
    })).toEqual({
      reportNames: [
        `subworkflows/${rootSegment}/subworkflows/${nestedSegment}/frontend.md`,
      ],
      failures: [],
    });
  });

  it('retains an earlier available report when a nearer workflow call cannot resolve', () => {
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('parent', [
      makeStep({
        name: 'review',
        outputContracts: [{ name: 'review.md', format: '# Review' }],
      }),
      makeNormalizedWorkflowCallStep({
        name: 'unavailable-review',
        call: 'missing-review',
      }),
      fix,
    ]);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(workflow, 'unavailable-review', [], {
      call_instance: 1,
      child_workflow_ref: 'missing-review',
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => null,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        workflow,
        ['review'],
        new Map(),
        invocationIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: ['review.md'],
      failures: [{ kind: 'recoverable', reason: 'workflow_call_report_unknown:missing-review' }],
    });
  });

  it('continues to an earlier reviewer when a resolved workflow call has no report', () => {
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('parent', [
      makeStep({
        name: 'review',
        outputContracts: [{ name: 'review.md', format: '# Review' }],
      }),
      makeNormalizedWorkflowCallStep({
        name: 'reportless-review',
        call: 'reportless-child',
      }),
      fix,
    ]);
    const reportlessChild = makeWorkflow('reportless-child', [
      makeStep({ name: 'status-only' }),
    ]);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(workflow, 'reportless-review', [], {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(reportlessChild),
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => reportlessChild,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['review'], new Map(), invocationIndex.snapshot()),
    })).toEqual({
      reportNames: ['review.md'],
      failures: [],
    });
  });

  it('records workflow call cycles without recursing', () => {
    const call = makeNormalizedWorkflowCallStep({
      name: 'review',
      call: 'parent',
    });
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('parent', [call, fix]);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(workflow, 'review', [], {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(workflow),
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, [], new Map(), invocationIndex.snapshot()),
    })).toEqual({
      reportNames: [],
      failures: [{ kind: 'recoverable', reason: 'workflow_call_report_cycle:parent' }],
    });
  });

  it('does not treat same-name workflows with different opaque references as a cycle', () => {
    const call = makeNormalizedWorkflowCallStep({
      name: 'review',
      call: 'shared-review',
    });
    const fix = makeStep({ name: 'fix' });
    const workflow = attachWorkflowOpaqueRef(
      makeWorkflow('shared-review', [call, fix]),
      'project:sha256:parent',
    );
    const child = attachWorkflowOpaqueRef(
      makeWorkflow('shared-review', [
        makeStep({
          name: 'review',
          outputContracts: [{ name: 'review.md', format: '# Review' }],
        }),
      ]),
      'project:sha256:child',
    );
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    const segment = callNamespace(workflow, 'review', [], child, 1);
    invocationIndex.record(workflow, 'review', [], {
      call_instance: 1,
      child_workflow_ref: getWorkflowReference(child),
    });
    const callPath = [
      buildWorkflowResumePointEntry(workflow, 'review', 'workflow_call', undefined, 1),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'review', callPath, ['review.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        workflow,
        [],
        new Map(),
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        `subworkflows/${segment}/review.md`,
      ],
      failures: [],
    });
  });

  it('discovers a report at the maximum workflow call depth', () => {
    const chain = makeWorkflowCallChain(MAX_WORKFLOW_CALL_DEPTH);
    const fix = chain.workflow.steps.find((step) => step.name === 'fix')!;

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow: chain.workflow,
      workflowCallResolver: ({ step }) => chain.workflowsByName.get(step.call) ?? null,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        chain.workflow,
        [],
        new Map(),
        chain.invocationIndex.snapshot(),
        chain.stepParticipationIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [chain.reportName],
      failures: [],
    });
  });

  it('should discover an inherited report at the remaining maximum depth with mixed owners', () => {
    const fixture = makeDepthBoundaryFixture(MAX_WORKFLOW_CALL_DEPTH - 2);

    expect(resolveInheritedReviewReportNamesWithDiagnostics(fixture.context)).toEqual({
      reportNames: [fixture.reportName],
      failures: [],
    });
  });

  it('should discover a direct workflow-step report at the remaining maximum depth with mixed owners', () => {
    const fixture = makeDepthBoundaryFixture(MAX_WORKFLOW_CALL_DEPTH - 2);

    expect(resolveWorkflowStepReportNamesWithDiagnostics(
      fixture.call,
      fixture.context,
    )).toEqual({
      reportNames: [fixture.reportName],
      failures: [],
    });
  });

  it('should reject an inherited report one workflow call beyond the remaining depth', () => {
    const fixture = makeDepthBoundaryFixture(MAX_WORKFLOW_CALL_DEPTH - 1);

    expect(resolveInheritedReviewReportNamesWithDiagnostics(fixture.context)).toEqual({
      reportNames: [],
      failures: [{
        kind: 'recoverable',
        reason: `workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`,
      }],
    });
  });

  it('should reject a direct workflow-step report one workflow call beyond the remaining depth', () => {
    const fixture = makeDepthBoundaryFixture(MAX_WORKFLOW_CALL_DEPTH - 1);

    expect(resolveWorkflowStepReportNamesWithDiagnostics(
      fixture.call,
      fixture.context,
    )).toEqual({
      reportNames: [],
      failures: [{
        kind: 'recoverable',
        reason: `workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`,
      }],
    });
  });
});
