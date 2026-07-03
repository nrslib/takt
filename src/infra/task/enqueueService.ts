import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloseIssueResult, GitProvider } from '../git/index.js';
import { generateReportDir } from '../../shared/utils/index.js';

export type IssueEnqueueGitProvider = Pick<GitProvider, 'createIssue' | 'closeIssue'>;

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
) => Promise<{ taskName: string; tasksFile: string }>;

export type CreateEnqueueIssueFromTaskResult = (
  task: string,
  options?: {
    labels?: string[];
    cwd?: string;
    title?: string;
    outputMode?: 'terminal' | 'silent';
    gitProvider?: Pick<IssueEnqueueGitProvider, 'createIssue'>;
  },
) => { success: true; issueNumber: number } | { success: false; error: string };

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
}

export interface IssueEnqueueTaskRequest extends EnqueueTaskRequest {
  labels?: string[];
  title?: string;
  gitProvider: IssueEnqueueGitProvider;
  abortSignal?: AbortSignal;
  issueOutputMode?: 'terminal' | 'silent';
}

export interface IssueEnqueueCompensationInput {
  cwd: string;
  gitProvider: IssueEnqueueGitProvider;
  issueNumber: number;
  stage: IssueEnqueueCompensationStage;
}

export interface IssueEnqueueDependencies {
  saveTaskFile: SaveEnqueuedTaskFile;
  createIssueFromTaskResult: CreateEnqueueIssueFromTaskResult;
  compensateCreatedIssue?: (input: IssueEnqueueCompensationInput) => CloseIssueResult;
}

export type EnqueueTaskResult = Awaited<ReturnType<SaveEnqueuedTaskFile>> & {
  workflow: string;
  issueNumber?: number;
};

export type IssueEnqueueFailure =
  | { stage: 'issue_creation'; error: string }
  | {
    stage: IssueEnqueueCompensationStage;
    issueNumber: number;
    error: unknown;
    compensation: CloseIssueResult;
  };

export type IssueEnqueueCompensationStage = 'task_saving' | 'cancelled_after_issue_creation';

export type IssueEnqueueResult =
  | { success: true; created: EnqueueTaskResult }
  | { success: false; failure: IssueEnqueueFailure };

export interface FormattedIssueEnqueueFailure {
  primary: string;
  compensationFailure?: string;
}

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
): FormattedIssueEnqueueFailure {
  if (failure.stage === 'issue_creation') {
    return { primary: formatError(failure.error) };
  }
  if (failure.stage === 'cancelled_after_issue_creation') {
    if (failure.compensation.success) {
      return {
        primary: `Issue #${failure.issueNumber} was created and closed because task enqueue was cancelled`,
      };
    }
    return {
      primary: `Issue #${failure.issueNumber} was created, but task enqueue was cancelled`,
      compensationFailure: formatIssueCloseFailure(failure.compensation, formatError),
    };
  }
  if (failure.compensation.success) {
    return {
      primary: `Issue #${failure.issueNumber} was created and closed because task saving failed: ${formatError(failure.error)}`,
    };
  }
  return {
    primary: `Issue #${failure.issueNumber} was created, but task saving failed: ${formatError(failure.error)}`,
    compensationFailure: formatIssueCloseFailure(failure.compensation, formatError),
  };
}

export function joinIssueEnqueueFailureText(
  formatted: FormattedIssueEnqueueFailure,
  separator: string,
): string {
  return formatted.compensationFailure === undefined
    ? formatted.primary
    : `${formatted.primary}${separator}${formatted.compensationFailure}`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function formatIssueCloseFailure(
  compensation: Extract<CloseIssueResult, { success: false }>,
  formatError: (error: unknown) => string,
): string {
  return compensation.commentCreated === true
    ? `Issue compensation comment was created, but issue close failed: ${formatError(compensation.error)}`
    : `Issue close failed: ${formatError(compensation.error)}`;
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
  const created = await saveTaskFile(
    input.cwd,
    input.task,
    buildEnqueuedTaskSaveOptions(input),
  );
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
    outputMode: input.issueOutputMode ?? 'silent',
    gitProvider: input.gitProvider,
  });
  if (!issueResult.success) {
    return { success: false, failure: { stage: 'issue_creation', error: issueResult.error } };
  }

  try {
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
    const compensate = deps.compensateCreatedIssue ?? closeCreatedIssueForFailedTaskSave;
    const compensation = compensate({
      cwd: input.cwd,
      gitProvider: input.gitProvider,
      issueNumber: issueResult.issueNumber,
      stage,
    });
    return {
      success: false,
      failure: {
        stage,
        issueNumber: issueResult.issueNumber,
        error,
        compensation,
      },
    };
  }
}

function resolveIssueEnqueueFailureStage(error: unknown): IssueEnqueueCompensationStage {
  return error instanceof IssueEnqueueCancelledError
    ? 'cancelled_after_issue_creation'
    : 'task_saving';
}

export class IssueEnqueueCancelledError extends Error {
  constructor() {
    super('Task enqueue was cancelled after issue creation.');
  }
}

function throwIfIssueEnqueueAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new IssueEnqueueCancelledError();
  }
}

function buildIssueEnqueueCompensationComment(stage: IssueEnqueueCompensationStage): string {
  switch (stage) {
    case 'cancelled_after_issue_creation':
      return [
        'TAKT created this issue, but task enqueue was cancelled before saving the pending task.',
        '',
        'The issue is being closed to keep the repository state consistent.',
      ].join('\n');
    case 'task_saving':
      return [
        'TAKT created this issue, but saving the pending task failed.',
        '',
        'The issue is being closed to keep the repository state consistent.',
      ].join('\n');
  }
}

function closeCreatedIssueForFailedTaskSave(input: IssueEnqueueCompensationInput): CloseIssueResult {
  return input.gitProvider.closeIssue(
    input.issueNumber,
    buildIssueEnqueueCompensationComment(input.stage),
    input.cwd,
  );
}
