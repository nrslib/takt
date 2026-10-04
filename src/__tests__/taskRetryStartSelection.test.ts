import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
  WorkflowStep,
} from '../core/models/index.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import {
  buildTaskRetryStartOptions,
  resolveTaskRetryStartOption,
  resolveTaskRetryStartOwnership,
  selectTaskRetryStart,
} from '../features/tasks/list/taskRetryStartSelection.js';
import {
  validateTaskRetryRestartPoint,
} from '../features/tasks/taskRetryStartPath.js';
import type { SelectOptionItem } from '../shared/prompt/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { DebugLogger } from '../shared/utils/debug.js';

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
    personaDisplayName: `${name}-persona`,
    instruction: `${name} instruction`,
  };
}

function synthesizedAgentStep(name: string): WorkflowStep {
  return { ...agentStep(name), engineSynthesized: true };
}

function callStep(name: string, call: string): WorkflowCallStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
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
      occurrence: 1,
    }],
    iteration: 4,
    elapsed_ms: 1_000,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function isHeading(option: SelectOptionItem<string>): boolean {
  return option.selectable === false;
}

function firstSelectable(options: SelectOptionItem<string>[]): SelectOptionItem<string> {
  const leaf = options.find((option) => !isHeading(option));
  if (leaf === undefined) {
    throw new Error('No selectable option was presented');
  }
  return leaf;
}

function pickLeaf(name: string): (options: SelectOptionItem<string>[]) => string {
  return (options) => {
    const leaf = options.find((option) => !isHeading(option) && option.label.includes(name));
    return (leaf ?? firstSelectable(options)).value;
  };
}

interface CapturedPrompt {
  result: Awaited<ReturnType<typeof selectTaskRetryStart>>;
  options: SelectOptionItem<string>[];
  defaultValue: string;
  promptCount: number;
}

async function capturePicker(
  root: WorkflowConfig,
  options: Parameters<typeof selectTaskRetryStart>[1],
  pick: (options: SelectOptionItem<string>[], defaultValue: string) => string | null,
): Promise<CapturedPrompt> {
  let captured: SelectOptionItem<string>[] = [];
  let defaultValue = '';
  let promptCount = 0;
  const result = await selectTaskRetryStart(root, options, async (_message, opts, providedDefault) => {
    promptCount += 1;
    captured = opts;
    defaultValue = providedDefault;
    return pick(opts, providedDefault);
  });
  return { result, options: captured, defaultValue, promptCount };
}

function developmentTree(): { root: WorkflowConfig } {
  const suite = makeWorkflow({
    name: 'review-suite',
    ref: 'project:suite',
    callable: true,
    steps: [
      agentStep('initial-reviewers'),
      agentStep('reviewers'),
      agentStep('adjudication'),
      agentStep('fix-plan'),
      agentStep('apply-fix'),
    ],
  });
  const root = makeWorkflow({
    name: 'development-core',
    ref: 'project:root',
    steps: [
      agentStep('plan'),
      agentStep('write-tests'),
      agentStep('implement'),
      callStep('review-suite-call', 'review-suite'),
    ],
  });
  mockResolveWorkflowCallTarget.mockImplementation(
    (_parent: WorkflowConfig, step: { call: string }) => (step.call === 'review-suite' ? suite : null),
  );
  return { root };
}

beforeEach(() => {
  mockResolveWorkflowCallTarget.mockReset();
});

describe('tree restart picker contracts', () => {
  it('should present the whole call tree in a single prompt without the two-line path style', async () => {
    const { root } = developmentTree();

    const cap = await capturePicker(root, pathContext, (options) => firstSelectable(options).value);

    expect(cap.promptCount).toBe(1);
    for (const option of cap.options) {
      expect(option.label.startsWith('Restart from: ')).toBe(false);
      expect(option.label.startsWith('Browse child workflow from: ')).toBe(false);
    }
    const heading = cap.options.find((option) => option.label.includes('review-suite-call'));
    expect(heading).toBeDefined();
    expect(isHeading(heading!)).toBe(true);
    const childLeaf = cap.options.find((option) => option.label.includes('adjudication'));
    expect(childLeaf).toBeDefined();
    expect(isHeading(childLeaf!)).toBe(false);
  });

  it('should mark every workflow_call node as a heading and keep only authored leaves selectable', async () => {
    const { root } = developmentTree();

    const cap = await capturePicker(root, pathContext, (options) => firstSelectable(options).value);

    const headings = cap.options.filter(isHeading);
    const leaves = cap.options.filter((option) => !isHeading(option));
    expect(headings).toHaveLength(1);
    expect(headings[0]!.label).toContain('review-suite-call');
    // 3 root agent steps + 5 child agent steps, all authored restart targets.
    expect(leaves).toHaveLength(8);
  });

  it('should confirm a nested leaf with a stack that ends at the authored step, not the call', async () => {
    const { root } = developmentTree();

    const cap = await capturePicker(root, pathContext, pickLeaf('apply-fix'));

    const selection = cap.result?.selection;
    if (selection?.kind !== 'restart') {
      throw new Error('Expected a restart selection for a nested leaf');
    }
    const stack = selection.restartPoint.stack;
    expect(stack.at(-1)).toEqual(expect.objectContaining({ step: 'apply-fix', kind: 'agent' }));
    expect(stack.at(-2)).toEqual(
      expect.objectContaining({ step: 'review-suite-call', kind: 'workflow_call', call_instance: 1 }),
    );
    expect(stack.at(-1)!.kind).not.toBe('workflow_call');
    expect(() => validateTaskRetryRestartPoint(root, selection.restartPoint, pathContext)).not.toThrow();
  });

  it('should confirm a root leaf with a single-entry stack', async () => {
    const { root } = developmentTree();

    const cap = await capturePicker(root, pathContext, pickLeaf('write-tests'));

    const selection = cap.result?.selection;
    if (selection?.kind !== 'restart') {
      throw new Error('Expected a restart selection for a root leaf');
    }
    expect(selection.restartPoint.stack).toHaveLength(1);
    expect(selection.restartPoint.stack[0]).toEqual(
      expect.objectContaining({ step: 'write-tests', kind: 'agent', workflow_ref: 'project:root' }),
    );
    expect(() => validateTaskRetryRestartPoint(root, selection.restartPoint, pathContext)).not.toThrow();
  });

  it('should give same-named leaves in different subworkflows distinct values and stacks', async () => {
    const alpha = makeWorkflow({
      name: 'alpha', ref: 'project:alpha', callable: true, steps: [agentStep('shared-step')],
    });
    const beta = makeWorkflow({
      name: 'beta', ref: 'project:beta', callable: true, steps: [agentStep('shared-step')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('open-alpha', 'alpha'), callStep('open-beta', 'beta')],
    });
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        { alpha, beta }[step.call] ?? null
      ),
    );

    const cap = await capturePicker(root, pathContext, (options) => firstSelectable(options).value);
    const sharedLeaves = cap.options.filter(
      (option) => !isHeading(option) && option.label.includes('shared-step'),
    );
    expect(sharedLeaves).toHaveLength(2);
    expect(sharedLeaves[0]!.value).not.toBe(sharedLeaves[1]!.value);

    const first = await capturePicker(
      root,
      pathContext,
      (options) => options.find((option) => option.value === sharedLeaves[0]!.value)!.value,
    );
    const second = await capturePicker(
      root,
      pathContext,
      (options) => options.find((option) => option.value === sharedLeaves[1]!.value)!.value,
    );

    const firstStack = first.result?.selection.kind === 'restart'
      ? first.result.selection.restartPoint.stack
      : undefined;
    const secondStack = second.result?.selection.kind === 'restart'
      ? second.result.selection.restartPoint.stack
      : undefined;
    expect(firstStack?.map((entry) => entry.step)).toEqual(['open-alpha', 'shared-step']);
    expect(secondStack?.map((entry) => entry.step)).toEqual(['open-beta', 'shared-step']);
    expect(firstStack?.map((entry) => entry.workflow_ref)).toEqual(['project:root', 'project:alpha']);
    expect(secondStack?.map((entry) => entry.workflow_ref)).toEqual(['project:root', 'project:beta']);
  });

  it('should default to the failed leaf and highlight it as the initial cursor position', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), agentStep('review'), agentStep('fix')],
    });

    const cap = await capturePicker(
      root,
      { ...pathContext, preferredRootStep: 'review' },
      (_options, defaultValue) => defaultValue,
    );

    const failedLeaf = cap.options.find(
      (option) => !isHeading(option) && option.label.includes('review'),
    );
    expect(failedLeaf).toBeDefined();
    expect(cap.defaultValue).toBe(failedLeaf!.value);
    for (const option of cap.options) {
      expect(option.label.startsWith('Restart from: ')).toBe(false);
    }
    const selection = cap.result?.selection;
    if (selection?.kind !== 'restart') {
      throw new Error('Expected a restart selection for the defaulted leaf');
    }
    expect(selection.restartPoint.stack.at(-1)).toEqual(
      expect.objectContaining({ step: 'review', kind: 'agent' }),
    );
  });

  it('should confirm the deepest authored leaf across nested calls in one prompt', async () => {
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

    const cap = await capturePicker(workflows[0]!, pathContext, pickLeaf('finish'));

    expect(cap.promptCount).toBe(1);
    const selection = cap.result?.selection;
    if (selection?.kind !== 'restart') {
      throw new Error('Expected a restart selection at the workflow-call depth limit');
    }
    expect(selection.restartPoint.stack).toHaveLength(MAX_WORKFLOW_CALL_DEPTH);
    expect(selection.restartPoint.stack.map((entry) => entry.workflow_ref)).toEqual(
      Array.from({ length: MAX_WORKFLOW_CALL_DEPTH }, (_, index) => `project:workflow-${index}`),
    );
    expect(selection.restartPoint.stack.at(-1)).toEqual(
      expect.objectContaining({ step: 'finish', kind: 'agent' }),
    );
    expect(() => validateTaskRetryRestartPoint(workflows[0]!, selection.restartPoint, pathContext))
      .not.toThrow();
  });

  it('should omit synthesized and effect-backed steps from the tree at every depth', async () => {
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

    const cap = await capturePicker(root, pathContext, (options) => firstSelectable(options).value);

    const labels = cap.options.map((option) => option.label);
    expect(labels.some((label) => label.includes('child-agent-middle'))).toBe(true);
    expect(labels.some((label) => label.includes('child-synthetic-first'))).toBe(false);
    expect(labels.some((label) => label.includes('child-effect-last'))).toBe(false);
    expect(labels.some((label) => label.includes('root-synthetic-first'))).toBe(false);
    expect(labels.some((label) => label.includes('root-effect-last'))).toBe(false);
    const middleLeaf = cap.options.find((option) => option.label.includes('child-agent-middle'));
    expect(isHeading(middleLeaf!)).toBe(false);
  });

  it('should degrade an unresolvable workflow_call to a noted heading and keep other leaves selectable', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('broken-call', 'missing')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    const cap = await capturePicker(root, pathContext, pickLeaf('plan'));

    const brokenHeading = cap.options.find((option) => option.label.includes('broken-call'));
    expect(brokenHeading).toBeDefined();
    expect(isHeading(brokenHeading!)).toBe(true);
    expect(brokenHeading!.description).toContain('unknown workflow');
    // The healthy sibling leaf stays selectable and confirms normally.
    const planLeaf = cap.options.find((option) => !isHeading(option) && option.label.includes('plan'));
    expect(planLeaf).toBeDefined();
    const selection = cap.result?.selection;
    if (selection?.kind !== 'restart') {
      throw new Error('Expected a restart selection for the healthy leaf');
    }
    expect(selection.restartPoint.stack.at(-1)).toEqual(
      expect.objectContaining({ step: 'plan', kind: 'agent' }),
    );
  });
});

describe('resume checkpoint is preserved across the tree picker', () => {
  it('should put the failed step in the Resume label and the paired call path in its description', async () => {
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'coding')],
    });
    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'project:root',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
          call_instance: 1,
        },
        {
          workflow: 'coding',
          workflow_ref: 'project:child',
          step: 'review',
          kind: 'agent',
          occurrence: 1,
        },
      ],
      iteration: 4,
      elapsed_ms: 1_000,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    const cap = await capturePicker(
      root,
      { ...pathContext, resumePoint },
      (_options, defaultValue) => defaultValue,
    );

    const resumeOption = cap.options.find((option) => option.value === 'resume-checkpoint');
    expect(resumeOption?.label.replaceAll('"', '')).toBe('Resume failed position: review');
    expect(resumeOption?.description?.replaceAll('"', '')).toBe('default > delegate → coding > review');
    expect(cap.defaultValue).toBe(resumeOption?.value);
    expect(cap.result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should keep the same Resume label for root and nested failures at the same step', () => {
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('review'), callStep('delegate', 'coding')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const rootPoint = rootResumePoint('review', 'agent');
    const nestedPoint: WorkflowResumePoint = {
      ...rootPoint,
      stack: [
        { ...rootPoint.stack[0]!, step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'project:child', step: 'review', kind: 'agent', occurrence: 1 },
      ],
    };

    const rootOptions = buildTaskRetryStartOptions(root, { ...pathContext, resumePoint: rootPoint });
    const nestedOptions = buildTaskRetryStartOptions(root, { ...pathContext, resumePoint: nestedPoint });
    const rootResume = rootOptions.options.find((option) => option.id === rootOptions.defaultId)!;
    const nestedResume = nestedOptions.options.find((option) => option.id === nestedOptions.defaultId)!;

    expect(rootResume.label).toBe(nestedResume.label);
    expect(rootResume.description?.replaceAll('"', '')).toBe('default > review');
    expect(nestedResume.description?.replaceAll('"', '')).toBe('default > delegate → coding > review');
  });

  it('should describe every call pair in order from the root to a deeply nested failure', () => {
    const levels = [
      { name: 'takt-default', step: 'develop', child: 'development-core' },
      { name: 'development-core', step: 'peer-review', child: 'peer-review' },
      { name: 'peer-review', step: 'initial-reviewers', child: 'takt-development-review' },
      { name: 'takt-development-review', step: 'review', child: undefined },
    ];
    const workflows = levels.map((level, index) => makeWorkflow({
      name: level.name,
      ref: `project:${level.name}`,
      callable: index > 0,
      steps: [level.child === undefined ? agentStep(level.step) : callStep(level.step, level.child)],
    }));
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: WorkflowCallStep) => workflows.find((workflow) => workflow.name === step.call) ?? null,
    );
    const resumePoint: WorkflowResumePoint = {
      ...rootResumePoint('review', 'agent'),
      stack: levels.map((level) => ({
        workflow: level.name,
        workflow_ref: `project:${level.name}`,
        step: level.step,
        kind: level.child === undefined ? 'agent' : 'workflow_call',
        occurrence: 1,
        ...(level.child === undefined ? {} : { call_instance: 1 }),
      })),
    };

    const catalog = buildTaskRetryStartOptions(workflows[0]!, { ...pathContext, resumePoint });
    const resume = catalog.options.find((option) => option.id === catalog.defaultId)!;

    expect(resume.description?.replaceAll('"', '')).toBe(
      'takt-default > develop → development-core > peer-review → peer-review > initial-reviewers → takt-development-review > review',
    );
  });

  it('should escape controls and preserve separators inside every name of a Resume call path', () => {
    const rootName = 'root > name\n';
    const callName = 'call → name\r';
    const childName = 'child > name\x1b';
    const failedName = 'review → name\t';
    const child = makeWorkflow({
      name: childName, ref: 'project:child', callable: true, steps: [agentStep(failedName)],
    });
    const root = makeWorkflow({
      name: rootName, ref: 'project:root', steps: [callStep(callName, 'child')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const resumePoint: WorkflowResumePoint = {
      ...rootResumePoint(failedName, 'agent'),
      stack: [
        { workflow: rootName, workflow_ref: 'project:root', step: callName, kind: 'workflow_call', occurrence: 1, call_instance: 1 },
        { workflow: childName, workflow_ref: 'project:child', step: failedName, kind: 'agent', occurrence: 1 },
      ],
    };

    const catalog = buildTaskRetryStartOptions(root, { ...pathContext, resumePoint });
    const resume = catalog.options.find((option) => option.id === catalog.defaultId)!;

    expect(resume.description?.replaceAll('"', '')).toBe('root > name\\n > call → name\\r → child > name\\u001b > review → name\\t');
    expect(resume.label).toContain('review → name\\t');
    for (const text of [resume.label, resume.description]) {
      expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
    }
  });

  it('should keep parallel parent and failed sub-step separate from workflow call pairs', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root',
      steps: [{
        name: 'parallel-review',
        personaDisplayName: 'parallel-review',
        instruction: 'parallel review instruction',
        parallel: [{ name: 'review', personaDisplayName: 'review', instruction: 'review instruction' }],
      }],
    });
    const resumePoint: WorkflowResumePoint = {
      ...rootResumePoint('parallel-review', 'agent'),
      stack: [
        rootResumePoint('parallel-review', 'agent').stack[0]!,
        rootResumePoint('review', 'agent').stack[0]!,
      ],
    };

    const catalog = buildTaskRetryStartOptions(root, { ...pathContext, resumePoint });
    const resume = catalog.options.find((option) => option.id === catalog.defaultId)!;

    expect(resume.label.replaceAll('"', '')).toBe('Resume failed position: review');
    expect(resume.description?.replaceAll('"', '')).toBe('default > parallel-review > review');
  });

  it('should end a Resume path at a failed workflow call without adding its unentered child', () => {
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('delegate', 'coding')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const resumePoint: WorkflowResumePoint = {
      ...rootResumePoint('delegate', 'agent'),
      stack: [{ ...rootResumePoint('delegate', 'agent').stack[0]!, kind: 'workflow_call', call_instance: 1 }],
    };

    const catalog = buildTaskRetryStartOptions(root, { ...pathContext, resumePoint });
    const resume = catalog.options.find((option) => option.id === catalog.defaultId)!;

    expect(resume.label.replaceAll('"', '')).toBe('Resume failed position: delegate');
    expect(resume.description?.replaceAll('"', '')).toBe('default > delegate');
  });

  it.each(['absent', 'invalid'] as const)('should preserve tree labels and default when the checkpoint is %s', (checkpoint) => {
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('plan'), callStep('delegate', 'coding')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    const catalog = buildTaskRetryStartOptions(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
      ...(checkpoint === 'invalid' ? { resumePoint: rootResumePoint('deleted-step', 'agent') } : {}),
    });

    expect(catalog.options).toEqual([
      { id: 'restart:0', label: '"plan"', selectable: true },
      { id: 'heading:1', label: '"delegate":', selectable: false },
      { id: 'restart:1.0', label: '  "review"', selectable: true },
    ]);
    expect(catalog.defaultId).toBe('restart:1.0');
  });

  it.each(['missing', 'non-callable'] as const)(
    'should omit a saved Resume path with a %s child while preserving restart choices',
    async (childState) => {
      const root = makeWorkflow({
        name: 'default', ref: 'project:root',
        steps: [agentStep('plan'), callStep('delegate', 'coding'), agentStep('finish')],
      });
      mockResolveWorkflowCallTarget.mockReturnValue(childState === 'missing' ? null : makeWorkflow({
        name: 'coding', ref: 'project:child', steps: [agentStep('review')],
      }));
      const resumePoint: WorkflowResumePoint = {
        ...rootResumePoint('delegate', 'agent'),
        stack: [
          { ...rootResumePoint('delegate', 'agent').stack[0]!, kind: 'workflow_call', call_instance: 1 },
          { workflow: 'coding', workflow_ref: 'project:child', step: 'review', kind: 'agent', occurrence: 1 },
        ],
      };
      const context = { ...pathContext, resumePoint, preferredRootStep: 'finish' };

      const catalog = buildTaskRetryStartOptions(root, context);

      expect(catalog.options.map(({ id, label, selectable }) => ({ id, label, selectable }))).toEqual([
        { id: 'restart:0', label: '"plan"', selectable: true },
        { id: 'heading:1', label: '"delegate":', selectable: false },
        { id: 'restart:2', label: '"finish"', selectable: true },
      ]);
      expect(catalog.options[1]?.description).toBeTruthy();
      expect(catalog.defaultId).toBe('restart:2');
      expect(buildTaskRetryStartOptions(root, { ...context, preferredRootStep: 'delegate' }).defaultId)
        .toBe('restart:0');
      const expected = { label: '"plan"', selection: { kind: 'restart', restartPoint: rootRestartPoint('plan') } };
      expect(resolveTaskRetryStartOption(root, context, 'restart:0')).toEqual(expected);
      expect(() => resolveTaskRetryStartOption(root, context, 'resume-checkpoint')).toThrow();
      expect(await selectTaskRetryStart(root, context, async () => 'restart:0')).toEqual(expected);
      expect(await selectTaskRetryStart(root, context, async () => null)).toBeNull();
    },
  );

  it('should debug-log a Resume path resolution error while preserving restart choices', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root',
      steps: [agentStep('plan'), callStep('delegate', 'coding'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockImplementation(() => {
      throw new Error('Resolver failed unexpectedly');
    });
    const resumePoint: WorkflowResumePoint = {
      ...rootResumePoint('delegate', 'agent'),
      stack: [
        { ...rootResumePoint('delegate', 'agent').stack[0]!, kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'project:coding', step: 'review', kind: 'agent', occurrence: 1 },
      ],
    };
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    try {
      const catalog = buildTaskRetryStartOptions(root, {
        ...pathContext,
        resumePoint,
        preferredRootStep: 'finish',
      });

      expect(catalog.options.some((option) => option.id === 'resume-checkpoint')).toBe(false);
      expect(catalog.defaultId).toBe('restart:2');
      expect(writeLog).toHaveBeenCalledWith(
        'DEBUG',
        'task-retry-start',
        'Failed to resolve saved task retry Resume path',
        { error: 'Resolver failed unexpectedly' },
      );
    } finally {
      writeLog.mockRestore();
    }
  });

  it.each([
    { childState: 'missing', source: 'step' },
    { childState: 'missing', source: 'parent' },
    { childState: 'missing', source: 'call' },
    { childState: 'non-callable', source: 'step' },
    { childState: 'non-callable', source: 'child' },
  ] as const)('should visualize controls from the $source of a $childState child only for CLI headings', async ({ childState, source }) => {
    for (const suffix of ['', '\x1b[2J']) {
      const stepName = `delegate${source === 'step' ? suffix : ''}`;
      const parentName = `root${source === 'parent' ? suffix : ''}`;
      const childName = `coding${source === 'child' ? suffix : ''}`;
      const callReference = `missing${source === 'call' ? suffix : ''}`;
      const child = makeWorkflow({ name: childName, ref: 'project:child', steps: [agentStep('review')] });
      const root = makeWorkflow({
        name: parentName, ref: 'project:root',
        steps: [agentStep('plan'), callStep(stepName, callReference), agentStep('finish')],
      });
      mockResolveWorkflowCallTarget.mockReturnValue(childState === 'missing' ? null : child);
      const resumePoint: WorkflowResumePoint = {
        ...rootResumePoint(stepName, 'agent'),
        stack: [
          { workflow: parentName, workflow_ref: 'project:root', step: stepName, kind: 'workflow_call', occurrence: 1, call_instance: 1 },
          { workflow: childName, workflow_ref: 'project:child', step: 'review', kind: 'agent', occurrence: 1 },
        ],
      };
      const context = { ...pathContext, resumePoint, preferredRootStep: 'finish' };
      const sharedBefore = buildTaskRetryStartOptions(root, context);
      const sharedSnapshot = structuredClone(sharedBefore);

      const cap = await capturePicker(root, context, (_options, defaultValue) => defaultValue);
      const heading = cap.options.find((option) => option.selectable === false)!;
      const rawDescription = sharedBefore.options.find((option) => !option.selectable)!.description!;

      expect(heading.description).toBe(rawDescription.replaceAll('\x1b', '\\x1b'));
      expect(heading.description).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
      if (suffix !== '') {
        expect(rawDescription).toContain('\x1b[2J');
        expect(heading.description).toContain('\\x1b[2J');
      }
      expect(cap.options.filter((option) => option.selectable !== false).map((option) => option.value))
        .toEqual(['restart:0', 'restart:2']);
      expect(cap.defaultValue).toBe('restart:2');
      expect(cap.result?.selection).toEqual({
        kind: 'restart',
        restartPoint: { stack: [{ workflow: parentName, workflow_ref: 'project:root', step: 'finish', kind: 'agent' }] },
      });
      expect(sharedBefore).toEqual(sharedSnapshot);
      expect(buildTaskRetryStartOptions(root, context)).toEqual(sharedSnapshot);
    }
  });

  it.each([
    { name: 'delegate\n\r\t\x00\x07\x1f\x7f\x80\x9b\x9f', visible: 'delegate\\n\\r\\t\\x00\\x07\\x1f\\x7f\\x80\\x9b\\x9f' },
    { name: 'delegate"\\x1b[2J 日本語', visible: 'delegate"\\x1b[2J 日本語' },
  ])('should preserve ordinary characters and visualize heading controls in $visible', async ({ name, visible }) => {
    const root = makeWorkflow({
      name: 'root', ref: 'project:root', steps: [agentStep('plan'), callStep(name, 'missing')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    const cap = await capturePicker(root, pathContext, () => null);
    const heading = cap.options.find((option) => option.selectable === false)!;

    expect(heading.description).toContain(visible);
    expect(heading.description).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
    expect(cap.result).toBeNull();
  });

  it('should preserve a CLI heading without a description', async () => {
    const { root } = developmentTree();

    const cap = await capturePicker(root, pathContext, () => null);

    expect(cap.options.find((option) => option.selectable === false)).not.toHaveProperty('description');
  });

  it('should keep a synthesized checkpoint available and default through Resume', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [synthesizedAgentStep('engine-step'), agentStep('finish')],
    });
    const resumePoint: WorkflowResumePoint = rootResumePoint('engine-step', 'agent');

    const cap = await capturePicker(
      root,
      { ...pathContext, resumePoint },
      (_options, defaultValue) => defaultValue,
    );

    expect(cap.result?.selection).toEqual({ kind: 'resume', resumePoint });
    expect(cap.options.some((option) => option.label.length > 0)).toBe(true);
    expect(cap.defaultValue).toBe('resume-checkpoint');
    const resumeOption = cap.options.find((option) => option.value === cap.defaultValue);
    expect(resumeOption?.label.startsWith('Resume failed position:')).toBe(true);
    expect(cap.options.some((option) => option.label.startsWith('Restart from: '))).toBe(false);
    // The synthesized checkpoint is never presented as a selectable restart leaf.
    expect(cap.options.some(
      (option) => option.value.startsWith('restart:') && option.label.includes('engine-step'),
    )).toBe(false);
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

    const cap = await capturePicker(
      root,
      { ...pathContext, resumePoint },
      (_options, defaultValue) => defaultValue,
    );

    expect(cap.result?.selection).toEqual({ kind: 'resume', resumePoint });
    expect(cap.options).toHaveLength(1);
    expect(cap.options[0]!.label.startsWith('Resume failed position:')).toBe(true);
    expect(cap.options[0]!.value).toBe(cap.defaultValue);
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
});

describe('task retry start options without terminal selection', () => {
  it('should resolve a selected restart leaf to the saved restart ownership', () => {
    const { root } = developmentTree();
    const options = buildTaskRetryStartOptions(root, pathContext);
    const selectedOption = options.options.find(
      (option) => option.selectable && option.label.includes('write-tests'),
    );

    expect(selectedOption).toBeDefined();
    expect(resolveTaskRetryStartOption(root, pathContext, selectedOption!.id)).toEqual({
      label: expect.stringContaining('write-tests'),
      selection: {
        kind: 'restart',
        restartPoint: expect.objectContaining({
          stack: [expect.objectContaining({ step: 'write-tests', kind: 'agent' })],
        }),
      },
    });
    expect(resolveTaskRetryStartOwnership(
      resolveTaskRetryStartOption(root, pathContext, selectedOption!.id).selection,
      root,
    )).toEqual({
      restartPoint: expect.objectContaining({
        stack: [expect.objectContaining({ step: 'write-tests', kind: 'agent' })],
      }),
    });
  });

  it('should reject unknown and non-selectable start option identifiers', () => {
    const { root } = developmentTree();
    const options = buildTaskRetryStartOptions(root, pathContext);
    const heading = options.options.find((option) => !option.selectable);

    expect(heading).toBeDefined();
    expect(() => resolveTaskRetryStartOption(root, pathContext, heading!.id)).toThrow(
      `Unknown task retry start selection: ${heading!.id}`,
    );
    expect(() => resolveTaskRetryStartOption(root, pathContext, 'assistant-selected-unknown-id'))
      .toThrow('Unknown task retry start selection: assistant-selected-unknown-id');
  });

  it('should map a selected resume option to the saved checkpoint and root start step', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), agentStep('replan')],
    });
    const resumePoint = rootResumePoint('replan', 'agent');
    const options = { ...pathContext, resumePoint };
    const catalog = buildTaskRetryStartOptions(root, options);
    const selected = resolveTaskRetryStartOption(root, options, catalog.defaultId);

    expect(catalog.defaultId).toBe('resume-checkpoint');
    expect(selected.selection).toEqual({ kind: 'resume', resumePoint });
    expect(resolveTaskRetryStartOwnership(selected.selection, root)).toEqual({
      startStep: 'replan',
      resumePoint,
    });
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

  it('should accept a persisted restart point that terminates at a workflow_call (legacy saved task)', () => {
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('finish')],
    });
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('delegate', 'coding')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const restartPoint: WorkflowRestartPoint = {
      stack: [{
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate',
        kind: 'workflow_call',
        call_instance: 1,
      }],
    };

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext)).not.toThrow();
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

  it('should reject a restart path when a non-call middle step cannot lead to the terminal entry', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'project:root', step: 'plan', kind: 'agent' },
        { workflow: 'child', workflow_ref: 'project:child', step: 'finish', kind: 'agent' },
      ],
    };

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('Restart path cannot continue after non-call step "plan"');
  });

  it('should reject a nested restart path when the resolved child workflow is not callable', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'coding')],
    });
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      steps: [agentStep('finish')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'project:root',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 1,
        },
        { workflow: 'coding', workflow_ref: 'project:child', step: 'finish', kind: 'agent' },
      ],
    };
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('workflow "coding" referenced by step "delegate" is not callable');
  });

  it('should reject a nested restart path when the child workflow_ref no longer matches', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'coding')],
    });
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('finish')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'project:root',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 1,
        },
        { workflow: 'coding', workflow_ref: 'project:other-child', step: 'finish', kind: 'agent' },
      ],
    };
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('Task retry restart path cannot be resolved at step "finish"');
  });
});
