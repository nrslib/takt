import type { WorkflowEffect } from '../../models/types.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`System effect requires non-empty string field "${field}"`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`System effect requires positive integer field "${field}"`);
  }
  return value;
}

function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System effect requires object field "${field}"`);
  }
  return value as Record<string, unknown>;
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  field: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`System effect does not allow unknown field "${field}.${key}"`);
    }
  }
}

function validateIssuePayload(value: unknown): void {
  const issue = requireObject(value, 'issue');
  validateAllowedKeys(issue, 'issue', ['create', 'labels']);
  if (issue.create !== undefined && typeof issue.create !== 'boolean') {
    throw new Error('System effect requires boolean field "issue.create"');
  }
  if (issue.labels !== undefined) {
    if (!Array.isArray(issue.labels) || issue.labels.some((label) => typeof label !== 'string')) {
      throw new Error('System effect requires string array field "issue.labels"');
    }
  }
}

function validateWorktreePayload(value: unknown): void {
  const worktree = requireObject(value, 'worktree');
  validateAllowedKeys(worktree, 'worktree', ['enabled', 'auto_pr', 'draft_pr']);
  for (const key of ['enabled', 'auto_pr', 'draft_pr'] as const) {
    if (worktree[key] !== undefined && typeof worktree[key] !== 'boolean') {
      throw new Error(`System effect requires boolean field "worktree.${key}"`);
    }
  }
  if ((worktree.auto_pr === true || worktree.draft_pr === true) && worktree.enabled !== true) {
    throw new Error('System effect requires "worktree.enabled" when auto_pr or draft_pr is true');
  }
}

export function validateSystemEffectPayload(
  effect: WorkflowEffect,
  payload: Record<string, unknown>,
): void {
  if (effect.type === 'enqueue_task') {
    if (payload.mode !== undefined) requireString(payload.mode, 'mode');
    if (payload.workflow !== undefined) requireString(payload.workflow, 'workflow');
    if (payload.task !== undefined) requireString(payload.task, 'task');
    if (payload.pr !== undefined) requireNumber(payload.pr, 'pr');
    if (payload.base_branch !== undefined) requireString(payload.base_branch, 'base_branch');
    if (payload.issue !== undefined) validateIssuePayload(payload.issue);
    if (payload.worktree !== undefined) validateWorktreePayload(payload.worktree);
    if (payload.mode === 'new' && payload.pr !== undefined) {
      throw new Error('System effect mode "new" does not allow field "pr"');
    }
    if (payload.mode === 'from_pr') {
      if (payload.pr === undefined) {
        throw new Error('System effect mode "from_pr" requires field "pr"');
      }
      if (payload.issue !== undefined) {
        throw new Error('System effect mode "from_pr" does not allow field "issue"');
      }
      if (payload.worktree !== undefined) {
        throw new Error('System effect mode "from_pr" does not allow field "worktree"');
      }
    }
  }
  if (effect.type === 'comment_pr') {
    requireNumber(payload.pr, 'pr');
    requireString(payload.body, 'body');
  }
  if (effect.type === 'sync_with_root' || effect.type === 'resolve_conflicts_with_ai' || effect.type === 'merge_pr') {
    requireNumber(payload.pr, 'pr');
  }
}
