import type { WorkflowCategoryNode } from './workflowCategoryTypes.js';

function findWorkflowCategoryPaths(
  workflowName: string,
  categories: WorkflowCategoryNode[],
  prefix: string[],
  results: string[],
): void {
  for (const node of categories) {
    const path = [...prefix, node.name];
    if (node.workflows.includes(workflowName)) {
      results.push(path.join(' / '));
    }
    findWorkflowCategoryPaths(workflowName, node.children, path, results);
  }
}

export function findWorkflowCategories(
  workflowName: string,
  categories: WorkflowCategoryNode[],
): string[] {
  const results: string[] = [];
  findWorkflowCategoryPaths(workflowName, categories, [], results);
  return results;
}
