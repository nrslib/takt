import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { addBookmark, getBookmarkedWorkflows, removeBookmark } from '../../infra/config/global/index.js';
import type { CategorizedWorkflows, WorkflowCategoryNode, WorkflowWithSource } from '../../infra/config/index.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  applyBookmarks,
  buildWorkflowOptionLabel,
  buildUserDefinedWorkflowOptions,
  buildWorkflowSourceOptions,
  type SelectionOption,
  parseCategorySelection,
  CATEGORY_VALUE_PREFIX,
  splitWorkflowMapBySource,
  type WorkflowSourceSelection,
} from './options.js';
import { selectFlatWorkflowOptions } from './flatSelection.js';

const CUSTOM_CATEGORY_PREFIX = '__custom_category__:';

type TopLevelSelection =
  | { type: 'workflow'; name: string }
  | { type: 'category'; node: WorkflowCategoryNode };

function getSelectableBookmarkedWorkflows(categorized: CategorizedWorkflows): string[] {
  const selectableWorkflows = new Set(categorized.allWorkflows.keys());
  return getBookmarkedWorkflows().filter((workflowName) => selectableWorkflows.has(workflowName));
}

function buildCategoryLevelOptions(
  categories: WorkflowCategoryNode[],
  workflows: string[],
  workflowMap: ReadonlyMap<string, WorkflowWithSource>,
): {
  options: SelectionOption[];
  categoryMap: Map<string, WorkflowCategoryNode>;
} {
  const options: SelectionOption[] = [];
  const categoryMap = new Map<string, WorkflowCategoryNode>();

  for (const category of categories) {
    options.push({
      label: `📁 ${sanitizeTerminalText(category.name)}/`,
      value: `${CATEGORY_VALUE_PREFIX}${category.name}`,
    });
    categoryMap.set(category.name, category);
  }

  for (const workflowName of workflows) {
    options.push({
      label: buildWorkflowOptionLabel(workflowName, workflowMap.get(workflowName)?.source),
      value: workflowName,
    });
  }

  return { options, categoryMap };
}

async function selectWorkflowFromCategoryTree(
  categories: WorkflowCategoryNode[],
  workflowMap: ReadonlyMap<string, WorkflowWithSource>,
  hasSourceSelection: boolean,
  rootWorkflows: string[] = [],
): Promise<string | null> {
  if (categories.length === 0 && rootWorkflows.length === 0) {
    info('No workflows available for configured categories.');
    return null;
  }

  const stack: WorkflowCategoryNode[] = [];

  while (true) {
    const currentNode = stack.at(-1);
    const currentCategories = currentNode ? currentNode.children : categories;
    const currentWorkflows = currentNode ? currentNode.workflows : rootWorkflows;
    const currentPathLabel = sanitizeTerminalText(stack.map((node) => node.name).join(' / '));
    const { options, categoryMap } = buildCategoryLevelOptions(
      currentCategories,
      currentWorkflows,
      workflowMap,
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
        if (parseCategorySelection(value)) {
          return null;
        }
        if (key === 'b') {
          addBookmark(value);
          return buildOptionsWithBookmarks();
        }
        if (key === 'r') {
          removeBookmark(value);
          return buildOptionsWithBookmarks();
        }
        return null;
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
    if (!categoryName) {
      return selected;
    }

    const nextNode = categoryMap.get(categoryName);
    if (nextNode) {
      stack.push(nextNode);
    }
  }
}

async function selectTopLevelWorkflowOption(
  categorized: CategorizedWorkflows,
): Promise<TopLevelSelection | null> {
  const buildOptions = (): SelectOptionItem<string>[] => {
    const options: SelectOptionItem<string>[] = [];

    for (const workflowName of getSelectableBookmarkedWorkflows(categorized)) {
      options.push({
        label: `${buildWorkflowOptionLabel(
          workflowName,
          categorized.allWorkflows.get(workflowName)?.source,
        )} [*]`,
        value: workflowName,
      });
    }

    for (const category of categorized.categories) {
      options.push({
        label: `📁 ${sanitizeTerminalText(category.name)}/`,
        value: `${CUSTOM_CATEGORY_PREFIX}${category.name}`,
      });
    }

    return options;
  };

  if (buildOptions().length === 0) {
    return null;
  }

  const result = await selectOption<string>('Select workflow:', buildOptions(), {
    onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
      if (value.startsWith(CUSTOM_CATEGORY_PREFIX)) {
        return null;
      }
      if (key === 'b') {
        addBookmark(value);
        return buildOptions();
      }
      if (key === 'r') {
        removeBookmark(value);
        return buildOptions();
      }
      return null;
    },
  });

  if (!result) {
    return null;
  }
  if (!result.startsWith(CUSTOM_CATEGORY_PREFIX)) {
    return { type: 'workflow', name: result };
  }

  const categoryName = result.slice(CUSTOM_CATEGORY_PREFIX.length);
  const node = categorized.categories.find((category) => category.name === categoryName);
  return node ? { type: 'category', node } : null;
}

function filterCategoryTreeBySources(
  categories: WorkflowCategoryNode[],
  workflows: ReadonlyMap<string, WorkflowWithSource>,
  allowedSources: ReadonlySet<WorkflowWithSource['source']>,
): WorkflowCategoryNode[] {
  const filtered: WorkflowCategoryNode[] = [];

  for (const category of categories) {
    const categoryWorkflows = category.workflows.filter(
      (workflowName) => {
        const workflow = workflows.get(workflowName);
        return workflow ? allowedSources.has(workflow.source) : false;
      },
    );
    const children = filterCategoryTreeBySources(category.children, workflows, allowedSources);
    if (categoryWorkflows.length === 0 && children.length === 0) {
      continue;
    }
    filtered.push({
      name: category.name,
      workflows: categoryWorkflows,
      children,
    });
  }

  return filtered;
}

function buildBuiltinCategorizedWorkflows(
  categorized: CategorizedWorkflows,
  builtinWorkflows: Map<string, WorkflowWithSource>,
): CategorizedWorkflows {
  const builtinSources = new Set<WorkflowWithSource['source']>(['builtin', 'repertoire']);
  return {
    categories: filterCategoryTreeBySources(categorized.categories, categorized.allWorkflows, builtinSources),
    allWorkflows: builtinWorkflows,
    missingWorkflows: categorized.missingWorkflows.filter((workflow) => workflow.source === 'builtin'),
  };
}

export async function selectWorkflowFromCategorizedWorkflowSources(
  categorized: CategorizedWorkflows,
): Promise<string | null> {
  const { builtinWorkflows, userDefinedWorkflows } = splitWorkflowMapBySource(categorized.allWorkflows);
  while (true) {
    const selectedSource = await selectOption<WorkflowSourceSelection>(
      'Select workflow source:',
      buildWorkflowSourceOptions(builtinWorkflows.size, userDefinedWorkflows.length),
    );
    if (!selectedSource) {
      return null;
    }

    if (selectedSource === 'builtin') {
      if (builtinWorkflows.size === 0) {
        info('No builtin workflows available.');
        continue;
      }
      return selectWorkflowFromCategorizedWorkflows(
        buildBuiltinCategorizedWorkflows(categorized, builtinWorkflows),
      );
    }

    if (userDefinedWorkflows.length === 0) {
      info('No user-defined workflows available.');
      continue;
    }

    return selectFlatWorkflowOptions(
      buildUserDefinedWorkflowOptions(userDefinedWorkflows),
      'No user-defined workflows available.',
    );
  }
}

export async function selectWorkflowFromCategorizedWorkflows(
  categorized: CategorizedWorkflows,
): Promise<string | null> {
  while (true) {
    const selection = await selectTopLevelWorkflowOption(categorized);
    if (!selection) {
      return null;
    }
    if (selection.type === 'workflow') {
      return selection.name;
    }

    const workflow = await selectWorkflowFromCategoryTree(
      selection.node.children,
      categorized.allWorkflows,
      true,
      selection.node.workflows,
    );
    if (workflow) {
      return workflow;
    }
  }
}
