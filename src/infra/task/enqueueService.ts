import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitProvider } from '../git/index.js';
import { normalizePublicIssueUrl } from '../git/types.js';
import { generateReportDir } from '../../shared/utils/index.js';

export type IssueEnqueueGitProvider = Pick<GitProvider, 'createIssue'>;

export interface SaveEnqueuedTaskFileOptions extends Record<string, unknown> {
  workflow?: string;
  issue?: number;
  worktree?: boolean | string;
  branch?: string;
  baseBranch?: string;
  autoPr?: boolean;
  draftPr?: boolean;
  managedPr?: boolean;
  shouldPublishBranchToOrigin?: boolean;
  prNumber?: number;
  contextPrNumber?: number;
}

export interface PreparedTaskSpecDirectory {
  taskDir: string;
  taskDirRelative: string;
}

export type PreparedEnqueuedTaskSpec = PreparedTaskSpecDirectory;

export type PrepareEnqueuedTaskSpec = (
  cwd: string,
  taskContent: string,
) => PreparedEnqueuedTaskSpec;

export type SaveEnqueuedTaskFile = (
  cwd: string,
  taskContent: string,
  options?: SaveEnqueuedTaskFileOptions,
  prepareTaskSpec?: PrepareEnqueuedTaskSpec,
  abortSignal?: AbortSignal,
) => Promise<{ taskName: string; tasksFile: string }>;

export type CreateEnqueueIssueFromTaskResult = (
  task: string,
  options?: {
    labels?: string[];
    cwd?: string;
    title?: string;
    explicitTitle?: string;
    outputMode?: 'terminal' | 'silent';
    gitProvider?: Pick<IssueEnqueueGitProvider, 'createIssue'>;
  },
  ) =>
    | { success: true; issueNumber: number; issueUrl?: string }
    | { success: false; issueCreated: true; issueUrl?: string; error: string }
    | { success: false; issueCreated?: false; error: string };

export interface EnqueueTaskContext {
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
}

export interface SaveEnqueuedTaskOptions {
  workflow: string;
  worktree?: boolean;
  autoPr?: boolean;
  draftPr?: boolean;
  managedPr?: boolean;
  shouldPublishBranchToOrigin?: boolean;
  issueNumber?: number;
  taskContext?: EnqueueTaskContext;
}

export interface EnqueueTaskRequest extends SaveEnqueuedTaskOptions {
  cwd: string;
  task: string;
  abortSignal?: AbortSignal;
}

export interface IssueEnqueueTaskRequest extends EnqueueTaskRequest {
  labels?: string[];
  /** Generated title that must pass the issue-title fallback rules. */
  title?: string;
  /** User-supplied title that intentionally bypasses generated-title fallback rules. */
  explicitTitle?: string;
  gitProvider: IssueEnqueueGitProvider;
  issueOutputMode?: 'terminal' | 'silent';
}

export interface IssueEnqueueDependencies {
  saveTaskFile: SaveEnqueuedTaskFile;
  createIssueFromTaskResult: CreateEnqueueIssueFromTaskResult;
}

export type EnqueueTaskResult = Awaited<ReturnType<SaveEnqueuedTaskFile>> & {
  workflow: string;
  issueNumber?: number;
};

export type IssueEnqueueFailure =
  | {
    issueCreated: false;
    taskEnqueued: false;
    stage: 'issue_creation';
    error: string;
  }
  | {
    issueCreated: true;
    taskEnqueued: false;
    stage: 'issue_number_parsing';
    issueUrl?: string;
    error: string;
  }
  | {
    issueCreated: true;
    issueNumber: number;
    issueUrl?: string;
    taskEnqueued: false;
    stage: IssueEnqueueFailureStage;
    error: unknown;
  };

export type IssueEnqueueFailureStage = 'task_saving' | 'cancelled_after_issue_creation';

export type IssueEnqueueResult =
  | { success: true; created: EnqueueTaskResult }
  | { success: false; failure: IssueEnqueueFailure };

export interface PrepareTaskSpecDirectoryOptions {
  orderContent?: string;
  beforeWrite?: (taskDir: string) => void;
}

export function reserveTaskSpecDirectory(cwd: string, taskContent: string): PreparedTaskSpecDirectory {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const baseSlug = generateReportDir(taskContent);
  let sequence = 1;

  while (true) {
    const taskDirSlug = sequence === 1 ? baseSlug : `${baseSlug}-${sequence}`;
    const taskDir = path.join(tasksDir, taskDirSlug);
    try {
      fs.mkdirSync(taskDir);
      return {
        taskDir,
        taskDirRelative: `.takt/tasks/${taskDirSlug}`,
      };
    } catch (error) {
      if (isFileExistsError(error)) {
        sequence += 1;
        continue;
      }
      throw error;
    }
  }
}

export function cleanupTaskSpecDirectory(taskDir: string): void {
  fs.rmSync(taskDir, { recursive: true, force: true });
  const tasksDir = path.dirname(taskDir);
  try {
    if (fs.existsSync(tasksDir) && fs.readdirSync(tasksDir).length === 0) {
      fs.rmdirSync(tasksDir);
    }
  } catch {
    // Parent cleanup is best-effort; concurrent enqueue can recreate tasksDir.
  }
}

export function prepareTaskSpecDirectory(
  cwd: string,
  taskContent: string,
  options: PrepareTaskSpecDirectoryOptions = {},
): PreparedTaskSpecDirectory {
  const preparedSpec = reserveTaskSpecDirectory(cwd, taskContent);
  try {
    options.beforeWrite?.(preparedSpec.taskDir);
    fs.writeFileSync(path.join(preparedSpec.taskDir, 'order.md'), options.orderContent ?? taskContent, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    cleanupTaskSpecDirectory(preparedSpec.taskDir);
    throw error;
  }
  return preparedSpec;
}

export function formatIssueEnqueueFailure(
  failure: IssueEnqueueFailure,
  formatError: (error: unknown) => string,
): string {
  if (failure.stage === 'issue_creation') {
    return formatError(failure.error);
  }
  const issueUrl = failure.issueUrl === undefined ? '' : ` Issue URL: ${failure.issueUrl}.`;
  if (failure.stage === 'issue_number_parsing') {
    return `An issue was created, but its number could not be extracted: ${formatError(failure.error)}.${issueUrl}`;
  }
  if (failure.stage === 'cancelled_after_issue_creation') {
    return `Issue #${failure.issueNumber} was created and remains open, but task enqueue was cancelled: ${formatError(failure.error)}${issueUrl}`;
  }
  return `Issue #${failure.issueNumber} was created, but task saving failed: ${formatError(failure.error)}.${issueUrl} The issue remains open for retry.`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function buildEnqueuedTaskSaveOptions(
  input: SaveEnqueuedTaskOptions,
): Parameters<SaveEnqueuedTaskFile>[2] {
  return {
    workflow: input.workflow,
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    ...(input.autoPr !== undefined ? { autoPr: input.autoPr } : {}),
    ...(input.draftPr !== undefined ? { draftPr: input.draftPr } : {}),
    ...(input.managedPr !== undefined ? { managedPr: input.managedPr } : {}),
    ...(input.shouldPublishBranchToOrigin !== undefined
      ? { shouldPublishBranchToOrigin: input.shouldPublishBranchToOrigin }
      : {}),
    ...(input.issueNumber !== undefined ? { issue: input.issueNumber } : {}),
    ...(input.taskContext?.branch !== undefined ? { branch: input.taskContext.branch } : {}),
    ...(input.taskContext?.baseBranch !== undefined ? { baseBranch: input.taskContext.baseBranch } : {}),
    ...(input.taskContext?.prNumber !== undefined ? { contextPrNumber: input.taskContext.prNumber } : {}),
  };
}

export async function enqueueTask(
  input: EnqueueTaskRequest,
  saveTaskFile: SaveEnqueuedTaskFile,
): Promise<EnqueueTaskResult> {
  throwIfIssueEnqueueAborted(input.abortSignal);
  const saveOptions = buildEnqueuedTaskSaveOptions(input);
  const created = input.abortSignal === undefined
    ? await saveTaskFile(input.cwd, input.task, saveOptions)
    : await saveTaskFile(input.cwd, input.task, saveOptions, undefined, input.abortSignal);
  return {
    ...created,
    workflow: input.workflow,
    ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
  };
}

export async function createIssueAndEnqueueTask(
  input: IssueEnqueueTaskRequest,
  deps: IssueEnqueueDependencies,
): Promise<IssueEnqueueResult> {
  throwIfIssueEnqueueAborted(input.abortSignal);
  const issueResult = deps.createIssueFromTaskResult(input.task, {
    cwd: input.cwd,
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.explicitTitle !== undefined ? { explicitTitle: input.explicitTitle } : {}),
    outputMode: input.issueOutputMode ?? 'silent',
    gitProvider: input.gitProvider,
  });
  if (!issueResult.success) {
    if ('issueCreated' in issueResult && issueResult.issueCreated) {
      const issueUrl = normalizePublicIssueUrl(issueResult.issueUrl);
      return {
        success: false,
        failure: {
          issueCreated: true,
          taskEnqueued: false,
          stage: 'issue_number_parsing',
          ...(issueUrl !== undefined ? { issueUrl } : {}),
          error: issueResult.error,
        },
      };
    }
    return {
      success: false,
      failure: {
        issueCreated: false,
        taskEnqueued: false,
        stage: 'issue_creation',
        error: issueResult.error,
      },
    };
  }

  try {
    if (input.abortSignal !== undefined) {
      await waitForAbortSignalPropagation();
    }
    throwIfIssueEnqueueAborted(input.abortSignal);
    const created = await enqueueTask(
      {
        ...input,
        issueNumber: issueResult.issueNumber,
      },
      deps.saveTaskFile,
    );
    return { success: true, created };
  } catch (error) {
    const stage = resolveIssueEnqueueFailureStage(error);
    const issueUrl = normalizePublicIssueUrl(issueResult.issueUrl);
    return {
      success: false,
      failure: {
        issueCreated: true,
        stage,
        issueNumber: issueResult.issueNumber,
        ...(issueUrl !== undefined ? { issueUrl } : {}),
        taskEnqueued: false,
        error,
      },
    };
  }
}

/**
 * Best-effort mitigation for an abort notification racing with issue creation.
 * One macrotask yield narrows that window, but cannot observe cancellations that
 * arrive after the yield has completed.
 */
function waitForAbortSignalPropagation(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function resolveIssueEnqueueFailureStage(error: unknown): IssueEnqueueFailureStage {
  return error instanceof IssueEnqueueCancelledError
    ? 'cancelled_after_issue_creation'
    : 'task_saving';
}

export class IssueEnqueueCancelledError extends Error {
  constructor() {
    super('Task enqueue was cancelled.');
  }
}

function throwIfIssueEnqueueAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new IssueEnqueueCancelledError();
  }
}
