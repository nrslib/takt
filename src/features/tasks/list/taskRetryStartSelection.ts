import {
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowResumePoint,
} from '../../../core/models/index.js';
import type { SelectOptionItem } from '../../../shared/prompt/index.js';
import { warn } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import {
  buildTaskRetryRestartTree,
  formatTaskRetryPath,
  resolveTaskRetryStackPath,
  type TaskRetryRestartTreeNode,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';

const RESUME_SELECTION_VALUE = 'resume-checkpoint';
const RESTART_VALUE_PREFIX = 'restart:';
const HEADING_VALUE_PREFIX = 'heading:';
const RESUME_LABEL_PREFIX = 'Resume failed position: ';
const TREE_INDENT = '  ';
const log = createLogger('task-retry-start');

export class InvalidTaskRetryResumeWithoutRestartError extends Error {
  constructor(reason: string) {
    super(`${reason}. Saved resume information cannot be carried forward. No restart positions are available; retry cancelled.`);
    this.name = 'InvalidTaskRetryResumeWithoutRestartError';
  }
}

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

export interface SelectTaskRetryStartOptions extends TaskRetryStartPathContext {
  resumePoint?: WorkflowResumePoint;
  preferredRootStep?: string;
}

/** Public, opaque choices shared by CLI and Web UI. */
export interface TaskRetryStartOption {
  readonly id: string;
  readonly label: string;
  readonly selectable: boolean;
  readonly description?: string;
}

export interface TaskRetryStartOptionsModel {
  readonly options: readonly TaskRetryStartOption[];
  readonly defaultId: string;
  readonly resumeFailureReason?: string;
}

/** Engine-owned retry fields derived from one opaque start selection. */
export interface TaskRetryStartOwnership {
  readonly startStep?: string;
  readonly resumePoint?: WorkflowResumePoint;
  readonly restartPoint?: WorkflowRestartPoint;
}

/** Resolve retry start ownership consistently for CLI and central Web UI runs. */
export function resolveTaskRetryStartOwnership(
  selectedStart: TaskRetryStartSelection,
  workflowConfig: Pick<WorkflowConfig, 'initialStep'>,
): TaskRetryStartOwnership {
  if (selectedStart.kind === 'resume') {
    const rootEntry = selectedStart.resumePoint.stack[0]!;
    return {
      ...(rootEntry.step === workflowConfig.initialStep ? {} : { startStep: rootEntry.step }),
      resumePoint: selectedStart.resumePoint,
    };
  }
  return { restartPoint: selectedStart.restartPoint };
}

interface ResumeOption {
  value: string;
  label: string;
  description: string;
  selection: Extract<TaskRetryStartSelection, { kind: 'resume' }>;
}

function createResumeOption(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): ResumeOption | { reason: string } | undefined {
  if (options.resumePoint === undefined) {
    return undefined;
  }
  let stack = options.resumePoint.stack;
  const resolve = (): ReturnType<typeof resolveTaskRetryStackPath> => {
    try {
      return resolveTaskRetryStackPath(rootWorkflow, stack, options);
    } catch (error) {
      const reason = getErrorMessage(error);
      log.debug('Failed to resolve saved task retry Resume path', { error: reason });
      return { reason };
    }
  };
  let resolved = resolve();
  if ('reason' in resolved) {
    const failure = resolved;
    while (stack.length > 1 && 'reason' in resolved) {
      stack = stack.slice(0, -1);
      resolved = resolve();
    }
    if ('reason' in resolved) {
      return failure;
    }
  }
  return {
    value: RESUME_SELECTION_VALUE,
    label: `${RESUME_LABEL_PREFIX}${formatTaskRetryPath([stack.at(-1)!.step])}`,
    description: formatTaskRetryPath(resolved.segments),
    selection: { kind: 'resume', resumePoint: { ...options.resumePoint, stack } },
  };
}

interface FlattenedTree {
  promptOptions: SelectOptionItem<string>[];
  selections: Map<string, TaskRetryStartSelection>;
  /** Value -> concise (unindented) label used for the confirmation log. */
  resultLabels: Map<string, string>;
  firstLeafValue: string | undefined;
  preferredLeafValue: string | undefined;
}

interface TaskRetryStartCatalog extends TaskRetryStartOptionsModel {
  readonly selections: ReadonlyMap<string, TaskRetryStartSelection>;
  readonly resultLabels: ReadonlyMap<string, string>;
}

function flattenRestartTree(
  tree: TaskRetryRestartTreeNode[],
  preferredRootStep: string | undefined,
): FlattenedTree {
  const promptOptions: SelectOptionItem<string>[] = [];
  const selections = new Map<string, TaskRetryStartSelection>();
  const resultLabels = new Map<string, string>();
  let firstLeafValue: string | undefined;
  let preferredLeafValue: string | undefined;

  const visit = (nodes: TaskRetryRestartTreeNode[], rootStepName: string | undefined): void => {
    for (const node of nodes) {
      const indent = TREE_INDENT.repeat(node.depth);
      // The authored step name is serialized so control characters stay
      // terminal-safe and visually similar names remain distinguishable.
      const stepLabel = formatTaskRetryPath([node.step.name]);
      const currentRoot = node.depth === 0 ? node.step.name : rootStepName;
      if (node.kind === 'heading') {
        promptOptions.push({
          label: `${indent}${stepLabel}:`,
          value: `${HEADING_VALUE_PREFIX}${node.id}`,
          selectable: false,
          ...(node.note === undefined ? {} : { description: node.note }),
        });
        visit(node.children, currentRoot);
        continue;
      }
      const value = `${RESTART_VALUE_PREFIX}${node.id}`;
      promptOptions.push({ label: `${indent}${stepLabel}`, value });
      selections.set(value, { kind: 'restart', restartPoint: node.restartPoint });
      resultLabels.set(value, stepLabel);
      if (firstLeafValue === undefined) {
        firstLeafValue = value;
      }
      // Default to the first authored leaf that lives under the failed
      // root-level step (the step itself for a root leaf, or the first leaf
      // inside a failed workflow_call).
      if (
        preferredLeafValue === undefined
        && preferredRootStep !== undefined
        && currentRoot === preferredRootStep
      ) {
        preferredLeafValue = value;
      }
    }
  };
  visit(tree, undefined);

  return { promptOptions, selections, resultLabels, firstLeafValue, preferredLeafValue };
}

function buildTaskRetryStartCatalog(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): TaskRetryStartCatalog {
  const tree = buildTaskRetryRestartTree(rootWorkflow, options);
  const flattened = flattenRestartTree(tree, options.preferredRootStep);
  const resumeResolution = createResumeOption(rootWorkflow, options);
  const resumeOption = resumeResolution !== undefined && 'selection' in resumeResolution
    ? resumeResolution
    : undefined;
  const defaultId = resumeOption?.value
    ?? flattened.preferredLeafValue
    ?? flattened.firstLeafValue;
  if (defaultId === undefined) {
    if (resumeResolution !== undefined && 'reason' in resumeResolution) {
      throw new InvalidTaskRetryResumeWithoutRestartError(resumeResolution.reason);
    }
    throw new Error(`Workflow "${rootWorkflow.name}" has no authored steps to restart from`);
  }

  const promptOptions: SelectOptionItem<string>[] = [];
  const selections = new Map<string, TaskRetryStartSelection>(flattened.selections);
  const resultLabels = new Map<string, string>(flattened.resultLabels);
  if (resumeOption !== undefined) {
    promptOptions.push({
      label: resumeOption.label,
      description: resumeOption.description,
      value: resumeOption.value,
    });
    selections.set(resumeOption.value, resumeOption.selection);
    resultLabels.set(resumeOption.value, `${resumeOption.label} — ${resumeOption.description}`);
  }
  promptOptions.push(...flattened.promptOptions);
  return {
    options: promptOptions.map((option) => ({
      id: option.value,
      label: option.label,
      selectable: option.selectable !== false,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    defaultId,
    selections,
    resultLabels,
    ...(resumeResolution !== undefined && 'reason' in resumeResolution
      ? { resumeFailureReason: resumeResolution.reason }
      : {}),
  };
}

/** Build choices without performing terminal I/O. */
export function buildTaskRetryStartOptions(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): TaskRetryStartOptionsModel {
  const catalog = buildTaskRetryStartCatalog(rootWorkflow, options);
  return {
    options: catalog.options,
    defaultId: catalog.defaultId,
    ...(catalog.resumeFailureReason === undefined ? {} : { resumeFailureReason: catalog.resumeFailureReason }),
  };
}

/** Resolve an opaque choice against the current workflow snapshot. */
export function resolveTaskRetryStartOption(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
  selectedId: string,
): TaskRetryStartSelectionResult {
  const catalog = buildTaskRetryStartCatalog(rootWorkflow, options);
  const selection = catalog.selections.get(selectedId);
  if (selection === undefined) {
    throw new Error(`Unknown task retry start selection: ${selectedId}`);
  }
  return {
    label: catalog.resultLabels.get(selectedId) ?? selectedId,
    selection,
  };
}

function sanitizeHeadingDescription(description: string): string {
  // Escape controls individually so complete ANSI sequences remain visible as text.
  // eslint-disable-next-line no-control-regex
  return description.replace(/[\x00-\x1f\x7f-\x9f]/gu, (control) => sanitizeTerminalText(control));
}

export async function selectTaskRetryStart(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
  selectOption: TaskRetryStartOptionSelector,
): Promise<TaskRetryStartSelectionResult | null> {
  let catalog: TaskRetryStartCatalog;
  try {
    catalog = buildTaskRetryStartCatalog(rootWorkflow, options);
  } catch (error) {
    if (!(error instanceof InvalidTaskRetryResumeWithoutRestartError)) {
      throw error;
    }
    warn(sanitizeTerminalText(error.message));
    return null;
  }
  if (catalog.resumeFailureReason !== undefined) {
    warn(sanitizeTerminalText(`${catalog.resumeFailureReason}. Saved resume information cannot be carried forward. Select a position to restart execution, or Cancel.`));
  }
  const promptOptions: SelectOptionItem<string>[] = catalog.options.map((option) => ({
    label: option.label,
    value: option.id,
    ...(option.id === RESUME_SELECTION_VALUE ? { descriptionWrapFromColumns: 80 } : {}),
    ...(option.selectable ? {} : { selectable: false }),
    ...(option.description === undefined ? {} : {
      description: option.selectable ? option.description : sanitizeHeadingDescription(option.description),
    }),
  }));

  const selectedValue = await selectOption(
    `Start position — ${formatTaskRetryPath([rootWorkflow.name])}:`,
    promptOptions,
    catalog.defaultId,
  );
  if (selectedValue === null) {
    return null;
  }
  return resolveTaskRetryStartOption(rootWorkflow, options, selectedValue);
}
