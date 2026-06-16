import type { WorkflowTraceTaskMetadata } from '../../../core/workflow/types.js';
import type { TaskInfo } from '../../../infra/task/index.js';
import { firstLine } from '../../../infra/task/naming.js';

type TaskSource = NonNullable<WorkflowTraceTaskMetadata['taskSource']>;

export interface TraceTaskContext {
  source?: TaskSource | undefined;
  issueNumber?: number | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  baseBranch?: string | undefined;
  taskSlug?: string | undefined;
  worktreePath?: string | undefined;
}

export interface BuildTraceTaskMetadataOptions extends TraceTaskContext {
  task?: TaskInfo | undefined;
  taskContent?: string | undefined;
  worktreePath?: string | undefined;
}

export function buildTraceTaskMetadata(options: BuildTraceTaskMetadataOptions): WorkflowTraceTaskMetadata {
  const issueNumber = options.issueNumber ?? options.task?.data?.issue;
  const prNumber = options.prNumber ?? options.task?.data?.pr_number;
  const taskSource = resolveTaskSource(options.source ?? options.task?.data?.source, issueNumber, prNumber);
  const taskSummary = resolveTaskSummary(options);

  return compactTraceTaskMetadata({
    taskName: options.task?.name,
    taskSlug: options.taskSlug ?? options.task?.slug,
    taskSummary,
    taskSource,
    issueNumber,
    prNumber,
    gitBranch: options.branch ?? options.task?.data?.branch,
    gitBaseBranch: options.baseBranch ?? options.task?.data?.base_branch,
    worktreePath: options.worktreePath ?? options.task?.worktreePath,
  });
}

function resolveTaskSource(
  source: TaskSource | undefined,
  issueNumber: number | undefined,
  prNumber: number | undefined,
): TaskSource {
  if (source) {
    return source;
  }
  if (prNumber !== undefined) {
    return 'pr_review';
  }
  if (issueNumber !== undefined) {
    return 'issue';
  }
  return 'manual';
}

function resolveTaskSummary(options: BuildTraceTaskMetadataOptions): string | undefined {
  return firstNonEmptySummary([
    options.task?.summary,
    options.task?.data?.task,
    options.taskContent,
    options.task?.content,
  ]);
}

function compactTraceTaskMetadata(metadata: WorkflowTraceTaskMetadata): WorkflowTraceTaskMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined && value !== ''),
  ) as WorkflowTraceTaskMetadata;
}

function firstNonEmptySummary(sources: Array<string | undefined>): string | undefined {
  for (const source of sources) {
    if (source === undefined) {
      continue;
    }
    const summary = firstLine(source);
    if (summary !== '') {
      return summary;
    }
  }
  return undefined;
}
