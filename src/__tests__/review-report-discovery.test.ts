import { describe, expect, it, vi } from 'vitest';
import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/types.js';
import {
  resolveReviewReportStepParticipation,
  type ReviewReportParticipationEvidence,
} from '../core/workflow/review-report-participation.js';
import {
  resolveInheritedReviewReportNamesWithDiagnostics,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../core/workflow/review-report-discovery.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';
import { makeStep } from './test-helpers.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  buildWorkflowStepParticipationIdentity,
  restoreWorkflowStepParticipationIndex,
  WorkflowStepParticipationIndex,
} from '../core/workflow/workflow-step-participation-index.js';
import { getReportFiles } from '../core/workflow/output-contract-files.js';
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';

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

function participation(
  workflow: WorkflowConfig,
  stepOutputNames: readonly string[],
  workflowCallInvocations = new Map(),
  workflowStepParticipations = new Map(),
  dynamicParallelSelections = new Map(),
): ReviewReportParticipationEvidence {
  const stepIndex = new WorkflowStepParticipationIndex(workflowStepParticipations);
  const workflowSteps = workflow.steps.flatMap((step) => [
    step,
    ...(step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)),
  ]);
  for (const stepName of stepOutputNames) {
    const step = workflowSteps.find((candidate) => candidate.name === stepName);
    if (step !== undefined) {
      const parallelParent = workflow.steps.find((candidate) =>
        candidate.parallel !== undefined
          && getAllParallelSubSteps(candidate.parallel).some((subStep) => subStep.name === step.name),
      );
      if (parallelParent === undefined) {
        stepIndex.record(workflow, step.name, [], getReportFiles(step.outputContracts));
      } else {
        stepIndex.record(
          workflow,
          step.name,
          [],
          getReportFiles(step.outputContracts),
          parallelParent.name,
        );
      }
    }
  }
  return {
    activeWorkflowReference: getWorkflowReference(workflow),
    stepOutputNames: new Set(stepOutputNames),
    restoredStepIterationNames: new Set(),
    workflowCallInvocations: {
      kind: 'exact',
      records: workflowCallInvocations,
    },
    workflowStepParticipations: stepIndex.snapshot(),
    dynamicParallelSelections,
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

  const namespace = Array.from(
    { length: workflowCount - 1 },
    (_, index) => [
      'subworkflows',
      `iteration-${index + 1}--step-delegate-${index + 1}--workflow-workflow-${index + 2}`,
    ],
  ).flat();
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  const workflowCallPath = [];
  for (let index = 0; index < workflowCount - 1; index += 1) {
    const parent = workflows[index]!;
    const step = parent.steps[0]!;
    invocationIndex.record(parent, step.name, workflowCallPath, {
      call_instance: 1,
      report_namespace_segment:
        `iteration-${index + 1}--step-${step.name}--workflow-workflow-${index + 2}`,
    });
    workflowCallPath.push(
      buildWorkflowResumePointEntry(parent, step.name, 'workflow_call', 1, undefined, 1),
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
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 4,
      report_namespace_segment: 'iteration-9--step-delegate--workflow-child',
    });
    const callPath = [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 4),
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
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-9--step-delegate--workflow-child/review.md',
      ],
      failures: [],
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
      buildWorkflowResumePointEntry(workflow, 'delegate', 'workflow_call', 1, undefined, 1),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'security', childCallPath, ['security.md']);
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
        new Map([[
          '{"workflow":"parent","step":"delegate","calls":[]}',
          {
            call_instance: 1,
            report_namespace_segment: 'iteration-9--step-delegate--workflow-child-review',
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
      reportNames: ['subworkflows/iteration-9--step-delegate--workflow-child-review/security.md'],
      failures: [],
    });
  });

  it('discovers reports from a workflow_call nested under a static parallel parent', () => {
    const topLevelDelegate = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child-review' });
    const delegate = makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'child-review' });
    const local = makeStep({
      name: 'local',
      outputContracts: [{ name: 'local.md', format: '# Local' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: [delegate, local],
    } as WorkflowStep;
    const fix = makeStep({ name: 'fix' });
    const parent = makeWorkflow('parent', [topLevelDelegate, reviewers, fix]);
    const child = makeWorkflow('child-review', [makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    })]);
    const parentFrame = buildWorkflowResumePointEntry(parent, 'reviewers', 'parallel', 1);
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 2,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-child-review--site-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    invocationIndex.record(parent, 'delegate', [parentFrame], {
      call_instance: 1,
      report_namespace_segment: 'iteration-1--step-delegate--workflow-child-review',
    });
    const callPath = [
      parentFrame,
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 1),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(parent, 'reviewers', [], []);
    stepIndex.record(parent, 'delegate', [], [], 'reviewers');
    stepIndex.record(parent, 'local', [], ['local.md'], 'reviewers');
    stepIndex.record(child, 'review', callPath, ['review.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow: parent,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(parent),
        stepOutputNames: new Set(),
        restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: invocationIndex.snapshot() },
        workflowStepParticipations: stepIndex.snapshot(),
        dynamicParallelSelections: new Map(),
      },
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-1--step-delegate--workflow-child-review/review.md',
        'local.md',
      ],
      failures: [],
    });
  });

  it('uses step object identity when a top-level step shares a sub-step name', () => {
    const review = makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    });
    const parallelFix = makeStep({ name: 'fix' });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: [parallelFix],
    } as WorkflowStep;
    const topLevelFix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('same-name-report-scope', [review, reviewers, topLevelFix]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(workflow, 'review', [], ['review.md']);
    stepIndex.record(workflow, 'reviewers', [], []);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: topLevelFix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(workflow),
        stepOutputNames: new Set(),
        restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: new Map() },
        workflowStepParticipations: stepIndex.snapshot(),
        dynamicParallelSelections: new Map(),
      },
    })).toEqual({ reportNames: ['review.md'], failures: [] });
  });

  it('reads a legacy unqualified static parallel participation identity', () => {
    const architecture = makeStep({
      name: 'architecture',
      outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: [architecture],
    } as WorkflowStep;
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('legacy-participation', [reviewers, fix]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(workflow, 'reviewers', [], []);
    const legacyIdentity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      architecture.name,
      [],
    );
    const participationRecords = new Map(stepIndex.snapshot());
    participationRecords.set(legacyIdentity, { report_names: ['architecture.md'] });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(workflow),
        stepOutputNames: new Set(),
        restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: new Map() },
        workflowStepParticipations: participationRecords,
        dynamicParallelSelections: new Map(),
      },
    })).toEqual({ reportNames: ['architecture.md'], failures: [] });
  });

  it('does not use a legacy identity when the same sub-step belongs to multiple parents', () => {
    const firstShared = makeStep({
      name: 'shared',
      outputContracts: [{ name: 'shared.md', format: '# Shared' }],
    });
    const secondShared = makeStep({
      name: 'shared',
      outputContracts: [{ name: 'shared.md', format: '# Shared' }],
    });
    const first = {
      ...makeStep({ name: 'first' }),
      parallel: [firstShared],
    } as WorkflowStep;
    const second = {
      ...makeStep({ name: 'second' }),
      parallel: [secondShared],
    } as WorkflowStep;
    const workflow = makeWorkflow('ambiguous-legacy-participation', [first, second, makeStep({ name: 'fix' })]);
    const legacyIdentity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      'shared',
      [],
    );
    const stepIndex = new WorkflowStepParticipationIndex(new Map([
      [legacyIdentity, { report_names: ['shared.md'] }],
    ]));

    expect(stepIndex.get(workflow, 'shared', [], 'first')).toBeUndefined();
    expect(stepIndex.get(workflow, 'shared', [], 'second')).toBeUndefined();
  });

  it('does not use an unqualified top-level identity for a same-named dynamic child', () => {
    const topLevelDelegate = makeStep({
      name: 'delegate',
      outputContracts: [{ name: 'delegate.md', format: '# Delegate' }],
    });
    const dynamicDelegate = makeStep({ name: 'delegate' });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [dynamicDelegate],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const workflow = makeWorkflow('top-level-child-collision', [reviewers, topLevelDelegate, makeStep({ name: 'fix' })]);
    const legacyIdentity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      'delegate',
      [],
    );
    const stepIndex = new WorkflowStepParticipationIndex(new Map([
      [legacyIdentity, { report_names: ['delegate.md'] }],
    ]));

    const evidence: ReviewReportParticipationEvidence = {
      activeWorkflowReference: getWorkflowReference(workflow),
      stepOutputNames: new Set(),
      restoredStepIterationNames: new Set(),
      workflowCallInvocations: { kind: 'exact', records: new Map() },
      workflowStepParticipations: stepIndex.snapshot(),
      dynamicParallelSelections: new Map(),
    };
    expect(resolveReviewReportStepParticipation(
      topLevelDelegate,
      workflow,
      [],
      evidence,
    )).toEqual({
      kind: 'participated',
      parallelParticipants: [],
      reportNames: ['delegate.md'],
    });
    expect(resolveReviewReportStepParticipation(
      dynamicDelegate,
      workflow,
      [],
      evidence,
      'reviewers',
    )).toEqual({ kind: 'not-participated' });

    stepIndex.clearParallelParticipants(workflow, 'reviewers', []);

    expect(stepIndex.get(workflow, 'delegate', [])).toEqual({ report_names: ['delegate.md'] });
    expect(stepIndex.get(workflow, 'delegate', [], 'reviewers')).toBeUndefined();
  });

  it('uses the common legacy resolver for dynamic parallel participants', () => {
    const selected = makeStep({
      name: 'selected',
      outputContracts: [{ name: 'selected.md', format: '# Selected' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [selected],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('dynamic-legacy-participation', [reviewers, fix]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(workflow, 'reviewers', [], []);
    const legacyIdentity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      selected.name,
      [],
    );
    const participationRecords = new Map(stepIndex.snapshot());
    participationRecords.set(legacyIdentity, { report_names: ['selected.md'] });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(workflow),
        stepOutputNames: new Set(),
        restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: new Map() },
        workflowStepParticipations: participationRecords,
        dynamicParallelSelections: new Map(),
      },
    })).toEqual({ reportNames: ['selected.md'], failures: [] });
  });

  it('clears a legacy parallel participant after a replace round when its parent is unique', () => {
    const selected = makeStep({
      name: 'selected',
      outputContracts: [{ name: 'selected.md', format: '# Selected' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: [selected],
    } as WorkflowStep;
    const workflow = makeWorkflow('legacy-replace-cleanup', [reviewers, makeStep({ name: 'fix' })]);
    const legacyIdentity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      selected.name,
      [],
    );
    const stepIndex = new WorkflowStepParticipationIndex(new Map([
      [legacyIdentity, { report_names: ['selected.md'] }],
    ]));

    stepIndex.clearParallelParticipants(workflow, 'reviewers', []);

    expect(stepIndex.snapshot().has(legacyIdentity)).toBe(false);
    expect(stepIndex.get(workflow, selected.name, [], 'reviewers')).toBeUndefined();
  });

  it('does not retain reports from an earlier replace round in the run-local index', () => {
    const architecture = makeStep({
      name: 'architecture',
      outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
    });
    const frontend = makeStep({
      name: 'frontend',
      outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
    });
    const backend = makeStep({
      name: 'backend',
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [architecture],
        pool: [frontend, backend],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const fix = makeStep({ name: 'fix' });
    const workflow = makeWorkflow('replace-round-index', [reviewers, fix]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(workflow, 'reviewers', [], []);
    stepIndex.record(workflow, 'architecture', [], ['architecture.md'], 'reviewers');
    stepIndex.record(workflow, 'frontend', [], ['frontend.md'], 'reviewers');
    stepIndex.clearParallelParticipants(workflow, 'reviewers', []);
    stepIndex.record(workflow, 'architecture', [], ['architecture.md'], 'reviewers');
    stepIndex.record(workflow, 'backend', [], ['backend.md'], 'reviewers');
    const restoredIndex = restoreWorkflowStepParticipationIndex({
      version: 2,
      stack: [buildWorkflowResumePointEntry(workflow, 'fix', 'agent', 1)],
      iteration: 2,
      elapsed_ms: 1,
      workflow_call_invocations: {},
      workflow_step_participations: stepIndex.serialized(),
    });
    expect(restoredIndex.get(workflow, 'frontend', [], 'reviewers')).toBeUndefined();

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(workflow),
        stepOutputNames: new Set(),
        restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: new Map() },
        workflowStepParticipations: restoredIndex.snapshot(),
        dynamicParallelSelections: new Map(),
      },
    })).toEqual({
      reportNames: ['architecture.md', 'backend.md'],
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

  it('uses exact step participation evidence instead of every pool reviewer', () => {
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
    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['reviewers', 'architecture', 'frontend']),
    })).toEqual({
      reportNames: ['architecture.md', 'frontend.md'],
      failures: [],
    });
  });

  it('filters stale replace-round reports using the current run-local selection', () => {
    const architecture = makeStep({
      name: 'architecture',
      outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
    });
    const frontend = makeStep({
      name: 'frontend',
      description: 'Review frontend changes',
      outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
    });
    const backend = makeStep({
      name: 'backend',
      description: 'Review backend changes',
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [architecture],
        pool: [frontend, backend],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const workflow = makeWorkflow('replace-round-reports', [reviewers, makeStep({ name: 'fix' })]);
    const selectionIdentity = buildDynamicParallelSelectionIdentity(workflow, 'reviewers', []);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: workflow.steps[1]!,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(
        workflow,
        ['reviewers', 'architecture', 'frontend', 'backend'],
        new Map(),
        new Map(),
        new Map([[
          selectionIdentity,
          {
            identity: selectionIdentity,
            step_name: 'reviewers',
            round: 2,
            selected_pool_ids: ['backend'],
            effective_selection_ids: ['architecture', 'backend'],
          },
        ]]),
      ),
    })).toEqual({
      reportNames: ['architecture.md', 'backend.md'],
      failures: [],
    });
  });

  it('keeps same-named sub-steps isolated by their dynamic parallel parent', () => {
    const firstShared = makeStep({
      name: 'shared',
      description: 'Shared first review',
      outputContracts: [{ name: 'shared.md', format: '# Shared' }],
    });
    const secondShared = makeStep({
      name: 'shared',
      description: 'Shared second review',
      outputContracts: [{ name: 'shared.md', format: '# Shared' }],
    });
    const secondOnly = makeStep({
      name: 'second-only',
      description: 'Second-only review',
      outputContracts: [{ name: 'second-only.md', format: '# Second only' }],
    });
    const firstParent = {
      ...makeStep({ name: 'first-reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [firstShared],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const secondParent = {
      ...makeStep({ name: 'second-reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [secondShared, secondOnly],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const workflow = makeWorkflow('parallel-parent-scope', [
      firstParent,
      secondParent,
      makeStep({ name: 'fix' }),
    ]);
    const firstIdentity = buildDynamicParallelSelectionIdentity(workflow, firstParent.name, []);
    const secondIdentity = buildDynamicParallelSelectionIdentity(workflow, secondParent.name, []);
    const participationIndex = new WorkflowStepParticipationIndex(new Map());
    participationIndex.record(workflow, firstParent.name, [], []);
    participationIndex.record(workflow, firstShared.name, [], ['shared.md'], firstParent.name);
    participationIndex.record(workflow, secondParent.name, [], []);

    const context = {
      step: secondParent,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        activeWorkflowReference: getWorkflowReference(workflow),
        stepOutputNames: new Set<string>(),
        restoredStepIterationNames: new Set<string>(),
        workflowCallInvocations: { kind: 'exact' as const, records: new Map() },
        workflowStepParticipations: participationIndex.snapshot(),
        dynamicParallelSelections: new Map([
          [firstIdentity, {
            identity: firstIdentity,
            step_name: firstParent.name,
            round: 1,
            selected_pool_ids: ['shared'],
            effective_selection_ids: ['shared'],
          }],
          [secondIdentity, {
            identity: secondIdentity,
            step_name: secondParent.name,
            round: 1,
            selected_pool_ids: ['second-only'],
            effective_selection_ids: ['second-only'],
          }],
        ]),
      },
    };

    expect(resolveWorkflowStepReportNamesWithDiagnostics(firstParent, context)).toEqual({
      reportNames: ['shared.md'],
      failures: [],
    });
    expect(resolveWorkflowStepReportNamesWithDiagnostics(secondParent, context)).toEqual({
      reportNames: [],
      failures: [],
    });
  });

  it('does not fail report discovery when selection persistence is absent', () => {
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
      failures: [],
    });
  });

  it('does not treat an unrelated same-named output as a dynamic participant', () => {
    const frontend = makeStep({
      name: 'frontend',
      description: 'Review frontend changes',
      outputContracts: [{ name: 'frontend.md', format: '# Review' }],
    });
    const reviewers = {
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic' as const,
        fixed: [],
        pool: [frontend],
        selection: { mode: 'replace' as const },
      },
    } as WorkflowStep;
    const workflow = makeWorkflow('dynamic-reports', [reviewers, makeStep({ name: 'fix' })]);
    const evidence = participation(workflow, ['reviewers']);

    expect(resolveWorkflowStepReportNamesWithDiagnostics(reviewers, {
      step: workflow.steps[1]!,
      workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: {
        ...evidence,
        stepOutputNames: new Set(['reviewers', 'frontend']),
      },
    })).toEqual({
      reportNames: [],
      failures: [],
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
    invocationIndex.record(workflow, 'final-gate', [], {
      call_instance: 2,
      report_namespace_segment: 'iteration-12--step-final-gate--workflow-child-review',
    });
    const callPath = [
      buildWorkflowResumePointEntry(workflow, 'final-gate', 'workflow_call', 1, undefined, 2),
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
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-12--step-final-gate--workflow-child-review/nested-review.md',
      ],
      failures: [],
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('uses exact child workflow participation when discovering dynamic reports', () => {
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
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 2,
      report_namespace_segment: 'iteration-17--step-delegate--workflow-child',
    });
    const currentCallPath = [
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 2),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'reviewers', currentCallPath, []);
    stepIndex.record(child, 'architecture', currentCallPath, ['architecture.md'], 'reviewers');
    stepIndex.record(child, 'frontend', currentCallPath, ['frontend.md'], 'reviewers');

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: parent.steps[1]!,
      workflow: parent,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(parent, [], invocationIndex.snapshot(), stepIndex.snapshot()),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-17--step-delegate--workflow-child/architecture.md',
        'subworkflows/iteration-17--step-delegate--workflow-child/frontend.md',
      ],
      failures: [],
    });
  });

  it('uses exact call instances when discovering grandchild reports', () => {
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
      buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, new Map(), 2),
      buildWorkflowResumePointEntry(child, 'nested', 'workflow_call', 1, new Map(), 3),
    ];
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(parent, 'delegate', [], {
      call_instance: 2,
      report_namespace_segment: 'iteration-11--step-delegate--workflow-child',
    });
    invocationIndex.record(child, 'nested', callPath.slice(0, 1), {
      call_instance: 3,
      report_namespace_segment: 'iteration-14--step-nested--workflow-grandchild',
    });
    const workflows = new Map([
      ['child', child],
      ['grandchild', grandchild],
    ]);
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(grandchild, 'reviewers', callPath, []);
    stepIndex.record(grandchild, 'frontend', callPath, ['frontend.md'], 'reviewers');

    expect(resolveWorkflowStepReportNamesWithDiagnostics(rootCall, {
      step: rootCall,
      workflow: parent,
      workflowCallResolver: ({ step }) => workflows.get(step.call) ?? null,
      projectCwd: '/worktree',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(parent, [], invocationIndex.snapshot(), stepIndex.snapshot()),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-11--step-delegate--workflow-child/'
        + 'subworkflows/iteration-14--step-nested--workflow-grandchild/frontend.md',
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
      report_namespace_segment: 'iteration-2--step-unavailable-review--workflow-missing-review',
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
      report_namespace_segment: 'iteration-4--step-reportless-review--workflow-reportless-child',
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => reportlessChild,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, ['review'], invocationIndex.snapshot()),
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
      report_namespace_segment: 'iteration-1--step-review--workflow-parent',
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
      participation: participation(workflow, [], invocationIndex.snapshot()),
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
    invocationIndex.record(workflow, 'review', [], {
      call_instance: 1,
      report_namespace_segment: 'iteration-5--step-review--workflow-shared-review',
    });
    const callPath = [
      buildWorkflowResumePointEntry(workflow, 'review', 'workflow_call', 1, undefined, 1),
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
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-5--step-review--workflow-shared-review/review.md',
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
        chain.invocationIndex.snapshot(),
        chain.stepParticipationIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [chain.reportName],
      failures: [],
    });
  });

  it('discovers a report at the remaining maximum depth after a resume prefix', () => {
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
    const resumeStackPrefix = Array.from(
      { length: MAX_WORKFLOW_CALL_DEPTH - 2 },
      (_, index) => ({
        workflow: `ancestor-${index}`,
        workflow_ref: `ancestor-${index}`,
        step: `call-${index}`,
        kind: 'workflow_call' as const,
        occurrence: 1,
        call_instance: 1,
      }),
    );
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(workflow, 'review', resumeStackPrefix, {
      call_instance: 1,
      report_namespace_segment: 'iteration-7--step-review--workflow-child',
    });
    const childCallPath = [
      ...resumeStackPrefix,
      buildWorkflowResumePointEntry(workflow, 'review', 'workflow_call', 1, undefined, 1),
    ];
    const stepIndex = new WorkflowStepParticipationIndex(new Map());
    stepIndex.record(child, 'review', childCallPath, ['review.md']);

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix,
      participation: participation(
        workflow,
        [],
        invocationIndex.snapshot(),
        stepIndex.snapshot(),
      ),
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-7--step-review--workflow-child/review.md',
      ],
      failures: [],
    });
  });

  it('rejects one workflow call beyond the remaining depth after a resume prefix', () => {
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
    const resumeStackPrefix = Array.from(
      { length: MAX_WORKFLOW_CALL_DEPTH - 1 },
      (_, index) => ({
        workflow: `ancestor-${index}`,
        workflow_ref: `ancestor-${index}`,
        step: `call-${index}`,
        kind: 'workflow_call' as const,
        occurrence: 1,
        call_instance: 1,
      }),
    );
    const invocationIndex = new WorkflowCallInvocationIndex(new Map());
    invocationIndex.record(workflow, 'review', resumeStackPrefix, {
      call_instance: 1,
      report_namespace_segment: 'iteration-8--step-review--workflow-child',
    });

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix,
      participation: participation(workflow, [], invocationIndex.snapshot()),
    })).toEqual({
      reportNames: [],
      failures: [{
        kind: 'recoverable',
        reason: `workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`,
      }],
    });
  });
});
