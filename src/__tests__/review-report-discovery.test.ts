import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/types.js';
import {
  resolveInheritedReviewReportNamesWithDiagnostics,
} from '../core/workflow/review-report-discovery.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';
import { makeStep } from './test-helpers.js';

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

function makeWorkflowCallChain(workflowCount: number): {
  workflow: WorkflowConfig;
  workflowsByName: ReadonlyMap<string, WorkflowConfig>;
  reportName: string;
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
      `iteration-*--step-delegate-${index + 1}--workflow-workflow-${index + 2}`,
    ],
  ).flat();
  return {
    workflow: workflows[0]!,
    workflowsByName: new Map(workflows.map((workflow) => [workflow.name, workflow])),
    reportName: [...namespace, 'review.md'].join('/'),
  };
}

describe('review report discovery', () => {
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
    })).toEqual({
      reportNames: ['review.md'],
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

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: resolver,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-*--step-final-gate--workflow-child-review/nested-review.md',
      ],
      failures: [],
    });
    expect(resolver).toHaveBeenCalledTimes(1);
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

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => null,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
    })).toEqual({
      reportNames: ['review.md'],
      failures: ['workflow_call_report_unknown:missing-review'],
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

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => reportlessChild,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
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

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => workflow,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
    })).toEqual({
      reportNames: [],
      failures: ['workflow_call_report_cycle:parent'],
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

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix: [],
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-*--step-review--workflow-shared-review/review.md',
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
        step: `call-${index}`,
        kind: 'workflow_call' as const,
      }),
    );

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix,
    })).toEqual({
      reportNames: [
        'subworkflows/iteration-*--step-review--workflow-child/review.md',
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
        step: `call-${index}`,
        kind: 'workflow_call' as const,
      }),
    );

    expect(resolveInheritedReviewReportNamesWithDiagnostics({
      step: fix,
      workflow,
      workflowCallResolver: () => child,
      projectCwd: '/project',
      lookupCwd: '/worktree',
      resumeStackPrefix,
    })).toEqual({
      reportNames: [],
      failures: [`workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`],
    });
  });
});
