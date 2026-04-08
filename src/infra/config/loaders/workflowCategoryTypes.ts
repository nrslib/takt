import type { WorkflowWithSource } from './workflowResolver.js';

export const BUILTIN_CATEGORY_NAME = 'builtin';

export interface WorkflowCategoryNode {
  name: string;
  workflows: string[];
  children: WorkflowCategoryNode[];
}

export interface CategoryConfig {
  workflowCategories: WorkflowCategoryNode[];
  builtinWorkflowCategories: WorkflowCategoryNode[];
  userWorkflowCategories: WorkflowCategoryNode[];
  hasUserCategories: boolean;
  showOthersCategory: boolean;
  othersCategoryName: string;
}

export interface CategorizedWorkflows {
  categories: WorkflowCategoryNode[];
  allWorkflows: Map<string, WorkflowWithSource>;
  missingWorkflows: MissingWorkflow[];
}

export interface MissingWorkflow {
  categoryPath: string[];
  workflowName: string;
  source: 'builtin' | 'user';
}
