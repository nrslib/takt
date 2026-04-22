export interface WorkflowPrListWhere {
  author?: string;
  base_branch?: string;
  head_branch?: string;
  managed_by_takt?: boolean;
  labels?: string[];
  same_repository?: boolean;
  draft?: boolean;
}

function normalizeWorkflowPrListWhereLabels(labels: string[] | undefined): string[] | undefined {
  if (labels === undefined) {
    return undefined;
  }
  return [...new Set(labels)].sort();
}

export function normalizeWorkflowPrListWhere(
  where: WorkflowPrListWhere | undefined,
): WorkflowPrListWhere | undefined {
  if (where === undefined) {
    return undefined;
  }

  const normalized: WorkflowPrListWhere = {};

  if (where.author !== undefined) {
    normalized.author = where.author;
  }
  if (where.base_branch !== undefined) {
    normalized.base_branch = where.base_branch;
  }
  if (where.head_branch !== undefined) {
    normalized.head_branch = where.head_branch;
  }
  if (where.managed_by_takt !== undefined) {
    normalized.managed_by_takt = where.managed_by_takt;
  }

  const labels = normalizeWorkflowPrListWhereLabels(where.labels);
  if (labels !== undefined) {
    normalized.labels = labels;
  }
  if (where.same_repository !== undefined) {
    normalized.same_repository = where.same_repository;
  }
  if (where.draft !== undefined) {
    normalized.draft = where.draft;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function workflowPrListWhereEquals(
  left: WorkflowPrListWhere | undefined,
  right: WorkflowPrListWhere | undefined,
): boolean {
  return JSON.stringify(normalizeWorkflowPrListWhere(left) ?? {})
    === JSON.stringify(normalizeWorkflowPrListWhere(right) ?? {});
}

export function stringifyWorkflowPrListWhere(where: WorkflowPrListWhere | undefined): string {
  return JSON.stringify(normalizeWorkflowPrListWhere(where) ?? {});
}

interface WorkflowSystemBinding {
  as: string;
}

export type WorkflowSystemInput =
  | (WorkflowSystemBinding & {
    type: 'task_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'branch_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'pr_context';
    source: 'current_branch';
  })
  | (WorkflowSystemBinding & {
    type: 'issue_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'task_queue_context';
    source: 'current_project';
    exclude_current_task?: boolean;
  })
  | (WorkflowSystemBinding & {
    type: 'pr_list';
    source: 'current_project';
    where?: WorkflowPrListWhere;
  })
  | (WorkflowSystemBinding & {
    type: 'issue_list';
    source: 'current_project';
  })
  | (WorkflowSystemBinding & {
    type: 'pr_selection';
    source: 'current_project';
    where?: WorkflowPrListWhere;
  })
  | (WorkflowSystemBinding & {
    type: 'issue_selection';
    source: 'current_project';
  });

export interface WorkflowEnqueueIssueConfig {
  create?: boolean;
  labels?: string[];
}

export interface WorkflowEnqueueWorktreeConfig {
  enabled?: boolean;
  auto_pr?: boolean;
  draft_pr?: boolean;
}

type WorkflowContextTemplateReference = `{context:${string}}`;
type WorkflowStructuredTemplateReference = `{structured:${string}}`;
type WorkflowEffectTemplateReference = `{effect:${string}}`;

export type WorkflowTemplateReference =
  | WorkflowContextTemplateReference
  | WorkflowStructuredTemplateReference
  | WorkflowEffectTemplateReference;

export type WorkflowEffectScalarReference = WorkflowTemplateReference | number;

export type WorkflowEffect =
  | {
    type: 'enqueue_task';
    mode: 'new' | 'from_pr';
    workflow: string;
    task: string;
    pr?: WorkflowEffectScalarReference;
    issue?: WorkflowEnqueueIssueConfig | WorkflowTemplateReference;
    base_branch?: string;
    worktree?: WorkflowEnqueueWorktreeConfig;
  }
  | {
    type: 'comment_pr';
    pr: WorkflowEffectScalarReference;
    body: string;
  }
  | {
    type: 'sync_with_root';
    pr: WorkflowEffectScalarReference;
  }
  | {
    type: 'resolve_conflicts_with_ai';
    pr: WorkflowEffectScalarReference;
  }
  | {
    type: 'merge_pr';
    pr: WorkflowEffectScalarReference;
  };
