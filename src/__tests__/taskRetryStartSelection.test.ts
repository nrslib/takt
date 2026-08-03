import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
  WorkflowStep,
} from '../core/models/index.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import {
  selectTaskRetryStart,
  type TaskRetryStartOptionSelector,
} from '../features/tasks/list/taskRetryStartSelection.js';
import {
  TASK_RETRY_START_PAGE_SIZE,
  validateTaskRetryRestartPoint,
} from '../features/tasks/taskRetryStartPath.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

const mockResolveWorkflowCallTarget = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

const pathContext = {
  projectCwd: '/project',
  lookupCwd: '/project/worktree',
};

function agentStep(name: string): WorkflowStep {
  return {
    name,
    persona: `${name}-persona`,
    instruction: `${name} instruction`,
  };
}

function synthesizedAgentStep(name: string): WorkflowStep {
  return { ...agentStep(name), engineSynthesized: true };
}

function callStep(name: string, call: string): WorkflowStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    instruction: `${name} instruction`,
  } as WorkflowStep;
}

function systemStep(name: string, effects?: WorkflowStep['effects']): WorkflowStep {
  return {
    name,
    kind: 'system',
    personaDisplayName: name,
    instruction: `${name} instruction`,
    ...(effects === undefined ? {} : { effects }),
  };
}

function makeWorkflow(options: {
  name: string;
  ref: string;
  steps: WorkflowStep[];
  initialStep?: string;
  callable?: boolean;
}): WorkflowConfig {
  return attachWorkflowOpaqueRef({
    name: options.name,
    initialStep: options.initialStep ?? options.steps[0]!.name,
    maxSteps: 20,
    steps: options.steps,
    ...(options.callable ? { subworkflow: { callable: true } } : {}),
  }, options.ref);
}

function chooseLabels(labels: string[]): TaskRetryStartOptionSelector {
  let index = 0;
  return vi.fn(async (_message, options) => {
    const expected = labels[index];
    index += 1;
    const selected = options.find((option) => option.label === expected);
    if (selected === undefined) {
      throw new Error(`Missing scripted option: ${expected}`);
    }
    return selected.value;
  });
}

function rootRestartPoint(step: string, kind: 'agent' | 'system' = 'agent'): WorkflowRestartPoint {
  return {
    stack: [{
      workflow: 'default',
      workflow_ref: 'project:root',
      step,
      kind,
    }],
  };
}

function rootResumePoint(step: string, kind: 'agent' | 'system'): WorkflowResumePoint {
  return {
    version: 2,
    stack: [{
      workflow: 'default',
      workflow_ref: 'project:root',
      step,
      kind,
    }],
    iteration: 4,
    elapsed_ms: 1_000,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

describe('task retry start browser contracts', () => {
  beforeEach(() => {
    mockResolveWorkflowCallTarget.mockReset();
  });

  it('should select a grandchild restart with a complete stateless path', async () => {
    const grandchild = makeWorkflow({
      name: 'review-loop',
      ref: 'project:grandchild',
      callable: true,
      steps: [agentStep('review'), agentStep('fix')],
    });
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('implement'), callStep('delegate-review', 'review-loop')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('delegate', 'coding')],
    });
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => ({
        coding: child,
        'review-loop': grandchild,
      })[step.call] ?? null,
    );

    const result = await selectTaskRetryStart(root, pathContext, chooseLabels([
      'Browse child workflow from: "default" > "delegate"',
      'Browse child workflow from: "default" > "delegate" > "coding" > "delegate-review"',
      'Restart from: "default" > "delegate" > "coding" > "delegate-review" > "review-loop" > "fix"',
    ]));

    expect(result?.label).toBe(
      'Restart from: "default" > "delegate" > "coding" > "delegate-review" > "review-loop" > "fix"',
    );
    expect(result?.selection).toEqual({
      kind: 'restart',
      restartPoint: {
        stack: [
          expect.objectContaining({ workflow_ref: 'project:root', step: 'delegate', call_instance: 1 }),
          expect.objectContaining({ workflow_ref: 'project:child', step: 'delegate-review', call_instance: 1 }),
          expect.objectContaining({ workflow_ref: 'project:grandchild', step: 'fix', kind: 'agent' }),
        ],
      },
    });
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(2);
  });

  it('should restart from a terminal workflow_call without resolving its child during selection', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'coding')],
    });

    const result = await selectTaskRetryStart(root, pathContext, chooseLabels([
      'Restart from: "default" > "delegate"',
    ]));

    expect(result?.selection).toEqual({
      kind: 'restart',
      restartPoint: {
        stack: [expect.objectContaining({ step: 'delegate', call_instance: 1 })],
      },
    });
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
  });

  it('should keep a synthesized checkpoint available only through Resume', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [synthesizedAgentStep('engine-step'), agentStep('finish')],
    });
    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: [{
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'engine-step',
        kind: 'agent',
      }],
      iteration: 4,
      elapsed_ms: 1_000,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    let observedOptions: string[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = options.map((option) => option.label);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
    expect(observedOptions).toContain('Resume failed position: "default" > "engine-step" [default]');
    expect(observedOptions).not.toContain('Restart from: "default" > "engine-step"');
    expect(observedDefault).toBe('resume-checkpoint');
  });

  it.each([
    {
      description: 'synthesized agent',
      step: synthesizedAgentStep('engine-step'),
      resumePoint: rootResumePoint('engine-step', 'agent'),
    },
    {
      description: 'effect-backed system',
      step: systemStep('publish', [{ type: 'merge_pr', pr: 42 }]),
      resumePoint: rootResumePoint('publish', 'system'),
    },
  ])('should offer only Resume when a $description checkpoint is the only position', async ({
    step,
    resumePoint,
  }) => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [step],
    });
    let observedOptions: string[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = options.map((option) => option.label);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
    expect(observedOptions).toEqual([
      `Resume failed position: "default" > "${resumePoint.stack[0]!.step}" [default]`,
    ]);
    expect(observedDefault).toBe('resume-checkpoint');
  });

  it('should return no selection when a Resume-only prompt is cancelled', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [synthesizedAgentStep('engine-step')],
    });

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint: rootResumePoint('engine-step', 'agent'),
    }, async () => null);

    expect(result).toBeNull();
  });

  it('should reject a workflow with neither Resume nor authored Restart positions', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });

    await expect(selectTaskRetryStart(root, pathContext, async () => null)).rejects.toThrow();
  });

  it('should omit synthesized and effect-backed siblings at root and child levels', async () => {
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      callable: true,
      steps: [
        synthesizedAgentStep('child-synthetic-first'),
        agentStep('child-agent-middle'),
        systemStep('child-effect-last', [{ type: 'merge_pr', pr: 42 }]),
      ],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        synthesizedAgentStep('root-synthetic-first'),
        callStep('delegate', 'coding'),
        systemStep('root-effect-last', [{ type: 'close_pr', pr: 42 }]),
      ],
      initialStep: 'delegate',
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const promptLabels: string[][] = [];

    await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      promptLabels.push(options.map((option) => option.label));
      if (promptLabels.length === 1) {
        return options.find((option) => option.value.startsWith('open-child-'))!.value;
      }
      return options.find((option) => option.value.startsWith('restart-step-'))!.value;
    });

    expect(promptLabels[0]).toEqual([
      'Restart from: "default" > "delegate"',
      'Browse child workflow from: "default" > "delegate"',
    ]);
    expect(promptLabels[1]).toEqual([
      'Restart from: "default" > "delegate" > "coding" > "child-agent-middle"',
      'Back to parent workflow',
    ]);
  });

  it('should bound a 250,000-step prompt to the current page', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 250_000 }, (_, index) => agentStep(`step-${index}`)),
    });
    let optionCount = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      optionCount = options.length;
      return options.find((option) => option.value === `restart-step-${TASK_RETRY_START_PAGE_SIZE - 1}`)!.value;
    });

    expect(optionCount).toBe(TASK_RETRY_START_PAGE_SIZE + 1);
    expect(result?.label).toBe(`Restart from: "default" > "step-${TASK_RETRY_START_PAGE_SIZE - 1}"`);
  });

  it('should reach every one of 1,001 root steps through Next pages', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 1_001 }, (_, index) => agentStep(`step-${index}`)),
    });
    const observedRestartValues: string[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      observedRestartValues.push(
        ...options.filter((option) => option.value.startsWith('restart-step-')).map((option) => option.value),
      );
      const next = options.find((option) => option.value === 'next-page');
      return next?.value ?? options.find((option) => option.value === 'restart-step-1000')!.value;
    });

    expect(observedRestartValues).toEqual(
      Array.from({ length: 1_001 }, (_, index) => `restart-step-${index}`),
    );
    expect(result?.label).toBe('Restart from: "default" > "step-1000"');
  });

  it('should return from a middle page through Previous without losing the first page', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 101 }, (_, index) => agentStep(`step-${index}`)),
    });
    const selections = ['next-page', 'previous-page', 'restart-step-0'];
    let callIndex = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      const value = selections[callIndex]!;
      callIndex += 1;
      expect(options.some((option) => option.value === value)).toBe(true);
      return value;
    });

    expect(result?.label).toBe('Restart from: "default" > "step-0"');
  });

  it('should return from a child level and select a root sibling', async () => {
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('implement')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'coding'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    const result = await selectTaskRetryStart(root, pathContext, chooseLabels([
      'Browse child workflow from: "default" > "delegate"',
      'Back to parent workflow',
      'Restart from: "default" > "finish"',
    ]));

    expect(result?.label).toBe('Restart from: "default" > "finish"');
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(1);
  });

  it('should discard visited root and child branches after returning to their parent', async () => {
    const leafA = makeWorkflow({
      name: 'leaf-a', ref: 'project:leaf-a', callable: true, steps: [agentStep('finish-a')],
    });
    const leafB = makeWorkflow({
      name: 'leaf-b', ref: 'project:leaf-b', callable: true, steps: [agentStep('finish-b')],
    });
    const parent = makeWorkflow({
      name: 'parent',
      ref: 'project:parent',
      callable: true,
      steps: [
        callStep('open-a', 'leaf-a'),
        callStep('open-b', 'leaf-b'),
        agentStep('finish-parent'),
      ],
    });
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('open-parent', 'parent')],
    });
    const workflows = new Map([
      ['parent', parent],
      ['leaf-a', leafA],
      ['leaf-b', leafB],
    ]);
    mockResolveWorkflowCallTarget.mockImplementation(
      (_workflow: WorkflowConfig, step: { call: string }) => workflows.get(step.call) ?? null,
    );
    const selections = [
      'open-child-0',
      'open-child-0',
      'parent-level',
      'open-child-1',
      'parent-level',
      'open-child-0',
      'parent-level',
      'parent-level',
      'open-child-0',
      'restart-step-2',
    ];
    let selectionIndex = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      const value = selections[selectionIndex]!;
      selectionIndex += 1;
      expect(options.some((option) => option.value === value)).toBe(true);
      return value;
    });

    expect(result?.label).toBe(
      'Restart from: "default" > "open-parent" > "parent" > "finish-parent"',
    );
    expect(mockResolveWorkflowCallTarget.mock.calls.map((call) => call[1].name)).toEqual([
      'open-parent',
      'open-a',
      'open-b',
      'open-a',
      'open-parent',
    ]);
  });

  it('should resolve only the selected child in a 10,000-call fan-out', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 10_000 }, (_, index) => callStep(`call-${index}`, `child-${index}`)),
    });
    const child = makeWorkflow({
      name: 'selected-child',
      ref: 'project:selected-child',
      callable: true,
      steps: [agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let promptCount = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      promptCount += 1;
      if (promptCount === 1) {
        expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
        expect(options.length).toBe(TASK_RETRY_START_PAGE_SIZE * 2 + 1);
        return 'open-child-49';
      }
      expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(1);
      return 'restart-step-0';
    });

    expect(result?.label).toBe(
      'Restart from: "default" > "call-49" > "selected-child" > "finish"',
    );
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(1);
  });

  it('should fail explicitly when the selected child is unknown', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'missing')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    await expect(selectTaskRetryStart(root, pathContext, chooseLabels([
      'Browse child workflow from: "default" > "route"',
    ]))).rejects.toThrow(/route.*missing/i);
  });

  it('should fail explicitly when the selected child is not callable', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'child')],
    });
    const child = makeWorkflow({
      name: 'child', ref: 'project:child', steps: [agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    await expect(selectTaskRetryStart(root, pathContext, chooseLabels([
      'Browse child workflow from: "default" > "route"',
    ]))).rejects.toThrow(/child.*not callable/i);
  });

  it('should detect a cycle only when browsing the selected edge', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'default')],
    });
    const recursive = makeWorkflow({
      name: 'default', ref: 'project:root', callable: true, steps: [agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(recursive);

    await expect(selectTaskRetryStart(root, pathContext, chooseLabels([
      'Browse child workflow from: "default" > "route"',
    ]))).rejects.toThrow(/cycle/i);
  });

  it('should select an authored step at the runtime workflow-call depth limit', async () => {
    const workflows = Array.from({ length: MAX_WORKFLOW_CALL_DEPTH }, (_, index) => makeWorkflow({
      name: `workflow-${index}`,
      ref: `project:workflow-${index}`,
      callable: index > 0,
      steps: index === MAX_WORKFLOW_CALL_DEPTH - 1
        ? [agentStep('finish')]
        : [callStep(`call-${index}`, `workflow-${index + 1}`)],
    }));
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        workflows.find((workflow) => workflow.name === step.call) ?? null
      ),
    );

    const result = await selectTaskRetryStart(
      workflows[0]!,
      pathContext,
      async (_message, options) => (
        options.find((option) => option.value.startsWith('open-child-'))?.value
        ?? options.find((option) => option.value.startsWith('restart-step-'))!.value
      ),
    );

    if (result?.selection.kind !== 'restart') {
      throw new Error('Expected a restart selection at the workflow-call depth limit');
    }
    expect(result.selection.restartPoint.stack).toHaveLength(MAX_WORKFLOW_CALL_DEPTH);
    expect(result.selection.restartPoint.stack.map((entry) => entry.workflow_ref)).toEqual(
      Array.from({ length: MAX_WORKFLOW_CALL_DEPTH }, (_, index) => `project:workflow-${index}`),
    );
    expect(result.selection.restartPoint.stack.map((entry) => entry.step)).toEqual([
      ...Array.from(
        { length: MAX_WORKFLOW_CALL_DEPTH - 1 },
        (_, index) => `call-${index}`,
      ),
      'finish',
    ]);
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(MAX_WORKFLOW_CALL_DEPTH - 1);
  });

  it('should reject browsing beyond the runtime workflow-call depth', async () => {
    const workflows = Array.from({ length: MAX_WORKFLOW_CALL_DEPTH + 1 }, (_, index) => makeWorkflow({
      name: `workflow-${index}`,
      ref: `project:workflow-${index}`,
      callable: index > 0,
      steps: index === MAX_WORKFLOW_CALL_DEPTH
        ? [agentStep('finish')]
        : [callStep(`call-${index}`, `workflow-${index + 1}`)],
    }));
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        workflows.find((workflow) => workflow.name === step.call) ?? null
      ),
    );

    await expect(selectTaskRetryStart(workflows[0]!, pathContext, async (_message, options) => (
      options.find((option) => option.value.startsWith('open-child-'))!.value
    ))).rejects.toThrow(/depth exceeds/i);
  });
});

describe('persisted task retry restart validation', () => {
  it('should allow a selected authored step after root initial changes', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'review',
      steps: [agentStep('plan'), agentStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('plan'), pathContext))
      .not.toThrow();
  });

  it('should allow a selected non-initial step after an unrelated root initial change', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'review',
      steps: [agentStep('plan'), agentStep('review'), agentStep('fix')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('fix'), pathContext))
      .not.toThrow();
  });

  it('should reject a deleted selected root step', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('plan'), agentStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('missing'), pathContext))
      .toThrow();
  });

  it('should reject a selected root step whose kind changed', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('plan'), systemStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('review'), pathContext))
      .toThrow();
  });

  it('should reject a selected root step that became effect-backed', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });

    expect(() => validateTaskRetryRestartPoint(
      root,
      rootRestartPoint('publish', 'system'),
      pathContext,
    )).toThrow();
  });

  it('should reject a selected synthesized agent step', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), synthesizedAgentStep('engine-step')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('engine-step'), pathContext))
      .toThrow();
  });

  it('should reject a root workflow identity mismatch', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:other-root', steps: [agentStep('plan')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('plan'), pathContext))
      .toThrow();
  });
});
