import type { CategoryConfig, CategorizedWorkflows, MissingWorkflow, WorkflowCategoryNode } from './workflowCategoryTypes.js';
import type { WorkflowWithSource } from './workflowResolver.js';

function collectMissingWorkflows(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  ignoredWorkflows: ReadonlySet<string>,
  source: 'builtin' | 'user',
): MissingWorkflow[] {
  const missing: MissingWorkflow[] = [];

  const visit = (nodes: WorkflowCategoryNode[], path: string[]): void => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      for (const workflowName of node.workflows) {
        if (!ignoredWorkflows.has(workflowName) && !allWorkflows.has(workflowName)) {
          missing.push({ categoryPath: nextPath, workflowName, source });
        }
      }
      visit(node.children, nextPath);
    }
  };

  visit(categories, []);
  return missing;
}

function buildCategoryTree(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  categorized: Set<string>,
): WorkflowCategoryNode[] {
  const result: WorkflowCategoryNode[] = [];

  for (const node of categories) {
    const workflows = node.workflows.filter((workflowName) => {
      if (!allWorkflows.has(workflowName)) {
        return false;
      }
      categorized.add(workflowName);
      return true;
    });
    const children = buildCategoryTree(node.children, allWorkflows, categorized);
    if (workflows.length > 0 || children.length > 0) {
      result.push({ name: node.name, workflows, children });
    }
  }

  return result;
}

function appendRepertoireCategory(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  categorized: Set<string>,
): WorkflowCategoryNode[] {
  const packageWorkflows = new Map<string, string[]>();

  for (const workflowName of allWorkflows.keys()) {
    if (!workflowName.startsWith('@')) {
      continue;
    }
    const withoutAt = workflowName.slice(1);
    const firstSlash = withoutAt.indexOf('/');
    const secondSlash = withoutAt.indexOf('/', firstSlash + 1);
    if (firstSlash < 0 || secondSlash < 0) {
      continue;
    }
    const packageKey = `@${withoutAt.slice(0, firstSlash)}/${withoutAt.slice(firstSlash + 1, secondSlash)}`;
    const workflows = packageWorkflows.get(packageKey) ?? [];
    workflows.push(workflowName);
    packageWorkflows.set(packageKey, workflows);
    categorized.add(workflowName);
  }

  if (packageWorkflows.size === 0) {
    return categories;
  }

  return [
    ...categories,
    {
      name: 'repertoire',
      workflows: [],
      children: [...packageWorkflows.entries()].map(([name, workflows]) => ({
        name,
        workflows,
        children: [],
      })),
    },
  ];
}

function appendOthersCategory(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  categorized: Set<string>,
  othersCategoryName: string,
): WorkflowCategoryNode[] {
  const uncategorized = [...allWorkflows.keys()].filter((workflowName) => !categorized.has(workflowName));
  if (uncategorized.length === 0) {
    return categories;
  }

  const existingIndex = categories.findIndex((node) => node.name === othersCategoryName);
  if (existingIndex < 0) {
    return [...categories, { name: othersCategoryName, workflows: uncategorized, children: [] }];
  }

  return categories.map((node, index) => (
    index === existingIndex
      ? { ...node, workflows: [...node.workflows, ...uncategorized] }
      : node
  ));
}

export function buildCategorizedWorkflows(
  allWorkflows: Map<string, WorkflowWithSource>,
  config: CategoryConfig,
  ignoredWorkflows: ReadonlySet<string>,
): CategorizedWorkflows {
  const missingWorkflows = [
    ...collectMissingWorkflows(config.builtinWorkflowCategories, allWorkflows, ignoredWorkflows, 'builtin'),
    ...collectMissingWorkflows(config.userWorkflowCategories, allWorkflows, ignoredWorkflows, 'user'),
  ];

  const categorized = new Set<string>();
  const baseCategories = buildCategoryTree(config.workflowCategories, allWorkflows, categorized);
  const categoriesWithEnsemble = appendRepertoireCategory(baseCategories, allWorkflows, categorized);
  const categories = config.showOthersCategory
    ? appendOthersCategory(categoriesWithEnsemble, allWorkflows, categorized, config.othersCategoryName)
    : categoriesWithEnsemble;

  return { categories, allWorkflows, missingWorkflows };
}
