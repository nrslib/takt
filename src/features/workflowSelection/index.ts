/**
 * Workflow selection helpers (UI layer).
 */

import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { info, warn } from '../../shared/ui/index.js';
import {
  getBookmarkedWorkflows,
  addBookmark,
  removeBookmark,
} from '../../infra/config/global/index.js';
import {
  findWorkflowCategories,
  type WorkflowDirEntry,
  type WorkflowCategoryNode,
  type CategorizedWorkflows,
  type MissingWorkflow,
  type WorkflowSource,
  type WorkflowWithSource,
} from '../../infra/config/index.js';

/** Top-level selection item: either a workflow or a category containing workflows */
export type WorkflowSelectionItem =
  | { type: 'workflow'; name: string }
  | { type: 'category'; name: string; workflows: string[] };

/** Option item for prompt UI */
export interface SelectionOption {
  label: string;
  value: string;
}

/**
 * Build top-level selection items for the workflow chooser UI.
 * Root-level workflows and categories are displayed at the same level.
 */
export function buildWorkflowSelectionItems(entries: WorkflowDirEntry[]): WorkflowSelectionItem[] {
  const categories = new Map<string, string[]>();
  const items: WorkflowSelectionItem[] = [];

  for (const entry of entries) {
    if (entry.category) {
      let workflows = categories.get(entry.category);
      if (!workflows) {
        workflows = [];
        categories.set(entry.category, workflows);
      }
      workflows.push(entry.name);
    } else {
      items.push({ type: 'workflow', name: entry.name });
    }
  }

  for (const [name, workflows] of categories) {
    items.push({ type: 'category', name, workflows: workflows.sort() });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

const CATEGORY_VALUE_PREFIX = '__category__:';

/**
 * Build top-level select options from WorkflowSelectionItems.
 * Categories are encoded with a prefix in the value field.
 */
export function buildTopLevelSelectOptions(
  items: WorkflowSelectionItem[],
  currentWorkflow: string,
): SelectionOption[] {
  return items.map((item) => {
    if (item.type === 'workflow') {
      const isCurrent = item.name === currentWorkflow;
      const label = isCurrent ? `${item.name} (current)` : item.name;
      return { label, value: item.name };
    }
    const containsCurrent = item.workflows.some((w) => w === currentWorkflow);
    const label = containsCurrent ? `📁 ${item.name}/ (current)` : `📁 ${item.name}/`;
    return { label, value: `${CATEGORY_VALUE_PREFIX}${item.name}` };
  });
}

/**
 * Parse a top-level selection result.
 * Returns the category name if a category was selected, or null if a workflow was selected directly.
 */
export function parseCategorySelection(selected: string): string | null {
  if (selected.startsWith(CATEGORY_VALUE_PREFIX)) {
    return selected.slice(CATEGORY_VALUE_PREFIX.length);
  }
  return null;
}

/**
 * Build select options for workflows within a category.
 */
export function buildCategoryWorkflowOptions(
  items: WorkflowSelectionItem[],
  categoryName: string,
  currentWorkflow: string,
): SelectionOption[] | null {
  const categoryItem = items.find(
    (item) => item.type === 'category' && item.name === categoryName,
  );
  if (!categoryItem || categoryItem.type !== 'category') return null;

  return categoryItem.workflows.map((qualifiedName) => {
    const displayName = qualifiedName.split('/').pop()!;
    const isCurrent = qualifiedName === currentWorkflow;
    const label = isCurrent ? `${displayName} (current)` : displayName;
    return { label, value: qualifiedName };
  });
}

const BOOKMARK_MARK = ' [*]';

/**
 * Add [*] suffix to bookmarked items without changing order.
 * Pure function — does not mutate inputs.
 */
export function applyBookmarks(
  options: SelectionOption[],
  bookmarkedWorkflows: string[],
): SelectionOption[] {
  const bookmarkedSet = new Set(bookmarkedWorkflows);

  return options.map((opt) => {
    if (bookmarkedSet.has(opt.value)) {
      return { ...opt, label: `${opt.label}${BOOKMARK_MARK}` };
    }
    return opt;
  });
}

/**
 * Warn about missing workflows referenced by categories.
 */
export function warnMissingWorkflows(missing: MissingWorkflow[]): void {
  for (const { categoryPath, workflowName } of missing) {
    const pathLabel = categoryPath.join(' / ');
    warn(`Workflow "${workflowName}" in category "${pathLabel}" not found`);
  }
}

function countWorkflowsInTree(categories: WorkflowCategoryNode[]): number {
  let count = 0;
  const visit = (nodes: WorkflowCategoryNode[]): void => {
    for (const node of nodes) {
      count += node.workflows.length;
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(categories);
  return count;
}

function categoryContainsWorkflow(node: WorkflowCategoryNode, workflow: string): boolean {
  if (node.workflows.includes(workflow)) return true;
  for (const child of node.children) {
    if (categoryContainsWorkflow(child, workflow)) return true;
  }
  return false;
}

function buildCategoryLevelOptions(
  categories: WorkflowCategoryNode[],
  workflows: string[],
  currentWorkflow: string,
  rootCategories: WorkflowCategoryNode[],
  currentPathLabel: string,
): {
  options: SelectionOption[];
  categoryMap: Map<string, WorkflowCategoryNode>;
} {
  const options: SelectionOption[] = [];
  const categoryMap = new Map<string, WorkflowCategoryNode>();

  for (const category of categories) {
    const containsCurrent = currentWorkflow.length > 0 && categoryContainsWorkflow(category, currentWorkflow);
    const label = containsCurrent
      ? `📁 ${category.name}/ (current)`
      : `📁 ${category.name}/`;
    const value = `${CATEGORY_VALUE_PREFIX}${category.name}`;
    options.push({ label, value });
    categoryMap.set(category.name, category);
  }

  for (const workflowName of workflows) {
    const isCurrent = workflowName === currentWorkflow;
    const alsoIn = findWorkflowCategories(workflowName, rootCategories)
      .filter((path) => path !== currentPathLabel);
    const alsoInLabel = alsoIn.length > 0 ? `also in ${alsoIn.join(', ')}` : '';

    let label = `🎼 ${workflowName}`;
    if (isCurrent && alsoInLabel) {
      label = `🎼 ${workflowName} (current, ${alsoInLabel})`;
    } else if (isCurrent) {
      label = `🎼 ${workflowName} (current)`;
    } else if (alsoInLabel) {
      label = `🎼 ${workflowName} (${alsoInLabel})`;
    }

    options.push({ label, value: workflowName });
  }

  return { options, categoryMap };
}

async function selectWorkflowFromCategoryTree(
  categories: WorkflowCategoryNode[],
  currentWorkflow: string,
  hasSourceSelection: boolean,
  rootWorkflows: string[] = [],
): Promise<string | null> {
  if (categories.length === 0 && rootWorkflows.length === 0) {
    info('No workflows available for configured categories.');
    return null;
  }

  const stack: WorkflowCategoryNode[] = [];

  while (true) {
    const currentNode = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const currentCategories = currentNode ? currentNode.children : categories;
    const currentWorkflows = currentNode ? currentNode.workflows : rootWorkflows;
    const currentPathLabel = stack.map((node) => node.name).join(' / ');

    const { options, categoryMap } = buildCategoryLevelOptions(
      currentCategories,
      currentWorkflows,
      currentWorkflow,
      categories,
      currentPathLabel,
    );

    if (options.length === 0) {
      if (stack.length === 0) {
        info('No workflows available for configured categories.');
        return null;
      }
      stack.pop();
      continue;
    }

    const buildOptionsWithBookmarks = (): SelectionOption[] =>
      applyBookmarks(options, getBookmarkedWorkflows());

    const message = currentPathLabel.length > 0
      ? `Select workflow in ${currentPathLabel}:`
      : 'Select workflow category:';

    const selected = await selectOption<string>(message, buildOptionsWithBookmarks(), {
      cancelLabel: (stack.length > 0 || hasSourceSelection) ? '← Go back' : 'Cancel',
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        // Don't handle bookmark keys for categories
        if (parseCategorySelection(value)) {
          return null; // Delegate to default handler
        }

        if (key === 'b') {
          addBookmark(value);
          return buildOptionsWithBookmarks();
        }

        if (key === 'r') {
          removeBookmark(value);
          return buildOptionsWithBookmarks();
        }

        return null; // Delegate to default handler
      },
    });

    if (!selected) {
      if (stack.length > 0) {
        stack.pop();
        continue;
      }
      return null;
    }

    const categoryName = parseCategorySelection(selected);
    if (categoryName) {
      const nextNode = categoryMap.get(categoryName);
      if (!nextNode) continue;
      stack.push(nextNode);
      continue;
    }

    return selected;
  }
}

function countWorkflowsIncludingCategories(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  sourceFilter: WorkflowSource,
): number {
  const categorizedWorkflows = new Set<string>();
  const visit = (nodes: WorkflowCategoryNode[]): void => {
    for (const node of nodes) {
      for (const w of node.workflows) {
        categorizedWorkflows.add(w);
      }
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(categories);

  let count = 0;
  for (const [name, { source }] of allWorkflows) {
    if (source === sourceFilter) {
      count++;
    }
  }
  return count;
}

const CURRENT_WORKFLOW_VALUE = '__current__';
const CUSTOM_UNCATEGORIZED_VALUE = '__custom_uncategorized__';
const BUILTIN_SOURCE_VALUE = '__builtin__';
const CUSTOM_CATEGORY_PREFIX = '__custom_category__:';

type TopLevelSelection =
  | { type: 'current' }
  | { type: 'workflow'; name: string }
  | { type: 'custom_category'; node: WorkflowCategoryNode }
  | { type: 'custom_uncategorized' }
  | { type: 'builtin' };

async function selectTopLevelWorkflowOption(
  categorized: CategorizedWorkflows,
  currentWorkflow: string,
): Promise<TopLevelSelection | null> {
  const uncategorizedCustom = getRootLevelWorkflows(
    categorized.categories,
    categorized.allWorkflows,
    'user'
  );
  const builtinCount = countWorkflowsIncludingCategories(
    categorized.builtinCategories,
    categorized.allWorkflows,
    'builtin'
  );

  const buildOptions = (): SelectOptionItem<string>[] => {
    const options: SelectOptionItem<string>[] = [];
    const bookmarkedWorkflows = getBookmarkedWorkflows(); // Get fresh bookmarks on every build

    // 1. Current workflow
    if (currentWorkflow) {
      options.push({
        label: `🎼 ${currentWorkflow} (current)`,
        value: CURRENT_WORKFLOW_VALUE,
      });
    }

    // 2. Bookmarked workflows (individual items)
    for (const workflowName of bookmarkedWorkflows) {
      if (workflowName === currentWorkflow) continue; // Skip if already shown as current
      options.push({
        label: `🎼 ${workflowName} [*]`,
        value: workflowName,
      });
    }

    // 3. User-defined categories
    for (const category of categorized.categories) {
      options.push({
        label: `📁 ${category.name}/`,
        value: `${CUSTOM_CATEGORY_PREFIX}${category.name}`,
      });
    }

    // 4. Builtin workflows
    if (builtinCount > 0) {
      options.push({
        label: `📂 Builtin/ (${builtinCount})`,
        value: BUILTIN_SOURCE_VALUE,
      });
    }

    // 5. Uncategorized custom workflows
    if (uncategorizedCustom.length > 0) {
      options.push({
        label: `📂 Custom/ (${uncategorizedCustom.length})`,
        value: CUSTOM_UNCATEGORIZED_VALUE,
      });
    }

    return options;
  };

  if (buildOptions().length === 0) return null;

  const result = await selectOption<string>('Select workflow:', buildOptions(), {
    onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
      // Don't handle bookmark keys for special values
      if (value === CURRENT_WORKFLOW_VALUE ||
          value === CUSTOM_UNCATEGORIZED_VALUE ||
          value === BUILTIN_SOURCE_VALUE ||
          value.startsWith(CUSTOM_CATEGORY_PREFIX)) {
        return null; // Delegate to default handler
      }

      if (key === 'b') {
        addBookmark(value);
        return buildOptions();
      }

      if (key === 'r') {
        removeBookmark(value);
        return buildOptions();
      }

      return null; // Delegate to default handler
    },
  });

  if (!result) return null;

  if (result === CURRENT_WORKFLOW_VALUE) {
    return { type: 'current' };
  }

  if (result === CUSTOM_UNCATEGORIZED_VALUE) {
    return { type: 'custom_uncategorized' };
  }

  if (result === BUILTIN_SOURCE_VALUE) {
    return { type: 'builtin' };
  }

  if (result.startsWith(CUSTOM_CATEGORY_PREFIX)) {
    const categoryName = result.slice(CUSTOM_CATEGORY_PREFIX.length);
    const node = categorized.categories.find(c => c.name === categoryName);
    if (!node) return null;
    return { type: 'custom_category', node };
  }

  // Direct workflow selection (bookmarked or other)
  return { type: 'workflow', name: result };
}

function getRootLevelWorkflows(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  sourceFilter: WorkflowSource,
): string[] {
  const categorizedWorkflows = new Set<string>();
  const visit = (nodes: WorkflowCategoryNode[]): void => {
    for (const node of nodes) {
      for (const w of node.workflows) {
        categorizedWorkflows.add(w);
      }
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(categories);

  const rootWorkflows: string[] = [];
  for (const [name, { source }] of allWorkflows) {
    if (source === sourceFilter && !categorizedWorkflows.has(name)) {
      rootWorkflows.push(name);
    }
  }
  return rootWorkflows.sort();
}

/**
 * Select workflow from categorized workflows (hierarchical UI).
 */
export async function selectWorkflowFromCategorizedWorkflows(
  categorized: CategorizedWorkflows,
  currentWorkflow: string,
): Promise<string | null> {
  while (true) {
    const selection = await selectTopLevelWorkflowOption(categorized, currentWorkflow);
    if (!selection) {
      return null;
    }

    // 1. Current workflow selected
    if (selection.type === 'current') {
      return currentWorkflow;
    }

    // 2. Direct workflow selected (e.g., bookmarked workflow)
    if (selection.type === 'workflow') {
      return selection.name;
    }

    // 3. User-defined category selected
    if (selection.type === 'custom_category') {
      const workflow = await selectWorkflowFromCategoryTree(
        [selection.node],
        currentWorkflow,
        true,
        selection.node.workflows
      );
      if (workflow) {
        return workflow;
      }
      // null → go back to top-level selection
      continue;
    }

    // 4. Builtin workflows selected
    if (selection.type === 'builtin') {
      const rootWorkflows = getRootLevelWorkflows(
        categorized.builtinCategories,
        categorized.allWorkflows,
        'builtin'
      );

      const workflow = await selectWorkflowFromCategoryTree(
        categorized.builtinCategories,
        currentWorkflow,
        true,
        rootWorkflows
      );
      if (workflow) {
        return workflow;
      }
      // null → go back to top-level selection
      continue;
    }

    // 5. Custom uncategorized workflows selected
    if (selection.type === 'custom_uncategorized') {
      const uncategorizedCustom = getRootLevelWorkflows(
        categorized.categories,
        categorized.allWorkflows,
        'user'
      );

      const baseOptions: SelectionOption[] = uncategorizedCustom.map((name) => ({
        label: name === currentWorkflow ? `🎼 ${name} (current)` : `🎼 ${name}`,
        value: name,
      }));

      const buildFlatOptions = (): SelectionOption[] =>
        applyBookmarks(baseOptions, getBookmarkedWorkflows());

      const workflow = await selectOption<string>('Select workflow:', buildFlatOptions(), {
        cancelLabel: '← Go back',
        onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
          if (key === 'b') {
            addBookmark(value);
            return buildFlatOptions();
          }
          if (key === 'r') {
            removeBookmark(value);
            return buildFlatOptions();
          }
          return null; // Delegate to default handler
        },
      });

      if (workflow) {
        return workflow;
      }
      // null → go back to top-level selection
      continue;
    }
  }
}

async function selectWorkflowFromEntriesWithCategories(
  entries: WorkflowDirEntry[],
  currentWorkflow: string,
): Promise<string | null> {
  if (entries.length === 0) return null;

  const items = buildWorkflowSelectionItems(entries);
  const availableWorkflows = entries.map((entry) => entry.name);
  const hasCategories = items.some((item) => item.type === 'category');

  if (!hasCategories) {
    const baseOptions: SelectionOption[] = availableWorkflows.map((name) => ({
      label: name === currentWorkflow ? `🎼 ${name} (current)` : `🎼 ${name}`,
      value: name,
    }));

    const buildFlatOptions = (): SelectionOption[] =>
      applyBookmarks(baseOptions, getBookmarkedWorkflows());

    return selectOption<string>('Select workflow:', buildFlatOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        if (key === 'b') {
          addBookmark(value);
          return buildFlatOptions();
        }
        if (key === 'r') {
          removeBookmark(value);
          return buildFlatOptions();
        }
        return null; // Delegate to default handler
      },
    });
  }

  // Loop until user selects a workflow or cancels at top level
  while (true) {
    const buildTopLevelOptions = (): SelectionOption[] =>
      applyBookmarks(buildTopLevelSelectOptions(items, currentWorkflow), getBookmarkedWorkflows());

    const selected = await selectOption<string>('Select workflow:', buildTopLevelOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        // Don't handle bookmark keys for categories
        if (parseCategorySelection(value)) {
          return null; // Delegate to default handler
        }

        if (key === 'b') {
          addBookmark(value);
          return buildTopLevelOptions();
        }

        if (key === 'r') {
          removeBookmark(value);
          return buildTopLevelOptions();
        }

        return null; // Delegate to default handler
      },
    });
    if (!selected) return null;

    const categoryName = parseCategorySelection(selected);
    if (categoryName) {
      const categoryOptions = buildCategoryWorkflowOptions(items, categoryName, currentWorkflow);
      if (!categoryOptions) continue;

      const buildCategoryOptions = (): SelectionOption[] =>
        applyBookmarks(categoryOptions, getBookmarkedWorkflows());

      const workflowSelection = await selectOption<string>(`Select workflow in ${categoryName}:`, buildCategoryOptions(), {
        cancelLabel: '← Go back',
        onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
          if (key === 'b') {
            addBookmark(value);
            return buildCategoryOptions();
          }
          if (key === 'r') {
            removeBookmark(value);
            return buildCategoryOptions();
          }
          return null; // Delegate to default handler
        },
      });

      // If workflow selected, return it. If cancelled (null), go back to top level
      if (workflowSelection) return workflowSelection;
      continue;
    }

    return selected;
  }
}

/**
 * Select workflow from directory entries (builtin separated).
 */
export async function selectWorkflowFromEntries(
  entries: WorkflowDirEntry[],
  currentWorkflow: string,
): Promise<string | null> {
  const builtinEntries = entries.filter((entry) => entry.source === 'builtin');
  const customEntries = entries.filter((entry) => entry.source !== 'builtin');

  if (builtinEntries.length > 0 && customEntries.length > 0) {
    const selectedSource = await selectOption<'custom' | 'builtin'>('Select workflow source:', [
      { label: `Custom workflows (${customEntries.length})`, value: 'custom' },
      { label: `Builtin workflows (${builtinEntries.length})`, value: 'builtin' },
    ]);
    if (!selectedSource) return null;
    const sourceEntries = selectedSource === 'custom' ? customEntries : builtinEntries;
    return selectWorkflowFromEntriesWithCategories(sourceEntries, currentWorkflow);
  }

  const entriesToUse = customEntries.length > 0 ? customEntries : builtinEntries;
  return selectWorkflowFromEntriesWithCategories(entriesToUse, currentWorkflow);
}
