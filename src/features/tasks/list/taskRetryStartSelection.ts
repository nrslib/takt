import {
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowResumePoint,
} from '../../../core/models/index.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { isWorkflowRestartTarget } from '../../../core/workflow/workflow-restart-target.js';
import type { SelectOptionItem } from '../../../shared/prompt/index.js';
import {
  formatTaskRetryPath,
  resolveTaskRetryStackPath,
  TASK_RETRY_START_PAGE_SIZE,
  TaskRetryRestartBrowser,
  type TaskRetryRestartLevel,
  type TaskRetryRestartPage,
  type TaskRetryRestartPageItem,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';

const RESUME_SELECTION_VALUE = 'resume-checkpoint';
const RESTART_SELECTION_VALUE_PREFIX = 'restart-step-';
const OPEN_CHILD_SELECTION_VALUE_PREFIX = 'open-child-';
const PREVIOUS_PAGE_VALUE = 'previous-page';
const NEXT_PAGE_VALUE = 'next-page';
const PARENT_LEVEL_VALUE = 'parent-level';
const RESUME_LABEL_PREFIX = 'Resume failed position: ';
const RESTART_LABEL_PREFIX = 'Restart from: ';
const OPEN_CHILD_LABEL_PREFIX = 'Browse child workflow from: ';

export type TaskRetryStartSelection =
  | { kind: 'resume'; resumePoint: WorkflowResumePoint }
  | { kind: 'restart'; restartPoint: WorkflowRestartPoint };

export interface TaskRetryStartSelectionResult {
  label: string;
  selection: TaskRetryStartSelection;
}

export type TaskRetryStartOptionSelector = (
  message: string,
  options: SelectOptionItem<string>[],
  defaultValue: string,
) => Promise<string | null>;

interface SelectTaskRetryStartOptions extends TaskRetryStartPathContext {
  resumePoint?: WorkflowResumePoint;
  preferredRootStep?: string;
}

type BrowserAction =
  | { kind: 'resume'; value: string; label: string; resumePoint: WorkflowResumePoint }
  | { kind: 'restart'; value: string; label: string; restartPoint: WorkflowRestartPoint }
  | { kind: 'open_child'; value: string; item: TaskRetryRestartPageItem }
  | { kind: 'previous_page'; value: string; startIndex: number }
  | { kind: 'next_page'; value: string; startIndex: number }
  | { kind: 'parent_level'; value: string };

interface BrowserFrame {
  level: TaskRetryRestartLevel;
  startIndex: number;
}

function findInitialPageStart(
  level: TaskRetryRestartLevel,
  preferredStep: string | undefined,
): number | undefined {
  const preferredIndex = preferredStep === undefined
    ? -1
    : level.workflow.steps.findIndex((step) => (
      step.name === preferredStep && isWorkflowRestartTarget(step)
    ));
  const firstRestartIndex = preferredIndex >= 0
    ? preferredIndex
    : level.workflow.steps.findIndex(isWorkflowRestartTarget);
  return firstRestartIndex < 0
    ? undefined
    : Math.floor(firstRestartIndex / TASK_RETRY_START_PAGE_SIZE) * TASK_RETRY_START_PAGE_SIZE;
}

function requireInitialPageStart(
  level: TaskRetryRestartLevel,
  preferredStep: string | undefined,
): number {
  const startIndex = findInitialPageStart(level, preferredStep);
  if (startIndex === undefined) {
    throw new Error(`Workflow "${level.workflow.name}" has no authored steps to restart from`);
  }
  return startIndex;
}

function createResumeAction(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): BrowserAction | undefined {
  if (options.resumePoint === undefined) {
    return undefined;
  }
  const resolved = resolveTaskRetryStackPath(
    rootWorkflow,
    options.resumePoint.stack,
    options,
    true,
  );
  if (resolved === undefined) {
    return undefined;
  }
  return {
    kind: 'resume',
    value: RESUME_SELECTION_VALUE,
    label: `${RESUME_LABEL_PREFIX}${formatTaskRetryPath(resolved.segments)} [default]`,
    resumePoint: options.resumePoint,
  };
}

function createPageActions(
  page: TaskRetryRestartPage,
  includeParent: boolean,
): BrowserAction[] {
  const actions: BrowserAction[] = [];
  for (const item of page.items) {
    const path = formatTaskRetryPath(item.segments);
    actions.push({
      kind: 'restart',
      value: `${RESTART_SELECTION_VALUE_PREFIX}${item.stepIndex}`,
      label: `${RESTART_LABEL_PREFIX}${path}`,
      restartPoint: item.restartPoint,
    });
    if (isWorkflowCallStep(item.step)) {
      actions.push({
        kind: 'open_child',
        value: `${OPEN_CHILD_SELECTION_VALUE_PREFIX}${item.stepIndex}`,
        item,
      });
    }
  }
  if (page.previousStartIndex !== undefined) {
    actions.push({
      kind: 'previous_page',
      value: PREVIOUS_PAGE_VALUE,
      startIndex: page.previousStartIndex,
    });
  }
  if (page.nextStartIndex !== undefined) {
    actions.push({
      kind: 'next_page',
      value: NEXT_PAGE_VALUE,
      startIndex: page.nextStartIndex,
    });
  }
  if (includeParent) {
    actions.push({ kind: 'parent_level', value: PARENT_LEVEL_VALUE });
  }
  return actions;
}

function getActionLabel(action: BrowserAction, page: TaskRetryRestartPage): string {
  switch (action.kind) {
    case 'resume':
    case 'restart':
      return action.label;
    case 'open_child':
      return `${OPEN_CHILD_LABEL_PREFIX}${formatTaskRetryPath(action.item.segments)}`;
    case 'previous_page':
      return `Previous page (${page.pageNumber - 1}/${page.pageCount})`;
    case 'next_page':
      return `Next page (${page.pageNumber + 1}/${page.pageCount})`;
    case 'parent_level':
      return 'Back to parent workflow';
  }
}

function getDefaultValue(
  actions: BrowserAction[],
  resumeAction: BrowserAction | undefined,
  preferredStep: string | undefined,
): string {
  if (resumeAction?.kind === 'resume') {
    return resumeAction.value;
  }
  const preferred = actions.find((action) => (
    action.kind === 'restart'
    && action.restartPoint.stack.at(-1)?.step === preferredStep
  ));
  return preferred?.value ?? actions[0]!.value;
}

async function selectResumeOnly(
  level: TaskRetryRestartLevel,
  resumeAction: Extract<BrowserAction, { kind: 'resume' }>,
  selectOption: TaskRetryStartOptionSelector,
): Promise<TaskRetryStartSelectionResult | null> {
  const selectedValue = await selectOption(
    `Start position — ${formatTaskRetryPath(level.segments)}:`,
    [{ label: resumeAction.label, value: resumeAction.value }],
    resumeAction.value,
  );
  if (selectedValue === null) {
    return null;
  }
  if (selectedValue !== resumeAction.value) {
    throw new Error(`Unknown task retry start selection: ${selectedValue}`);
  }
  return {
    label: resumeAction.label,
    selection: { kind: 'resume', resumePoint: resumeAction.resumePoint },
  };
}

export async function selectTaskRetryStart(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
  selectOption: TaskRetryStartOptionSelector,
): Promise<TaskRetryStartSelectionResult | null> {
  const browser = new TaskRetryRestartBrowser(options);
  const rootLevel = browser.createRootLevel(rootWorkflow);
  const resumeAction = createResumeAction(rootWorkflow, options);
  const rootStartIndex = findInitialPageStart(rootLevel, options.preferredRootStep);
  if (rootStartIndex === undefined) {
    if (resumeAction?.kind !== 'resume') {
      throw new Error(`Workflow "${rootWorkflow.name}" has no authored steps to restart from`);
    }
    return selectResumeOnly(rootLevel, resumeAction, selectOption);
  }
  const frames: BrowserFrame[] = [{
    level: rootLevel,
    startIndex: rootStartIndex,
  }];

  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const page = browser.getPage(frame.level, frame.startIndex);
    const pageActions = createPageActions(page, frames.length > 1);
    const actions = frames.length === 1 && resumeAction !== undefined
      ? [resumeAction, ...pageActions]
      : pageActions;
    if (actions.length === 0) {
      throw new Error(`Workflow "${frame.level.workflow.name}" has no selectable retry positions`);
    }
    const promptOptions = actions.map((action): SelectOptionItem<string> => ({
      label: getActionLabel(action, page),
      value: action.value,
      ...(action.kind === 'restart'
        && action.restartPoint.stack.length === 1
        && action.restartPoint.stack[0]?.step === rootWorkflow.initialStep
        ? { description: 'Initial step' }
        : {}),
    }));
    const selectedValue = await selectOption(
      `Start position — ${formatTaskRetryPath(frame.level.segments)} (page ${page.pageNumber}/${page.pageCount}):`,
      promptOptions,
      getDefaultValue(actions, frames.length === 1 ? resumeAction : undefined, options.preferredRootStep),
    );
    if (selectedValue === null) {
      return null;
    }
    const action = actions.find((candidate) => candidate.value === selectedValue);
    if (action === undefined) {
      throw new Error(`Unknown task retry start selection: ${selectedValue}`);
    }
    switch (action.kind) {
      case 'resume':
        return { label: action.label, selection: { kind: 'resume', resumePoint: action.resumePoint } };
      case 'restart':
        return { label: action.label, selection: { kind: 'restart', restartPoint: action.restartPoint } };
      case 'open_child': {
        const childLevel = browser.openChild(frame.level, action.item);
        frames.push({
          level: childLevel,
          startIndex: requireInitialPageStart(childLevel, childLevel.workflow.initialStep),
        });
        break;
      }
      case 'previous_page':
      case 'next_page':
        frame.startIndex = action.startIndex;
        break;
      case 'parent_level':
        frames.pop();
        break;
    }
  }
  throw new Error('Task retry start browser exited without a selection');
}
