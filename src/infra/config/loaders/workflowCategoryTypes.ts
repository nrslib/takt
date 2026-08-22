import type { WorkflowWithSource } from './workflowResolver.js';

export const BUILTIN_CATEGORY_NAME = 'builtin';

export interface WorkflowCategoryNode {
  name: string;
  workflows: string[];
  children: WorkflowCategoryNode[];
}

export type WorkflowDescriptions = Readonly<Record<string, string>>;

export interface CategoryConfig {
  workflowCategories: WorkflowCategoryNode[];
  builtinWorkflowCategories: WorkflowCategoryNode[];
  userWorkflowCategories: WorkflowCategoryNode[];
  hasUserCategories: boolean;
  showOthersCategory: boolean;
  othersCategoryName: string;
  workflowDescriptions?: WorkflowDescriptions;
}

export interface CategorizedWorkflows {
  categories: WorkflowCategoryNode[];
  allWorkflows: Map<string, WorkflowWithSource>;
  missingWorkflows: MissingWorkflow[];
  workflowDescriptions?: WorkflowDescriptions;
}

export interface MissingWorkflow {
  categoryPath: string[];
  workflowName: string;
  source: 'builtin' | 'user';
}
