import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowStep,
} from '../core/models/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import {
  TASK_RETRY_START_WINDOW_SIZE,
  TaskRetryRestartTree,
  type TaskRetryRestartTreeNode,
} from '../features/tasks/taskRetryStartPath.js';

const mockResolveWorkflowCallTarget = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

const pathContext = {
  projectCwd: '/project',
  lookupCwd: '/project/worktree',
};

interface InspectedWindow {
  start: number;
  end: number;
}

interface InspectedNodeUiState {
  id: string;
  expanded: boolean;
  childFrame?: InspectedFrameState;
}

interface InspectedFrameState {
  activeStepWindow: InspectedWindow | undefined;
  activeParallelWindows: Map<number, InspectedWindow>;
  nodeStates: Map<string, InspectedNodeUiState>;
}

function agentStep(name: string): WorkflowStep {
  return {
    name,
    persona: `${name}-persona`,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
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

function parallelStep(name: string, parallel: WorkflowStep[]): WorkflowStep {
  return {
    ...agentStep(name),
    parallel,
  };
}

function makeWorkflow(options: {
  name: string;
  ref: string;
  steps: WorkflowStep[];
  callable?: boolean;
}): WorkflowConfig {
  return attachWorkflowOpaqueRef({
    name: options.name,
    initialStep: options.steps[0]!.name,
    maxSteps: 20,
    steps: options.steps,
    ...(options.callable ? { subworkflow: { callable: true } } : {}),
  }, options.ref);
}

function rootRestartPoint(step: string): WorkflowRestartPoint {
  return {
    stack: [{
      workflow: 'default',
      workflow_ref: 'project:root',
      step,
      kind: 'agent',
    }],
  };
}

function findNodeByStep(
  tree: TaskRetryRestartTree,
  stepName: string,
): TaskRetryRestartTreeNode {
  const node = tree.getVisibleNodes().find((candidate) => candidate.step.name === stepName);
  if (node === undefined) throw new Error(`Missing tree node: ${stepName}`);
  return node;
}

function registerDeepCallChain(
  workflowsByCall: Map<string, WorkflowConfig>,
  prefix: string,
): WorkflowCallStep {
  workflowsByCall.set(`${prefix}-workflow-4`, makeWorkflow({
    name: `${prefix}-workflow-4`,
    ref: `project:${prefix}-workflow-4`,
    callable: true,
    steps: [agentStep(`${prefix}-leaf`)],
  }));
  for (let level = 3; level >= 1; level -= 1) {
    workflowsByCall.set(`${prefix}-workflow-${level}`, makeWorkflow({
      name: `${prefix}-workflow-${level}`,
      ref: `project:${prefix}-workflow-${level}`,
      callable: true,
      steps: [callStep(`${prefix}-call-${level + 1}`, `${prefix}-workflow-${level + 1}`)],
    }));
  }
  return callStep(prefix, `${prefix}-workflow-1`);
}

function expandDeepCallChain(tree: TaskRetryRestartTree, prefix: string): void {
  for (const stepName of [
    prefix,
    `${prefix}-call-2`,
    `${prefix}-call-3`,
    `${prefix}-call-4`,
  ]) {
    const node = findNodeByStep(tree, stepName);
    expect(node.kind).toBe('navigation');
    if (node.kind !== 'navigation') throw new Error(`Expected navigation node: ${stepName}`);
    tree.toggleNavigation(node);
  }
}

function inspectRootFrame(tree: TaskRetryRestartTree): InspectedFrameState {
  return (tree as unknown as { rootFrame: InspectedFrameState }).rootFrame;
}

function expectNodeStateKeysActive(frame: InspectedFrameState): void {
  const stepWindow = frame.activeStepWindow;
  expect(stepWindow).toBeDefined();
  for (const key of frame.nodeStates.keys()) {
    const parts = key.split(':');
    if (parts[0] === 'step') {
      const stepIndex = Number(parts[1]);
      expect(stepIndex).toBeGreaterThanOrEqual(stepWindow!.start);
      expect(stepIndex).toBeLessThan(stepWindow!.end);
      continue;
    }
    const parentStepIndex = Number(parts[1]);
    const parallelStepIndex = Number(parts[2]);
    const parallelWindow = frame.activeParallelWindows.get(parentStepIndex);
    expect(parentStepIndex).toBeGreaterThanOrEqual(stepWindow!.start);
    expect(parentStepIndex).toBeLessThan(stepWindow!.end);
    expect(parallelWindow).toBeDefined();
    expect(parallelStepIndex).toBeGreaterThanOrEqual(parallelWindow!.start);
    expect(parallelStepIndex).toBeLessThan(parallelWindow!.end);
  }
  for (const state of frame.nodeStates.values()) {
    if (state.childFrame !== undefined) expectNodeStateKeysActive(state.childFrame);
  }
}

beforeEach(() => {
  mockResolveWorkflowCallTarget.mockReset();
});

describe('TaskRetryRestartTree invariants', () => {
  it('keeps Resume and the expanded unrelated child projected within the shared budget', () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('child-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        agentStep('resume'),
        ...Array.from({ length: 48 }, (_, index) => agentStep(`step-${index}`)),
        callStep('unrelated', 'child'),
        ...Array.from({ length: 50 }, (_, index) => agentStep(`later-${index}`)),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const tree = new TaskRetryRestartTree(
      root,
      pathContext,
      undefined,
      { resumeRestartPoint: rootRestartPoint('resume') },
    );
    const resumeValue = tree.getDefaultValue();
    const navigation = findNodeByStep(tree, 'unrelated');
    expect(navigation.kind).toBe('navigation');
    if (navigation.kind !== 'navigation') throw new Error('Expected navigation node');

    tree.toggleNavigation(navigation);

    const visible = tree.getVisibleNodes();
    expect(visible).toHaveLength(TASK_RETRY_START_WINDOW_SIZE);
    expect(new Set(visible.map((node) => node.value)).size).toBe(visible.length);
    expect(visible.some((node) => node.step.name === 'resume')).toBe(true);
    expect(visible.some((node) => node.step.name === 'child-review')).toBe(true);
    expect(tree.getDefaultValue()).toBe(resumeValue);
  });

  it('recaptures a visible Resume when an over-budget expansion structurally moves the root window', () => {
    const workflowsByCall = new Map<string, WorkflowConfig>();
    const beforeTriggerBranches = Array.from({ length: 9 }, (_, index) => (
      registerDeepCallChain(workflowsByCall, `before-${index}`)
    ));
    const afterTriggerBranches = Array.from({ length: 2 }, (_, index) => (
      registerDeepCallChain(workflowsByCall, `after-${index}`)
    ));
    for (const call of ['normal-a-child', 'normal-b-child', 'trigger-child']) {
      workflowsByCall.set(call, makeWorkflow({
        name: call,
        ref: `project:${call}`,
        callable: true,
        steps: [agentStep(`${call}-leaf`)],
      }));
    }
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        parallelStep('reviewers', [
          ...beforeTriggerBranches,
          callStep('normal-a', 'normal-a-child'),
          callStep('normal-b', 'normal-b-child'),
          callStep('structural-trigger', 'trigger-child'),
          ...afterTriggerBranches,
        ]),
        ...Array.from({ length: 48 }, (_, index) => agentStep(`root-step-${index + 1}`)),
        agentStep('resume'),
      ],
    });
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: WorkflowCallStep) => {
        const workflow = workflowsByCall.get(step.call);
        if (workflow === undefined) throw new Error(`Missing workflow fixture: ${step.call}`);
        return workflow;
      },
    );
    const tree = new TaskRetryRestartTree(
      root,
      pathContext,
      undefined,
      { resumeRestartPoint: rootRestartPoint('resume') },
    );
    const resumeValue = tree.getDefaultValue();
    const parallelParent = findNodeByStep(tree, 'reviewers');
    expect(tree.handleKeyPress(parallelParent.value, '\x1B[B')).toBe(true);

    for (const prefix of ['after-0', 'after-1']) expandDeepCallChain(tree, prefix);
    for (const prefix of Array.from({ length: 9 }, (_, index) => `before-${index}`)) {
      expandDeepCallChain(tree, prefix);
    }

    const before = tree.getVisibleNodes();
    const beforeLeadingSteps = before.slice(0, 5).map((node) => node.step.name);
    expect(beforeLeadingSteps[0]).toBe('reviewers');
    expect(before.some((node) => node.step.name === 'structural-trigger')).toBe(true);
    expect(before.some((node) => node.step.name === 'resume')).toBe(true);
    const trigger = findNodeByStep(tree, 'structural-trigger');
    expect(trigger.kind).toBe('navigation');
    if (trigger.kind !== 'navigation') throw new Error('Expected structural trigger navigation');

    tree.toggleNavigation(trigger);

    const after = tree.getVisibleNodes();
    const afterLeadingSteps = after.slice(0, 5).map((node) => node.step.name);
    expect(afterLeadingSteps).not.toEqual(beforeLeadingSteps);
    expect(afterLeadingSteps[0]).toBe('root-step-1');
    expect(after.some((node) => node.step.name === 'reviewers')).toBe(false);
    expect(after).toHaveLength(TASK_RETRY_START_WINDOW_SIZE - 1);
    expect(new Set(after.map((node) => node.value)).size).toBe(after.length);
    const resume = findNodeByStep(tree, 'resume');
    expect(resume.kind).toBe('leaf');
    expect(resume.kind === 'leaf' && resume.isResumeCandidate).toBe(true);
    expect(tree.getDefaultValue()).toBe(resumeValue);
  });

  it('keeps a preferred leaf as the default while expanding and collapsing an unrelated branch', () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('child-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        agentStep('preferred'),
        ...Array.from({ length: 48 }, (_, index) => agentStep(`step-${index}`)),
        callStep('unrelated', 'child'),
        ...Array.from({ length: 50 }, (_, index) => agentStep(`later-${index}`)),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const tree = new TaskRetryRestartTree(root, pathContext, 'preferred', {});
    const preferredValue = tree.getDefaultValue();
    const navigation = findNodeByStep(tree, 'unrelated');
    expect(navigation.kind).toBe('navigation');
    if (navigation.kind !== 'navigation') throw new Error('Expected navigation node');

    tree.toggleNavigation(navigation);
    const expanded = tree.getVisibleNodes();
    expect(expanded).toHaveLength(TASK_RETRY_START_WINDOW_SIZE);
    expect(expanded.some((node) => node.step.name === 'preferred')).toBe(true);
    expect(expanded.some((node) => node.step.name === 'child-review')).toBe(true);
    expect(tree.getDefaultValue()).toBe(preferredValue);

    const expandedNavigation = findNodeByStep(tree, 'unrelated');
    expect(expandedNavigation.kind).toBe('navigation');
    if (expandedNavigation.kind !== 'navigation') throw new Error('Expected navigation node');
    tree.toggleNavigation(expandedNavigation);
    expect(tree.getVisibleNodes().some((node) => node.step.name === 'preferred')).toBe(true);
    expect(tree.getDefaultValue()).toBe(preferredValue);
  });

  it('prunes a parallel child atomically and recreates a fresh child frame', () => {
    const grandchild = makeWorkflow({
      name: 'grandchild',
      ref: 'project:grandchild',
      callable: true,
      steps: [agentStep('grandchild-review')],
    });
    const childV1 = makeWorkflow({
      name: 'child-v1',
      ref: 'project:child-v1',
      callable: true,
      steps: [callStep('nested', 'grandchild'), agentStep('child-v1-finish')],
    });
    const childV2 = makeWorkflow({
      name: 'child-v2',
      ref: 'project:child-v2',
      callable: true,
      steps: [agentStep('child-v2-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        parallelStep('reviewers', [callStep('delegate', 'child')]),
        ...Array.from({ length: 99 }, (_, index) => agentStep(`step-${index + 1}`)),
      ],
    });
    let delegateChild = childV1;
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: WorkflowCallStep) => {
        if (step.call === 'child') return delegateChild;
        if (step.call === 'grandchild') return grandchild;
        throw new Error(`Missing workflow fixture: ${step.call}`);
      },
    );
    const tree = new TaskRetryRestartTree(root, pathContext, undefined, {});
    const parent = findNodeByStep(tree, 'reviewers');
    expect(tree.handleKeyPress(parent.value, '\x1B[B')).toBe(true);
    const delegate = findNodeByStep(tree, 'delegate');
    expect(delegate.kind).toBe('navigation');
    if (delegate.kind !== 'navigation') throw new Error('Expected navigation node');
    tree.toggleNavigation(delegate);
    const nested = findNodeByStep(tree, 'nested');
    expect(nested.kind).toBe('navigation');
    if (nested.kind !== 'navigation') throw new Error('Expected nested navigation node');
    tree.toggleNavigation(nested);
    expect(findNodeByStep(tree, 'grandchild-review')).toBeDefined();
    expect(findNodeByStep(tree, 'child-v1-finish')).toBeDefined();
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(2);

    const rootFrame = inspectRootFrame(tree);
    const lastRootNode = tree.getVisibleNodes().findLast((node) => node.frame.workflow === root);
    if (lastRootNode === undefined) throw new Error('Missing root boundary node');
    expect(tree.handleKeyPress(lastRootNode.value, '\x1B[B')).toBe(true);

    expect(rootFrame.activeParallelWindows.size).toBe(0);
    expect([...rootFrame.nodeStates.keys()].some((key) => key.startsWith('parallel:0:'))).toBe(false);
    expectNodeStateKeysActive(rootFrame);
    delegateChild = childV2;

    const firstRootNode = tree.getVisibleNodes().find((node) => node.frame.workflow === root);
    if (firstRootNode === undefined) throw new Error('Missing root boundary node');
    expect(tree.handleKeyPress(firstRootNode.value, '\x1B[A')).toBe(true);
    const restoredParent = findNodeByStep(tree, 'reviewers');
    expect(tree.handleKeyPress(restoredParent.value, '\x1B[B')).toBe(true);
    const restoredDelegate = findNodeByStep(tree, 'delegate');
    expect(restoredDelegate.kind).toBe('navigation');
    if (restoredDelegate.kind !== 'navigation') throw new Error('Expected navigation node');
    tree.toggleNavigation(restoredDelegate);

    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(3);
    expect(findNodeByStep(tree, 'child-v2-review')).toBeDefined();
    expect(tree.getVisibleNodes().some((node) => node.step.name === 'child-v1-finish')).toBe(false);
    expect(tree.getVisibleNodes().some((node) => node.step.name === 'nested')).toBe(false);
    expect(tree.getVisibleNodes().some((node) => node.step.name === 'grandchild-review')).toBe(false);
    expectNodeStateKeysActive(rootFrame);
  });

  it('allows explicit scrolling to hide the target and restores it on reverse scrolling', () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('child-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        agentStep('resume'),
        ...Array.from({ length: 48 }, (_, index) => agentStep(`step-${index}`)),
        callStep('unrelated', 'child'),
        ...Array.from({ length: 50 }, (_, index) => agentStep(`later-${index}`)),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const tree = new TaskRetryRestartTree(
      root,
      pathContext,
      undefined,
      { resumeRestartPoint: rootRestartPoint('resume') },
    );
    const resumeValue = tree.getDefaultValue();
    const navigation = findNodeByStep(tree, 'unrelated');
    expect(navigation.kind).toBe('navigation');
    if (navigation.kind !== 'navigation') throw new Error('Expected navigation node');
    tree.toggleNavigation(navigation);
    const childLeaf = findNodeByStep(tree, 'child-review');

    expect(tree.handleKeyPress(childLeaf.value, '\x1B[B')).toBe(true);
    expect(tree.getVisibleNodes().some((node) => node.step.name === 'resume')).toBe(false);
    expect(tree.getDefaultValue()).not.toBe(resumeValue);

    const firstNode = tree.getVisibleNodes()[0];
    if (firstNode === undefined) throw new Error('Missing first scrolled node');
    expect(tree.handleKeyPress(firstNode.value, '\x1B[A')).toBe(true);
    const restoredResume = findNodeByStep(tree, 'resume');
    expect(restoredResume.kind).toBe('leaf');
    expect(restoredResume.kind === 'leaf' && restoredResume.isResumeCandidate).toBe(true);
    expect(tree.getDefaultValue()).toBe(restoredResume.value);
  });
});
