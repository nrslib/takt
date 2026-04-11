import { TaskRunner } from '../../task/index.js';
import type {
  WorkflowEffect,
  WorkflowState,
  WorkflowSystemInput,
} from '../../../core/models/types.js';
import type {
  SystemStepServices,
  SystemStepServicesOptions,
} from '../../../core/workflow/system/system-step-services.js';
import { validateSystemEffectPayload } from '../../../core/workflow/system/system-step-effect-runner.js';
import {
  fetchExistingPr,
  fetchIssueContext,
  fetchPrContext,
  resolveCurrentBranch,
} from './system-git-context.js';
import {
  commentPrEffect,
  mergePrEffect,
} from './system-pr-effects.js';
import { enqueueTaskEffect } from './system-enqueue-effect.js';
import { resolveConflictsWithAiEffect, syncWithRootEffect } from './system-sync-effects.js';

function resolveInput(
  options: SystemStepServicesOptions,
  input: WorkflowSystemInput,
): Record<string, unknown> {
  switch (input.type) {
    case 'task_context':
      return options.task.length > 0
        ? { exists: true, body: options.task }
        : { exists: false };
    case 'branch_context': {
      const resolvedBranch = resolveCurrentBranch(options.cwd);
      if (resolvedBranch.error) {
        throw new Error(`Failed to resolve current branch: ${resolvedBranch.error}`);
      }
      return resolvedBranch.branch ? { exists: true, name: resolvedBranch.branch } : { exists: false };
    }
    case 'pr_context': {
      const resolvedBranch = resolveCurrentBranch(options.cwd);
      if (resolvedBranch.error) {
        throw new Error(`Failed to resolve current branch: ${resolvedBranch.error}`);
      }
      if (!resolvedBranch.branch) {
        return { exists: false };
      }
      const existingPr = fetchExistingPr(options.projectCwd, resolvedBranch.branch);
      if (!existingPr) {
        return { exists: false, branch: resolvedBranch.branch };
      }
      const pr = fetchPrContext(options.projectCwd, existingPr.number);
      return {
        exists: true,
        number: pr.number,
        url: pr.url,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        title: pr.title,
        body: pr.body,
      };
    }
    case 'issue_context': {
      const issueNumber = options.taskContext?.issueNumber;
      if (issueNumber == null) {
        return { exists: false };
      }
      const issue = fetchIssueContext(options.projectCwd, issueNumber);
      return {
        exists: true,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        comments: issue.comments,
      };
    }
    case 'task_queue_context': {
      const tasks = new TaskRunner(options.projectCwd).listAllTaskItems();
      const counts = {
        pending_count: 0,
        running_count: 0,
        completed_count: 0,
        failed_count: 0,
        exceeded_count: 0,
        pr_failed_count: 0,
      };
      for (const task of tasks) {
        const key = `${task.kind}_count` as keyof typeof counts;
        if (key in counts) {
          counts[key] += 1;
        }
      }
      return {
        exists: tasks.length > 0,
        total_count: tasks.length,
        ...counts,
      };
    }
  }
}

async function runEffect(
  options: SystemStepServicesOptions,
  effect: WorkflowEffect,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (effect.type) {
    case 'enqueue_task':
      return enqueueTaskEffect(options, payload as Parameters<typeof enqueueTaskEffect>[1]);
    case 'comment_pr':
      return commentPrEffect(options, payload as Parameters<typeof commentPrEffect>[1]);
    case 'sync_with_root':
      return syncWithRootEffect(options, payload as Parameters<typeof syncWithRootEffect>[1]);
    case 'resolve_conflicts_with_ai':
      return resolveConflictsWithAiEffect(options, payload as Parameters<typeof resolveConflictsWithAiEffect>[1]);
    case 'merge_pr':
      return mergePrEffect(options, payload as Parameters<typeof mergePrEffect>[1]);
  }
}

export class DefaultSystemStepServices implements SystemStepServices {
  constructor(private readonly options: SystemStepServicesOptions) {}

  resolveSystemInput(input: WorkflowSystemInput): Record<string, unknown> {
    return resolveInput(this.options, input);
  }

  async executeEffect(
    effect: WorkflowEffect,
    payload: Record<string, unknown>,
    _state: WorkflowState,
  ): Promise<Record<string, unknown>> {
    validateSystemEffectPayload(effect, payload);
    return runEffect(this.options, effect, payload);
  }
}

export function createDefaultSystemStepServices(
  options: SystemStepServicesOptions,
): SystemStepServices {
  return new DefaultSystemStepServices(options);
}
