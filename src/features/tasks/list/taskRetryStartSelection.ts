import {
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowResumePoint,
} from '../../../core/models/index.js';
import type { SelectOptionItem } from '../../../shared/prompt/index.js';
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
  selection: Extract<TaskRetryStartSelection, { kind: 'resume' }>;
}

function createResumeOption(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): ResumeOption | undefined {
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
    value: RESUME_SELECTION_VALUE,
    label: `${RESUME_LABEL_PREFIX}${formatTaskRetryPath(resolved.segments)}`,
    selection: { kind: 'resume', resumePoint: options.resumePoint },
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
  const resumeOption = createResumeOption(rootWorkflow, options);
  const defaultId = resumeOption?.value
    ?? flattened.preferredLeafValue
    ?? flattened.firstLeafValue;
  if (defaultId === undefined) {
    throw new Error(`Workflow "${rootWorkflow.name}" has no authored steps to restart from`);
  }

  const promptOptions: SelectOptionItem<string>[] = [];
  const selections = new Map<string, TaskRetryStartSelection>(flattened.selections);
  const resultLabels = new Map<string, string>(flattened.resultLabels);
  if (resumeOption !== undefined) {
    promptOptions.push({ label: resumeOption.label, value: resumeOption.value });
    selections.set(resumeOption.value, resumeOption.selection);
    resultLabels.set(resumeOption.value, resumeOption.label);
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
  };
}

/** Build choices without performing terminal I/O. */
export function buildTaskRetryStartOptions(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): TaskRetryStartOptionsModel {
  const catalog = buildTaskRetryStartCatalog(rootWorkflow, options);
  return { options: catalog.options, defaultId: catalog.defaultId };
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

export async function selectTaskRetryStart(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
  selectOption: TaskRetryStartOptionSelector,
): Promise<TaskRetryStartSelectionResult | null> {
  const catalog = buildTaskRetryStartCatalog(rootWorkflow, options);
  const promptOptions: SelectOptionItem<string>[] = catalog.options.map((option) => ({
    label: option.label,
    value: option.id,
    ...(option.selectable ? {} : { selectable: false }),
    ...(option.description === undefined ? {} : { description: option.description }),
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
