import {
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowRestartPointEntry,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../../core/models/index.js';
import { WorkflowRestartNavigator } from '../../core/workflow/engine/WorkflowRestartNavigator.js';
import {
  getWorkflowResumeFrameKind,
  getWorkflowStepKind,
  isWorkflowCallStep,
} from '../../core/workflow/step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { isWorkflowRestartTarget } from '../../core/workflow/workflow-restart-target.js';
import {
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
  workflowRestartEntryMatchesWorkflow,
} from '../../core/workflow/workflow-reference.js';
import { resolveWorkflowCallTarget } from '../../infra/config/index.js';

export interface TaskRetryStartPathContext {
  projectCwd: string;
  lookupCwd: string;
}

export interface ResolvedTaskRetryPath {
  restartPoint: WorkflowRestartPoint;
}

export const TASK_RETRY_START_WINDOW_SIZE = 50;

export type TaskRetryRestartTreeNode =
  | TaskRetryRestartTreeLeaf
  | TaskRetryRestartTreeNavigation;

export interface TaskRetryRestartTreeLeaf {
  kind: 'leaf';
  value: string;
  step: WorkflowStep;
  restartPoint: WorkflowRestartPoint;
  workflowPath: readonly string[];
  isRestartable: boolean;
  isDefaultCandidate: boolean;
  isResumeCandidate: boolean;
  frame: TaskRetryRestartTreeFrameState;
}

export interface TaskRetryRestartTreeNavigation {
  kind: 'navigation';
  value: string;
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>;
  restartPoint: WorkflowRestartPoint;
  workflowPath: readonly string[];
  expanded: boolean;
  frame: TaskRetryRestartTreeFrameState;
  key: string;
  parentStepIndex: number;
  parallelStepName?: string;
  parallelStepIndex?: number;
}

export interface TaskRetryRestartTreeFrame {
  readonly workflow: WorkflowConfig;
  readonly stack: readonly WorkflowRestartPointEntry[];
  readonly workflowPath: readonly string[];
  readonly ancestors: readonly string[];
}

interface ResolveTaskRetryStackOptions {
  allowParallelEntries: boolean;
  requireRestartTarget: boolean;
  requireRestartIdentity: boolean;
}

interface TaskRetryStartWindow {
  start: number;
  end: number;
}

type TaskRetryStartWindowChange = 'structural' | 'scroll';

function resolveCallableChild(
  parent: WorkflowConfig,
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  context: TaskRetryStartPathContext,
): WorkflowConfig {
  const child = resolveWorkflowCallTarget(
    parent,
    step,
    context.projectCwd,
    context.lookupCwd,
  );
  if (child === null) {
    throw new Error(
      `workflow_call step "${step.name}" in workflow "${parent.name}" references unknown workflow "${step.call}"`,
    );
  }
  if (child.subworkflow?.callable !== true) {
    throw new Error(`workflow "${child.name}" referenced by step "${step.name}" is not callable`);
  }
  return child;
}

function assertCallableChildBoundary(
  child: WorkflowConfig,
  ancestors: readonly string[],
): void {
  const childRef = getWorkflowReference(child);
  if (ancestors.includes(childRef)) {
    throw new Error(`Detected workflow_call cycle: ${[...ancestors, childRef].join(' -> ')}`);
  }
  if (ancestors.length + 1 > MAX_WORKFLOW_CALL_DEPTH) {
    throw new Error(
      `workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH}): ${child.name}`,
    );
  }
}

function createRestartEntry(
  workflow: WorkflowConfig,
  step: WorkflowStep,
): WorkflowRestartPointEntry {
  return buildWorkflowRestartPointEntry(
    workflow,
    step.name,
    getWorkflowStepKind(step),
    isWorkflowCallStep(step) ? 1 : undefined,
  );
}

function sameRestartPoint(
  left: WorkflowRestartPoint | undefined,
  right: WorkflowRestartPoint | undefined,
): boolean {
  if (left === undefined || right === undefined || left.stack.length !== right.stack.length) {
    return false;
  }
  return left.stack.every((leftEntry, index) => {
    const rightEntry = right.stack[index];
    return rightEntry !== undefined
      && leftEntry.workflow_ref === rightEntry.workflow_ref
      && leftEntry.step === rightEntry.step
      && leftEntry.kind === rightEntry.kind
      && leftEntry.call_instance === rightEntry.call_instance;
  });
}

function findFirstAuthoredRestartPoint(
  workflow: WorkflowConfig,
  stack: readonly WorkflowRestartPointEntry[],
): WorkflowRestartPoint | undefined {
  for (const step of workflow.steps) {
    if (!isWorkflowCallStep(step) && isWorkflowRestartTarget(step)) {
      return { stack: [...stack, createRestartEntry(workflow, step)] };
    }
  }
  return undefined;
}

function resolvePreferredRestartPoint(
  rootWorkflow: WorkflowConfig,
  context: TaskRetryStartPathContext,
  preferredRootStep: string,
): WorkflowRestartPoint | undefined {
  const rootStepIndex = rootWorkflow.steps.findIndex((step) => step.name === preferredRootStep);
  if (rootStepIndex < 0) {
    return findFirstAuthoredRestartPoint(rootWorkflow, []);
  }

  const findFrom = (
    workflow: WorkflowConfig,
    stack: readonly WorkflowRestartPointEntry[],
    ancestors: readonly string[],
    startIndex: number,
  ): WorkflowRestartPoint | undefined => {
    for (let index = startIndex; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index]!;
      const nextStack = [...stack, createRestartEntry(workflow, step)];
      if (isWorkflowCallStep(step)) {
        const child = resolveCallableChild(workflow, step, context);
        assertCallableChildBoundary(child, ancestors);
        return findFrom(
          child,
          nextStack,
          [...ancestors, getWorkflowReference(child)],
          child.steps.findIndex((candidate) => candidate.name === child.initialStep),
        );
      }
      if (isWorkflowRestartTarget(step)) {
        return { stack: nextStack };
      }
    }
    return undefined;
  };

  return findFrom(
    rootWorkflow,
    [],
    [getWorkflowReference(rootWorkflow)],
    rootStepIndex,
  ) ?? findFirstAuthoredRestartPoint(rootWorkflow, []);
}

type TaskRetryRestartTreeNodeUiState =
  | { readonly id: string; readonly expanded: false }
  | {
    readonly id: string;
    readonly expanded: true;
    readonly childFrame: TaskRetryRestartTreeFrameState;
  };

interface TaskRetryRestartTreeFrameState extends TaskRetryRestartTreeFrame {
  readonly parent?: TaskRetryRestartTreeFrameState;
  readonly parentStepIndex?: number;
  readonly parentParallelStepIndex?: number;
  activeStepWindow: TaskRetryStartWindow | undefined;
  readonly activeParallelWindows: Map<number, TaskRetryStartWindow>;
  readonly nodeStates: Map<string, TaskRetryRestartTreeNodeUiState>;
}

export interface TaskRetryRestartTreeOptions {
  defaultRestartPoint?: WorkflowRestartPoint;
  resumeRestartPoint?: WorkflowRestartPoint;
}

function matchesFrameStack(
  frameStack: readonly WorkflowRestartPointEntry[],
  targetStack: readonly WorkflowRestartPointEntry[],
): boolean {
  return frameStack.every((entry, index) => {
    const targetEntry = targetStack[index];
    return targetEntry !== undefined
      && entry.workflow_ref === targetEntry.workflow_ref
      && entry.step === targetEntry.step
      && entry.kind === targetEntry.kind
      && entry.call_instance === targetEntry.call_instance;
  });
}

export class TaskRetryRestartTree {
  private readonly rootFrame: TaskRetryRestartTreeFrameState;
  private readonly context: TaskRetryStartPathContext;
  private readonly defaultRestartPoint: WorkflowRestartPoint | undefined;
  private readonly resumeRestartPoint: WorkflowRestartPoint | undefined;
  private nextNodeId = 0;

  constructor(
    rootWorkflow: WorkflowConfig,
    context: TaskRetryStartPathContext,
    preferredRootStep: string | undefined,
    options: TaskRetryRestartTreeOptions,
  ) {
    this.context = context;
    this.defaultRestartPoint = options.defaultRestartPoint
      ?? resolvePreferredRestartPoint(rootWorkflow, context, preferredRootStep ?? rootWorkflow.initialStep);
    this.resumeRestartPoint = options.resumeRestartPoint;
    this.rootFrame = this.createFrame(
      rootWorkflow,
      [],
      [rootWorkflow.name],
      [getWorkflowReference(rootWorkflow)],
    );
    this.loadInitialWindow(this.rootFrame);
    if (this.resumeRestartPoint !== undefined) {
      this.ensureRestartPointVisible(this.resumeRestartPoint);
    } else if (this.defaultRestartPoint !== undefined) {
      this.ensureRestartPointVisible(this.defaultRestartPoint);
    }
  }

  getRootWorkflow(): WorkflowConfig {
    return this.rootFrame.workflow;
  }

  getVisibleNodes(): TaskRetryRestartTreeNode[] {
    return this.getVisibleNodesForFrame(this.rootFrame);
  }

  getDefaultValue(): string | undefined {
    const nodes = this.getVisibleNodes();
    const resume = nodes.find((node) => node.kind === 'leaf' && node.isResumeCandidate);
    if (resume !== undefined) return resume.value;
    const preferred = nodes.find((node) => node.kind === 'leaf' && node.isDefaultCandidate);
    if (preferred !== undefined) return preferred.value;
    const leaf = nodes.find((node) => node.kind === 'leaf');
    if (leaf !== undefined) return leaf.value;
    return nodes.find((node) => node.kind === 'navigation' && !node.expanded)?.value;
  }

  findNode(value: string): TaskRetryRestartTreeNode | undefined {
    return this.getVisibleNodes().find((node) => node.value === value);
  }

  handleKeyPress(
    value: string,
    key: string,
  ): boolean {
    const node = this.findNode(value);
    if (node === undefined) return false;
    if (node.kind === 'navigation' && (key === '\r' || key === '\n')) {
      this.toggleNavigation(node);
      return true;
    }
    if (this.isDownKey(key) && node.kind === 'leaf' && this.isStaticParallelCallStep(node.step)) {
      const stepIndex = node.frame.workflow.steps.indexOf(node.step);
      if (stepIndex >= 0 && this.loadParallelWindow(node.frame, stepIndex, 0, TASK_RETRY_START_WINDOW_SIZE, 'scroll')) {
        return true;
      }
    }
    if (this.isUpKey(key) && this.isFrameBoundary(node, 'up')) {
      const changed = this.loadAdjacentWindow(node, 'up');
      return changed;
    }
    if (this.isDownKey(key) && this.isFrameBoundary(node, 'down')) {
      const changed = this.loadAdjacentWindow(node, 'down');
      return changed;
    }
    return false;
  }

  private isFrameBoundary(
    node: TaskRetryRestartTreeNode,
    direction: 'up' | 'down',
  ): boolean {
    const nodes = this.getVisibleNodesForFrame(node.frame);
    const nodeIndex = nodes.findIndex((candidate) => candidate.value === node.value);
    if (nodeIndex < 0) return false;
    return direction === 'up'
      ? nodeIndex === 0
      : nodeIndex === nodes.length - 1;
  }

  isNavigation(value: string): boolean {
    return this.findNode(value)?.kind === 'navigation';
  }

  toggleNavigation(node: TaskRetryRestartTreeNavigation): void {
    if (node.expanded) {
      this.deleteNodeState(node.frame, node.key);
      return;
    }

    const child = this.resolveChildFrame(node);
    this.setExpandedNodeState(node.frame, node.key, child);
    const activeWindow = node.frame.activeStepWindow;
    const visibleNodes = this.getVisibleNodes();
    const childHasVisibleNode = this.getVisibleNodesForFrame(child).length > 0;
    const childIsProjected = visibleNodes.some((visibleNode) => visibleNode.frame === child);
    if (
      activeWindow !== undefined
      && activeWindow.end - activeWindow.start > 1
      && childHasVisibleNode
      && !childIsProjected
    ) {
      const windowSize = activeWindow.end - activeWindow.start - 1;
      this.loadWindow(node.frame, node.parentStepIndex - windowSize + 1, windowSize, 'structural');
    }
  }

  private createFrame(
    workflow: WorkflowConfig,
    stack: readonly WorkflowRestartPointEntry[],
    workflowPath: readonly string[],
    ancestors: readonly string[],
    parent?: TaskRetryRestartTreeFrameState,
    parentStepIndex?: number,
    parentParallelStepIndex?: number,
  ): TaskRetryRestartTreeFrameState {
    return {
      workflow,
      stack: [...stack],
      workflowPath: [...workflowPath],
      ancestors: [...ancestors],
      ...(parent === undefined ? {} : { parent }),
      ...(parentStepIndex === undefined ? {} : { parentStepIndex }),
      ...(parentParallelStepIndex === undefined ? {} : { parentParallelStepIndex }),
      activeStepWindow: undefined,
      activeParallelWindows: new Map<number, TaskRetryStartWindow>(),
      nodeStates: new Map<string, TaskRetryRestartTreeNodeUiState>(),
    };
  }

  private loadInitialWindow(frame: TaskRetryRestartTreeFrameState): void {
    const target = this.getTargetRestartPoint();
    const targetIndex = this.findTargetStepIndex(frame, target);
    const firstVisibleIndex = targetIndex ?? this.findFirstVisibleStepIndex(frame.workflow);
    if (firstVisibleIndex === undefined) return;
    const parallelStepIndex = targetIndex === undefined
      ? undefined
      : this.findTargetStaticParallelCallIndex(
        frame,
        target,
        0,
        frame.workflow.steps.length,
      );
    if (parallelStepIndex === undefined) {
      const nestedContentCount = target === undefined || targetIndex === undefined
        ? 0
        : Math.max(0, target.stack.length - frame.stack.length - 1);
      const windowSize = Math.max(
        1,
        TASK_RETRY_START_WINDOW_SIZE - nestedContentCount,
      );
      const windowStart = targetIndex === undefined
        ? Math.floor(firstVisibleIndex / TASK_RETRY_START_WINDOW_SIZE)
          * TASK_RETRY_START_WINDOW_SIZE
        : Math.max(0, firstVisibleIndex - windowSize + 1);
      this.loadWindow(frame, windowStart, windowSize, 'structural');
      return;
    }

    const nestedContentCount = target === undefined
      ? 0
      : Math.max(0, target.stack.length - frame.stack.length - 2);
    const topLevelSize = Math.max(
      1,
      TASK_RETRY_START_WINDOW_SIZE - 1 - nestedContentCount,
    );
    const windowStart = Math.max(0, parallelStepIndex - topLevelSize + 1);
    const targetParallelIndex = this.findTargetParallelStepIndex(
      frame,
      target,
      parallelStepIndex,
    );
    if (targetParallelIndex === undefined) {
      this.loadWindow(frame, windowStart, topLevelSize, 'structural');
      return;
    }
    this.loadWindow(frame, windowStart, topLevelSize, 'structural');
    this.loadParallelWindow(
      frame,
      parallelStepIndex,
      targetParallelIndex,
      Math.max(1, TASK_RETRY_START_WINDOW_SIZE - topLevelSize - nestedContentCount),
      'structural',
    );
  }

  private loadWindow(
    frame: TaskRetryRestartTreeFrameState,
    startIndex: number,
    windowSize: number,
    change: TaskRetryStartWindowChange,
  ): boolean {
    if (frame.workflow.steps.length === 0 || windowSize <= 0) return false;
    let normalizedStart = Math.max(
      0,
      Math.min(startIndex, frame.workflow.steps.length - 1),
    );
    let endIndex = Math.min(
      frame.workflow.steps.length,
      normalizedStart + windowSize,
    );
    const targetIndex = this.findTargetStepIndex(frame, this.getTargetRestartPoint());
    if (
      change === 'structural'
      && targetIndex !== undefined
      && this.isStepIndexActive(frame, targetIndex)
      && (targetIndex < normalizedStart || targetIndex >= endIndex)
    ) {
      normalizedStart = targetIndex < normalizedStart
        ? targetIndex
        : Math.max(0, targetIndex - windowSize + 1);
      endIndex = Math.min(frame.workflow.steps.length, normalizedStart + windowSize);
    }
    const previous = frame.activeStepWindow;
    const changed = previous?.start !== normalizedStart || previous.end !== endIndex;
    frame.activeStepWindow = { start: normalizedStart, end: endIndex };
    this.pruneFrameState(frame);
    return changed;
  }

  private loadParallelWindow(
    frame: TaskRetryRestartTreeFrameState,
    parentStepIndex: number,
    startIndex: number,
    windowSize: number,
    change: TaskRetryStartWindowChange,
  ): boolean {
    const parentStep = frame.workflow.steps[parentStepIndex];
    if (
      parentStep === undefined
      || parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
      || windowSize <= 0
    ) {
      return false;
    }

    if (parentStep.parallel.length === 0) return false;
    let normalizedStart = Math.max(
      0,
      Math.min(startIndex, parentStep.parallel.length - 1),
    );
    let endIndex = Math.min(
      parentStep.parallel.length,
      normalizedStart + windowSize,
    );
    const targetIndex = this.findTargetParallelStepIndex(
      frame,
      this.getTargetRestartPoint(),
      parentStepIndex,
    );
    const previous = frame.activeParallelWindows.get(parentStepIndex);
    if (
      change === 'structural'
      && targetIndex !== undefined
      && previous !== undefined
      && this.isParallelIndexActive(previous, targetIndex)
      && (targetIndex < normalizedStart || targetIndex >= endIndex)
    ) {
      normalizedStart = targetIndex < normalizedStart
        ? targetIndex
        : Math.max(0, targetIndex - windowSize + 1);
      endIndex = Math.min(parentStep.parallel.length, normalizedStart + windowSize);
    }
    const changed = previous?.start !== normalizedStart || previous.end !== endIndex;
    frame.activeParallelWindows.set(parentStepIndex, {
      start: normalizedStart,
      end: endIndex,
    });
    this.pruneFrameState(frame);
    return changed;
  }

  private pruneFrameState(frame: TaskRetryRestartTreeFrameState): void {
    for (const parentStepIndex of frame.activeParallelWindows.keys()) {
      if (!this.isStepIndexActive(frame, parentStepIndex)) {
        frame.activeParallelWindows.delete(parentStepIndex);
      }
    }

    for (const key of frame.nodeStates.keys()) {
      if (!this.isNodeKeyActive(frame, key)) this.deleteNodeState(frame, key);
    }
  }

  private deleteNodeState(frame: TaskRetryRestartTreeFrameState, key: string): void {
    frame.nodeStates.delete(key);
  }

  private isNodeKeyActive(frame: TaskRetryRestartTreeFrameState, key: string): boolean {
    if (this.isStepNodeKey(key)) {
      return this.isStepIndexActive(frame, this.getStepNodeIndex(key));
    }
    if (!key.startsWith('parallel:')) return false;
    const separatorIndex = key.indexOf(':', 'parallel:'.length);
    if (separatorIndex < 0) return false;
    const parentStepIndexText = key.slice('parallel:'.length, separatorIndex);
    const parallelStepIndexText = key.slice(separatorIndex + 1);
    if (parentStepIndexText.length === 0 || parallelStepIndexText.length === 0) return false;
    const parentStepIndex = Number(parentStepIndexText);
    const parallelStepIndex = Number(parallelStepIndexText);
    const window = frame.activeParallelWindows.get(parentStepIndex);
    return window !== undefined
      && this.isStepIndexActive(frame, parentStepIndex)
      && this.isParallelIndexActive(window, parallelStepIndex);
  }

  private isStepNodeKey(key: string): boolean {
    return key.startsWith('step:');
  }

  private getStepNodeIndex(key: string): number {
    return Number(key.slice('step:'.length));
  }

  private isStepIndexActive(frame: TaskRetryRestartTreeFrameState, index: number): boolean {
    const window = frame.activeStepWindow;
    return window !== undefined && index >= window.start && index < window.end;
  }

  private isParallelIndexActive(window: TaskRetryStartWindow, index: number): boolean {
    return index >= window.start && index < window.end;
  }

  private getTargetRestartPoint(): WorkflowRestartPoint | undefined {
    return this.resumeRestartPoint ?? this.defaultRestartPoint;
  }

  private findTargetStaticParallelCallIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
    startIndex: number,
    endIndex: number,
  ): number | undefined {
    for (let index = startIndex; index < endIndex; index += 1) {
      const step = frame.workflow.steps[index];
      if (step === undefined || !this.isStaticParallelCallStep(step)) continue;
      if (this.findTargetParallelStepIndex(frame, target, index) !== undefined) {
        return index;
      }
    }
    return undefined;
  }

  private findTargetParallelStepIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
    parentStepIndex: number,
  ): number | undefined {
    if (
      target === undefined
      || !matchesFrameStack(frame.stack, target.stack.slice(0, frame.stack.length))
    ) {
      return undefined;
    }
    const parentEntry = target.stack[frame.stack.length];
    const nextEntry = target.stack[frame.stack.length + 1];
    const parentStep = frame.workflow.steps[parentStepIndex];
    if (
      parentEntry === undefined
      || nextEntry === undefined
      || parentStep === undefined
      || parentStep.name !== parentEntry.step
      || parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
    ) {
      return undefined;
    }
    const index = parentStep.parallel.findIndex((subStep) => (
      subStep.name === nextEntry.step
      && getWorkflowStepKind(subStep) === nextEntry.kind
    ));
    return index < 0 ? undefined : index;
  }

  private findFirstVisibleStepIndex(workflow: WorkflowConfig): number | undefined {
    const index = workflow.steps.findIndex((step) => (
      isWorkflowCallStep(step) || isWorkflowRestartTarget(step)
    ));
    return index < 0 ? undefined : index;
  }

  private findTargetStepIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
  ): number | undefined {
    if (target === undefined || !matchesFrameStack(frame.stack, target.stack)) return undefined;
    const targetEntry = target.stack[frame.stack.length];
    if (targetEntry === undefined || targetEntry.workflow_ref !== getWorkflowReference(frame.workflow)) {
      return undefined;
    }
    const index = frame.workflow.steps.findIndex((step) => (
      step.name === targetEntry.step && getWorkflowStepKind(step) === targetEntry.kind
    ));
    return index < 0 ? undefined : index;
  }

  private getVisibleNodesForFrame(
    frame: TaskRetryRestartTreeFrameState,
    budget = TASK_RETRY_START_WINDOW_SIZE,
  ): TaskRetryRestartTreeNode[] {
    if (budget <= 0) return [];
    const nodes: TaskRetryRestartTreeNode[] = [];
    const stepWindow = frame.activeStepWindow;
    if (stepWindow === undefined) return nodes;
    const targetBranch = this.getTargetBranch(frame);
    const reserveExpandedBranches = this.getRequiredVisibleNodeCount(frame, true) <= budget;
    let remainingRequiredNodes = this.getRequiredVisibleNodeCount(
      frame,
      reserveExpandedBranches,
    );
    for (
      let stepIndex = stepWindow.start;
      stepIndex < stepWindow.end && nodes.length < budget;
      stepIndex += 1
    ) {
      const step = frame.workflow.steps[stepIndex];
      if (step === undefined) continue;
      const isTargetStep = targetBranch?.stepIndex === stepIndex;
      const requiredStepNodes = this.getRequiredVisibleNodeCountForStep(
        frame,
        stepIndex,
        targetBranch,
        reserveExpandedBranches,
      );
      if (
        requiredStepNodes === 0
        && nodes.length + 1 + remainingRequiredNodes > budget
      ) {
        continue;
      }
      const entry = createRestartEntry(frame.workflow, step);
      const restartPoint = { stack: [...frame.stack, entry] };
      if (isWorkflowCallStep(step)) {
        const key = `step:${stepIndex}`;
        const navigation = this.createNavigationNode(
          frame,
          key,
          step,
          restartPoint,
          frame.workflowPath,
          stepIndex,
        );
        nodes.push(navigation);
        if (requiredStepNodes > 0) remainingRequiredNodes -= 1;
        if (navigation.expanded) {
          const child = this.getExpandedChildFrame(frame, key);
          if (child !== undefined) {
            const requiredChildNodes = Math.max(0, requiredStepNodes - 1);
            const childBudget = budget - nodes.length
              - (remainingRequiredNodes - requiredChildNodes);
            nodes.push(...this.getVisibleNodesForFrame(child, childBudget));
            remainingRequiredNodes -= requiredChildNodes;
          }
        }
        continue;
      }

      const isResumeCandidate = sameRestartPoint(restartPoint, this.resumeRestartPoint);
      if (isWorkflowRestartTarget(step) || isResumeCandidate) {
        nodes.push({
          kind: 'leaf',
          value: this.getNodeValue(frame, `step:${stepIndex}`),
          step,
          restartPoint,
          workflowPath: frame.workflowPath,
          isRestartable: !this.isStaticParallelDescendant(frame)
            && isWorkflowRestartTarget(step),
          isDefaultCandidate: sameRestartPoint(restartPoint, this.defaultRestartPoint),
          isResumeCandidate,
          frame,
        });
        if (requiredStepNodes > 0) remainingRequiredNodes -= 1;
      }

      if (step.parallel !== undefined && !isDynamicParallelSubSteps(step.parallel)) {
        const parallelWindow = frame.activeParallelWindows.get(stepIndex);
        if (parallelWindow === undefined) continue;
        for (
          let subStepIndex = parallelWindow.start;
          subStepIndex < parallelWindow.end && nodes.length < budget;
          subStepIndex += 1
        ) {
          const subStep = step.parallel[subStepIndex];
          if (subStep === undefined) continue;
          if (!isWorkflowCallStep(subStep)) continue;
          const key = `parallel:${stepIndex}:${subStepIndex}`;
          const isTargetParallelStep = isTargetStep
            && targetBranch.parallelStepIndex === subStepIndex;
          const requiredParallelNodes = this.getRequiredVisibleNodeCountForParallelNode(
            frame,
            key,
            isTargetParallelStep,
            reserveExpandedBranches,
          );
          if (
            requiredParallelNodes === 0
            && nodes.length + 1 + remainingRequiredNodes > budget
          ) {
            continue;
          }
          const navigation = this.createNavigationNode(
            frame,
            key,
            subStep,
            { stack: [...restartPoint.stack, createRestartEntry(frame.workflow, subStep)] },
            [...frame.workflowPath, step.name],
            stepIndex,
            step.name,
            subStepIndex,
          );
          nodes.push(navigation);
          if (requiredParallelNodes > 0) remainingRequiredNodes -= 1;
          if (navigation.expanded) {
            const child = this.getExpandedChildFrame(frame, key);
            if (child !== undefined) {
              const requiredChildNodes = Math.max(0, requiredParallelNodes - 1);
              const childBudget = budget - nodes.length
                - (remainingRequiredNodes - requiredChildNodes);
              nodes.push(...this.getVisibleNodesForFrame(child, childBudget));
              remainingRequiredNodes -= requiredChildNodes;
            }
          }
        }
      }
    }
    return nodes;
  }

  private getTargetBranch(
    frame: TaskRetryRestartTreeFrameState,
  ): { stepIndex: number; parallelStepIndex?: number } | undefined {
    const target = this.getTargetRestartPoint();
    if (target === undefined || !matchesFrameStack(frame.stack, target.stack)) {
      return undefined;
    }
    const stepIndex = this.findTargetStepIndex(frame, target);
    if (stepIndex === undefined || !this.isStepIndexActive(frame, stepIndex)) {
      return undefined;
    }
    const parallelStepIndex = this.findTargetParallelStepIndex(frame, target, stepIndex);
    return parallelStepIndex === undefined
      ? { stepIndex }
      : { stepIndex, parallelStepIndex };
  }

  private getRequiredVisibleNodeCount(
    frame: TaskRetryRestartTreeFrameState,
    reserveExpandedBranches: boolean,
  ): number {
    const targetBranch = this.getTargetBranch(frame);
    const window = frame.activeStepWindow;
    if (window === undefined) return 0;
    let count = 0;
    for (let stepIndex = window.start; stepIndex < window.end; stepIndex += 1) {
      count += this.getRequiredVisibleNodeCountForStep(
        frame,
        stepIndex,
        targetBranch,
        reserveExpandedBranches,
      );
    }
    return count;
  }

  private getRequiredVisibleNodeCountForStep(
    frame: TaskRetryRestartTreeFrameState,
    stepIndex: number,
    targetBranch: { stepIndex: number; parallelStepIndex?: number } | undefined,
    reserveExpandedBranches: boolean,
  ): number {
    const step = frame.workflow.steps[stepIndex];
    if (step === undefined) return 0;
    const isTargetStep = targetBranch?.stepIndex === stepIndex;
    if (isWorkflowCallStep(step)) {
      const state = frame.nodeStates.get(`step:${stepIndex}`);
      if (!isTargetStep && (!reserveExpandedBranches || state?.expanded !== true)) return 0;
      return 1 + this.getRequiredExpandedChildNodeCount(
        state?.expanded === true ? state.childFrame : undefined,
        reserveExpandedBranches,
      );
    }

    let parallelNodeCount = 0;
    const parallelWindow = frame.activeParallelWindows.get(stepIndex);
    if (
      parallelWindow !== undefined
      && step.parallel !== undefined
      && !isDynamicParallelSubSteps(step.parallel)
    ) {
      for (
        let parallelStepIndex = parallelWindow.start;
        parallelStepIndex < parallelWindow.end;
        parallelStepIndex += 1
      ) {
        parallelNodeCount += this.getRequiredVisibleNodeCountForParallelNode(
          frame,
          `parallel:${stepIndex}:${parallelStepIndex}`,
          isTargetStep && targetBranch.parallelStepIndex === parallelStepIndex,
          reserveExpandedBranches,
        );
      }
    }
    return isTargetStep || parallelNodeCount > 0 ? 1 + parallelNodeCount : 0;
  }

  private getRequiredVisibleNodeCountForParallelNode(
    frame: TaskRetryRestartTreeFrameState,
    key: string,
    isTarget: boolean,
    reserveExpandedBranches: boolean,
  ): number {
    const state = frame.nodeStates.get(key);
    if (!isTarget && (!reserveExpandedBranches || state?.expanded !== true)) return 0;
    return 1 + this.getRequiredExpandedChildNodeCount(
      state?.expanded === true ? state.childFrame : undefined,
      reserveExpandedBranches,
    );
  }

  private getRequiredExpandedChildNodeCount(
    childFrame: TaskRetryRestartTreeFrameState | undefined,
    reserveExpandedBranches: boolean,
  ): number {
    return childFrame === undefined
      ? 0
      : Math.max(1, this.getRequiredVisibleNodeCount(childFrame, reserveExpandedBranches));
  }

  private isStaticParallelCallStep(step: WorkflowStep): boolean {
    return step.parallel !== undefined
      && !isDynamicParallelSubSteps(step.parallel)
      && step.parallel.some((subStep) => isWorkflowCallStep(subStep));
  }

  private isStaticParallelDescendant(frame: TaskRetryRestartTreeFrameState): boolean {
    let current: TaskRetryRestartTreeFrameState | undefined = frame;
    while (current?.parent !== undefined) {
      if (current.parentParallelStepIndex !== undefined) return true;
      current = current.parent;
    }
    return false;
  }

  private createNavigationNode(
    frame: TaskRetryRestartTreeFrameState,
    key: string,
    step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
    restartPoint: WorkflowRestartPoint,
    workflowPath: readonly string[],
    parentStepIndex: number,
    parallelStepName?: string,
    parallelStepIndex?: number,
  ): TaskRetryRestartTreeNavigation {
    return {
      kind: 'navigation',
      value: this.getNodeValue(frame, key),
      step,
      restartPoint,
      workflowPath: [...workflowPath],
      expanded: frame.nodeStates.get(key)?.expanded === true,
      frame,
      key,
      parentStepIndex,
      ...(parallelStepName === undefined ? {} : { parallelStepName }),
      ...(parallelStepIndex === undefined ? {} : { parallelStepIndex }),
    };
  }

  private getNodeValue(frame: TaskRetryRestartTreeFrameState, key: string): string {
    const existing = frame.nodeStates.get(key);
    if (existing !== undefined) return existing.id;
    const value = `retry-tree-${this.nextNodeId}`;
    this.nextNodeId += 1;
    frame.nodeStates.set(key, { id: value, expanded: false });
    return value;
  }

  private setExpandedNodeState(
    frame: TaskRetryRestartTreeFrameState,
    key: string,
    childFrame: TaskRetryRestartTreeFrameState,
  ): void {
    const id = this.getNodeValue(frame, key);
    frame.nodeStates.set(key, { id, expanded: true, childFrame });
  }

  private getExpandedChildFrame(
    frame: TaskRetryRestartTreeFrameState,
    key: string,
  ): TaskRetryRestartTreeFrameState | undefined {
    const state = frame.nodeStates.get(key);
    return state?.expanded === true ? state.childFrame : undefined;
  }

  private resolveChildFrame(node: TaskRetryRestartTreeNavigation): TaskRetryRestartTreeFrameState {
    const existing = this.getExpandedChildFrame(node.frame, node.key);
    if (existing !== undefined) return existing;
    const child = resolveCallableChild(node.frame.workflow, node.step, this.context);
    assertCallableChildBoundary(child, node.frame.ancestors);
    const workflowPath = node.parallelStepName === undefined
      ? [...node.frame.workflowPath, node.step.name, child.name]
      : [...node.workflowPath, node.step.name, child.name];
    const childFrame = this.createFrame(
      child,
      node.restartPoint.stack,
      workflowPath,
      [...node.frame.ancestors, getWorkflowReference(child)],
      node.frame,
      node.parentStepIndex,
      node.parallelStepIndex,
    );
    this.loadInitialWindow(childFrame);
    return childFrame;
  }

  private ensureRestartPointVisible(target: WorkflowRestartPoint): void {
    let frame = this.rootFrame;
    let index = 0;
    while (index < target.stack.length) {
      const entry = target.stack[index]!;
      if (!matchesFrameStack(frame.stack, target.stack.slice(0, frame.stack.length))) {
        return;
      }
      const stepIndex = frame.workflow.steps.findIndex((step) => (
        step.name === entry.step && getWorkflowStepKind(step) === entry.kind
      ));
      if (stepIndex < 0) return;
      if (!this.isStepIndexActive(frame, stepIndex)) {
        const nestedContentCount = Math.max(0, target.stack.length - frame.stack.length - 1);
        const windowSize = Math.max(
          1,
          TASK_RETRY_START_WINDOW_SIZE - nestedContentCount,
        );
        this.loadWindow(frame, stepIndex - windowSize + 1, windowSize, 'structural');
      }
      const step = frame.workflow.steps[stepIndex]!;
      if (isWorkflowCallStep(step)) {
        const node = this.createNavigationNode(
          frame,
          `step:${stepIndex}`,
          step,
          { stack: [...frame.stack, createRestartEntry(frame.workflow, step)] },
          frame.workflowPath,
          stepIndex,
        );
        const child = this.resolveChildFrame(node);
        this.setExpandedNodeState(frame, node.key, child);
        frame = child;
        index += 1;
        continue;
      }
      if (index === target.stack.length - 1) return;
      const nextEntry = target.stack[index + 1]!;
      if (step.parallel === undefined || isDynamicParallelSubSteps(step.parallel)) return;
      const subStepIndex = step.parallel.findIndex((subStep) => (
        subStep.name === nextEntry.step && getWorkflowStepKind(subStep) === nextEntry.kind
      ));
      const subStep = subStepIndex < 0 ? undefined : step.parallel[subStepIndex];
      if (subStep === undefined || !isWorkflowCallStep(subStep)) return;
      const key = `parallel:${stepIndex}:${subStepIndex}`;
      this.loadParallelWindow(frame, stepIndex, subStepIndex, 1, 'structural');
      const node = this.createNavigationNode(
        frame,
        key,
        subStep,
        { stack: [...frame.stack, createRestartEntry(frame.workflow, step), createRestartEntry(frame.workflow, subStep)] },
        [...frame.workflowPath, step.name],
        stepIndex,
        step.name,
        subStepIndex,
      );
      const child = this.resolveChildFrame(node);
      this.setExpandedNodeState(frame, key, child);
      frame = child;
      index += 2;
    }
  }

  private loadAdjacentWindow(
    node: TaskRetryRestartTreeNode,
    direction: 'up' | 'down',
  ): boolean {
    if (node.kind === 'navigation' && node.parallelStepIndex !== undefined) {
      const changed = this.loadAdjacentParallelWindow(
        node.frame,
        node.parentStepIndex,
        node.parallelStepIndex,
        direction,
      );
      if (changed) return true;
    }

    if (
      node.kind === 'leaf'
      && direction === 'down'
      && this.isStaticParallelCallStep(node.step)
    ) {
      const stepIndex = node.frame.workflow.steps.indexOf(node.step);
      if (stepIndex >= 0 && this.loadParallelWindow(
        node.frame,
        stepIndex,
        0,
        TASK_RETRY_START_WINDOW_SIZE,
        'scroll',
      )) {
        return true;
      }
    }

    let frame: TaskRetryRestartTreeFrameState | undefined = node.frame;
    let currentStepIndex = node.kind === 'navigation'
      ? node.parentStepIndex
      : frame.workflow.steps.indexOf(node.step);
    while (frame !== undefined) {
      const window = frame.activeStepWindow;
      if (window !== undefined && currentStepIndex >= 0) {
        const windowSize = Math.max(1, window.end - window.start);
        const changed = direction === 'up'
          ? currentStepIndex > 0
            && this.loadWindow(frame, currentStepIndex - windowSize + 1, windowSize, 'scroll')
          : currentStepIndex + 1 < frame.workflow.steps.length
            && this.loadWindow(frame, currentStepIndex, windowSize, 'scroll');
        if (changed) return true;
      }

      const parent: TaskRetryRestartTreeFrameState | undefined = frame.parent;
      if (parent === undefined || frame.parentStepIndex === undefined) return false;
      const parentStepIndex = frame.parentStepIndex;
      if (frame.parentParallelStepIndex !== undefined) {
        const changed = this.loadAdjacentParallelWindow(
          parent,
          parentStepIndex,
          frame.parentParallelStepIndex,
          direction,
        );
        if (changed) return true;
      }
      frame = parent;
      currentStepIndex = parentStepIndex;
    }
    return false;
  }

  private loadAdjacentParallelWindow(
    frame: TaskRetryRestartTreeFrameState,
    parentStepIndex: number,
    currentIndex: number,
    direction: 'up' | 'down',
  ): boolean {
    const window = frame.activeParallelWindows.get(parentStepIndex);
    if (window === undefined) {
      return direction === 'down' && this.loadParallelWindow(
        frame,
        parentStepIndex,
        0,
        TASK_RETRY_START_WINDOW_SIZE,
        'scroll',
      );
    }

    const windowSize = Math.max(1, window.end - window.start);
    const adjacentIndex = direction === 'up'
      ? currentIndex - windowSize + 1
      : currentIndex;
    return direction === 'up'
      ? currentIndex > 0
        && this.loadParallelWindow(frame, parentStepIndex, adjacentIndex, windowSize, 'scroll')
      : (() => {
        const parentStep = frame.workflow.steps[parentStepIndex];
        const parallel = parentStep?.parallel;
        return parallel !== undefined
          && !isDynamicParallelSubSteps(parallel)
          && currentIndex + 1 < parallel.length
          && this.loadParallelWindow(frame, parentStepIndex, adjacentIndex, windowSize, 'scroll');
      })();
  }

  private isUpKey(key: string): boolean {
    return key === '\x1B[A' || key === '\x1BOA' || key === 'k';
  }

  private isDownKey(key: string): boolean {
    return key === '\x1B[B' || key === '\x1BOB' || key === 'j';
  }
}

function resolveTaskRetryStackPathWithOptions(
  rootWorkflow: WorkflowConfig,
  stack: readonly (WorkflowResumePointEntry | WorkflowRestartPointEntry)[],
  context: TaskRetryStartPathContext,
  options: ResolveTaskRetryStackOptions,
): ResolvedTaskRetryPath | undefined {
  let workflow = rootWorkflow;
  let steps = rootWorkflow.steps;
  const ancestors = [getWorkflowReference(rootWorkflow)];
  let restartStack: WorkflowRestartPointEntry[] = [];

  const resolveInitialRestartLeaf = (
    initialWorkflow: WorkflowConfig,
    initialAncestors: readonly string[],
    initialStack: readonly WorkflowRestartPointEntry[],
  ): ResolvedTaskRetryPath => {
    let workflowToVisit = initialWorkflow;
    let ancestorsToVisit = [...initialAncestors];
    const resolvedStack = [...initialStack];

    while (true) {
      const initialStep = workflowToVisit.steps.find(
        (candidate) => candidate.name === workflowToVisit.initialStep,
      );
      if (initialStep === undefined) {
        throw new Error(
          `Workflow "${workflowToVisit.name}" initial step "${workflowToVisit.initialStep}" cannot be resolved`,
        );
      }

      resolvedStack.push(createRestartEntry(workflowToVisit, initialStep));
      if (!isWorkflowCallStep(initialStep)) {
        return {
          restartPoint: { stack: resolvedStack },
        };
      }

      const child = resolveCallableChild(workflowToVisit, initialStep, context);
      assertCallableChildBoundary(child, ancestorsToVisit);
      ancestorsToVisit = [...ancestorsToVisit, getWorkflowReference(child)];
      workflowToVisit = child;
    }
  };

  for (let index = 0; index < stack.length; index += 1) {
    const entry = stack[index]!;
    const entryMatchesWorkflow = options.requireRestartIdentity
      ? workflowRestartEntryMatchesWorkflow(entry as WorkflowRestartPointEntry, workflow)
      : workflowEntryMatchesWorkflow(entry as WorkflowResumePointEntry, workflow);
    if (!entryMatchesWorkflow) {
      return undefined;
    }
    const step = steps.find((candidate) => candidate.name === entry.step);
    if (step === undefined) {
      return undefined;
    }
    const expectedKind = options.requireRestartIdentity
      ? getWorkflowStepKind(step)
      : getWorkflowResumeFrameKind(step);
    if (expectedKind !== entry.kind) {
      return undefined;
    }
    const nextRestartStack = [...restartStack, createRestartEntry(workflow, step)];
    const isTerminalEntry = index === stack.length - 1;
    if (isTerminalEntry && options.requireRestartTarget && !isWorkflowRestartTarget(step)) {
      return undefined;
    }
    if (isWorkflowCallStep(step)) {
      const child = resolveCallableChild(workflow, step, context);
      assertCallableChildBoundary(child, ancestors);
      if (isTerminalEntry) {
        if (options.requireRestartIdentity) {
          return { restartPoint: { stack: nextRestartStack } };
        }
        return resolveInitialRestartLeaf(
          child,
          [...ancestors, getWorkflowReference(child)],
          nextRestartStack,
        );
      }
      workflow = child;
      steps = child.steps;
      restartStack = nextRestartStack;
      ancestors.push(getWorkflowReference(child));
      continue;
    }
    if (isTerminalEntry) {
      return { restartPoint: { stack: nextRestartStack } };
    }
    if (
      !options.allowParallelEntries
      || step.parallel === undefined
      || isDynamicParallelSubSteps(step.parallel)
    ) {
      return undefined;
    }
    restartStack = nextRestartStack;
    steps = step.parallel;
  }
  return undefined;
}

export function resolveTaskRetryStackPath(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowResumePointEntry[],
  context: TaskRetryStartPathContext,
  allowParallelEntries: boolean,
): ResolvedTaskRetryPath | undefined {
  return resolveTaskRetryStackPathWithOptions(rootWorkflow, stack, context, {
    allowParallelEntries,
    requireRestartTarget: false,
    requireRestartIdentity: false,
  });
}

export function validateTaskRetryRestartPoint(
  rootWorkflow: WorkflowConfig,
  restartPoint: WorkflowRestartPoint,
  context: TaskRetryStartPathContext,
): void {
  new WorkflowRestartNavigator(restartPoint).resolveRootStartStep(rootWorkflow, undefined);
  const resolved = resolveTaskRetryStackPathWithOptions(rootWorkflow, restartPoint.stack, context, {
    allowParallelEntries: false,
    requireRestartTarget: true,
    requireRestartIdentity: true,
  });
  if (resolved !== undefined) {
    return;
  }
  const terminalStep = restartPoint.stack.at(-1)?.step;
  throw new Error(
    `Task retry restart path cannot be resolved${terminalStep ? ` at step "${terminalStep}"` : ''}`,
  );
}
