import type { WorkflowDirEntry, MissingWorkflow } from '../../infra/config/index.js';
import { warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';

export type WorkflowSelectionItem =
  | { type: 'workflow'; name: string }
  | { type: 'category'; name: string; workflows: string[] };

export interface SelectionOption {
  label: string;
  value: string;
}

export const CATEGORY_VALUE_PREFIX = '__category__:';
const BOOKMARK_MARK = ' [*]';

export function getWorkflowDescription(
  workflowName: string,
  workflowDescriptions?: Readonly<Record<string, string>>,
): string | undefined {
  if (
    workflowDescriptions === undefined
    || !Object.prototype.hasOwnProperty.call(workflowDescriptions, workflowName)
  ) {
    return undefined;
  }
  return workflowDescriptions[workflowName];
}

export function formatWorkflowLabel(
  workflowName: string,
  workflowDescription: string | undefined,
  includeIcon: boolean,
): string {
  const safeName = sanitizeTerminalText(workflowName);
  const label = includeIcon ? `🎼 ${safeName}` : safeName;
  return workflowDescription === undefined
    ? label
    : `${label} — ${sanitizeTerminalText(workflowDescription)}`;
}

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
    items.push({ type: 'workflow', name: entry.name });
  }

  for (const [name, workflows] of categories) {
    items.push({ type: 'category', name, workflows: workflows.sort() });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTopLevelSelectOptions(
  items: WorkflowSelectionItem[],
  workflowDescriptions?: Readonly<Record<string, string>>,
): SelectionOption[] {
  return items.map((item) => {
    if (item.type === 'workflow') {
      return {
        label: formatWorkflowLabel(item.name, getWorkflowDescription(item.name, workflowDescriptions), false),
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
  workflowDescriptions?: Readonly<Record<string, string>>,
): SelectionOption[] | null {
  const categoryItem = items.find(
    (item) => item.type === 'category' && item.name === categoryName,
  );
  if (!categoryItem || categoryItem.type !== 'category') {
    return null;
  }

  return categoryItem.workflows.map((qualifiedName) => {
    const displayName = qualifiedName.split('/').pop() ?? qualifiedName;
    return {
      label: formatWorkflowLabel(displayName, getWorkflowDescription(qualifiedName, workflowDescriptions), false),
      value: qualifiedName,
    };
  });
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
