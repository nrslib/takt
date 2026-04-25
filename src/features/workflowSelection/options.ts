import type {
  WorkflowDirEntry,
  MissingWorkflow,
  WorkflowSource,
  WorkflowWithSource,
} from '../../infra/config/index.js';
import { warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';

export type WorkflowSelectionItem =
  | { type: 'workflow'; name: string; source: WorkflowSource }
  | { type: 'category'; name: string; workflows: string[] };

export interface SelectionOption {
  label: string;
  value: string;
}

export interface WorkflowListItem {
  name: string;
  source: WorkflowSource;
}

export const CATEGORY_VALUE_PREFIX = '__category__:';
const BOOKMARK_MARK = ' [*]';

export function buildWorkflowSelectionItems(entries: WorkflowDirEntry[]): WorkflowSelectionItem[] {
  const categories = new Map<string, string[]>();
  const items: WorkflowSelectionItem[] = [];

  for (const entry of entries) {
    if (entry.category) {
      const workflows = categories.get(entry.category) ?? [];
      workflows.push(entry.name);
      categories.set(entry.category, workflows);
      continue;
    }
    items.push({ type: 'workflow', name: entry.name, source: entry.source });
  }

  for (const [name, workflows] of categories) {
    items.push({ type: 'category', name, workflows: workflows.sort() });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTopLevelSelectOptions(items: WorkflowSelectionItem[]): SelectionOption[] {
  return items.map((item) => {
    if (item.type === 'workflow') {
      return {
        label: item.source === 'builtin'
          ? sanitizeTerminalText(item.name)
          : buildWorkflowOptionLabel(item.name, item.source),
        value: item.name,
      };
    }
    return {
      label: `📁 ${sanitizeTerminalText(item.name)}/`,
      value: `${CATEGORY_VALUE_PREFIX}${item.name}`,
    };
  });
}

export function parseCategorySelection(selected: string): string | null {
  if (!selected.startsWith(CATEGORY_VALUE_PREFIX)) {
    return null;
  }
  return selected.slice(CATEGORY_VALUE_PREFIX.length);
}

export function buildCategoryWorkflowOptions(
  items: WorkflowSelectionItem[],
  categoryName: string,
): SelectionOption[] | null {
  const categoryItem = items.find(
    (item) => item.type === 'category' && item.name === categoryName,
  );
  if (!categoryItem || categoryItem.type !== 'category') {
    return null;
  }

  return categoryItem.workflows.map((qualifiedName) => {
    const displayName = qualifiedName.split('/').pop() ?? qualifiedName;
    return { label: sanitizeTerminalText(displayName), value: qualifiedName };
  });
}

export function isUserDefinedWorkflowSource(
  source: WorkflowSource,
): source is 'user' | 'project' {
  return source === 'user' || source === 'project';
}

export function applyBookmarks(
  options: SelectionOption[],
  bookmarkedWorkflows: string[],
): SelectionOption[] {
  const bookmarkedSet = new Set(bookmarkedWorkflows);
  return options.map((option) => (
    bookmarkedSet.has(option.value)
      ? { ...option, label: `${option.label}${BOOKMARK_MARK}` }
      : option
  ));
}

export function warnMissingWorkflows(missing: MissingWorkflow[]): void {
  for (const { categoryPath, workflowName } of missing) {
    warn(
      `Workflow "${sanitizeTerminalText(workflowName)}" in category "${sanitizeTerminalText(categoryPath.join(' / '))}" not found`,
    );
  }
}

export function buildWorkflowOptionLabel(name: string, source?: WorkflowSource): string {
  const label = sanitizeTerminalText(name);
  if (!source || source === 'builtin') {
    return `🎼 ${label}`;
  }

  return `🎼 ${label} (${getWorkflowSourceDisplayLabel(source)})`;
}

export function buildUserDefinedWorkflowOptions(
  workflows: readonly WorkflowListItem[],
): SelectionOption[] {
  return workflows.map(({ name, source }) => ({
    label: buildWorkflowOptionLabel(name, source),
    value: name,
  }));
}

export function splitEntriesBySource(
  entries: readonly WorkflowDirEntry[],
): {
  builtinEntries: WorkflowDirEntry[];
  userDefinedEntries: WorkflowDirEntry[];
} {
  const builtinEntries: WorkflowDirEntry[] = [];
  const userDefinedEntries: WorkflowDirEntry[] = [];

  for (const entry of entries) {
    if (isUserDefinedWorkflowSource(entry.source)) {
      userDefinedEntries.push(entry);
      continue;
    }

    builtinEntries.push(entry);
  }

  return { builtinEntries, userDefinedEntries };
}

export function splitWorkflowMapBySource(
  workflows: ReadonlyMap<string, WorkflowWithSource>,
): {
  builtinWorkflows: Map<string, WorkflowWithSource>;
  userDefinedWorkflows: WorkflowListItem[];
} {
  const builtinWorkflows = new Map<string, WorkflowWithSource>();
  const userDefinedWorkflows: WorkflowListItem[] = [];

  for (const [name, workflow] of workflows) {
    if (isUserDefinedWorkflowSource(workflow.source)) {
      userDefinedWorkflows.push({ name, source: workflow.source });
      continue;
    }

    builtinWorkflows.set(name, workflow);
  }

  return { builtinWorkflows, userDefinedWorkflows };
}

function getWorkflowSourceDisplayLabel(source: Exclude<WorkflowSource, 'builtin'>): string {
  switch (source) {
    case 'user':
      return 'global';
    case 'project':
      return 'project';
    case 'repertoire':
      return 'repertoire';
  }
}
