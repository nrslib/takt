import {
  buildCategorizedWorkflows,
  getWorkflowCategories,
  loadAllStandaloneWorkflowsWithSources,
  resolveIgnoredWorkflows,
  type WorkflowCategoryNode,
  type WorkflowWithSource,
} from '../../infra/config/index.js';

export interface WebWorkflowOption {
  readonly id: string;
  readonly description: string;
  readonly source: WorkflowWithSource['source'];
}

export interface WebWorkflowCategory {
  readonly id: string;
  readonly label: string;
  readonly workflows: readonly WebWorkflowOption[];
}

export interface WebWorkflowCatalog {
  readonly categories: readonly WebWorkflowCategory[];
  readonly warnings: readonly string[];
}

function workflowOption(
  id: string,
  allWorkflows: ReadonlyMap<string, WorkflowWithSource>,
  descriptions: Readonly<Record<string, string>> | undefined,
): WebWorkflowOption | null {
  const workflow = allWorkflows.get(id);
  if (workflow === undefined) return null;
  return {
    id,
    description: descriptions?.[id] ?? workflow.config.description ?? '',
    source: workflow.source,
  };
}

export function flattenWorkflowCategories(
  nodes: readonly WorkflowCategoryNode[],
  allWorkflows: ReadonlyMap<string, WorkflowWithSource>,
  descriptions?: Readonly<Record<string, string>>,
): WebWorkflowCategory[] {
  const categories: WebWorkflowCategory[] = [];

  const visit = (entries: readonly WorkflowCategoryNode[], parents: readonly string[]): void => {
    for (const entry of entries) {
      const path = [...parents, entry.name];
      const workflows = entry.workflows
        .map((id) => workflowOption(id, allWorkflows, descriptions))
        .filter((workflow): workflow is WebWorkflowOption => workflow !== null);
      if (workflows.length > 0) {
        categories.push({
          id: path.join('/'),
          label: path.join(' / '),
          workflows,
        });
      }
      visit(entry.children, path);
    }
  };

  visit(nodes, []);
  return categories;
}

export function readWorkflowCatalog(projectDirectory: string): WebWorkflowCatalog {
  const warnings: string[] = [];
  const allWorkflows = loadAllStandaloneWorkflowsWithSources(projectDirectory, {
    onWarning: (message) => warnings.push(message),
  });
  const categoryConfig = getWorkflowCategories(projectDirectory);

  if (categoryConfig === null) {
    return {
      categories: allWorkflows.size === 0
        ? []
        : [{
            id: 'all',
            label: 'すべて',
            workflows: [...allWorkflows.keys()].map((id) =>
              workflowOption(id, allWorkflows, undefined) as WebWorkflowOption),
          }],
      warnings,
    };
  }

  const categorized = buildCategorizedWorkflows(
    allWorkflows,
    categoryConfig,
    resolveIgnoredWorkflows(projectDirectory),
  );
  for (const missing of categorized.missingWorkflows.filter((entry) => entry.source === 'user')) {
    warnings.push(
      `Workflow "${missing.workflowName}" in category "${missing.categoryPath.join(' / ')}" was not found.`,
    );
  }

  return {
    categories: flattenWorkflowCategories(
      categorized.categories,
      categorized.allWorkflows,
      categorized.workflowDescriptions,
    ),
    warnings,
  };
}
