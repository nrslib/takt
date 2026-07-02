import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import { getGitProvider, initGitProvider, type CloseIssueResult } from '../../infra/git/index.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../../features/tasks/add/index.js';
import {
  createIssueAndEnqueueTask,
  enqueueTask,
  type IssueEnqueueFailure,
} from '../../infra/task/enqueueService.js';
import type { AcpTaskContext } from './types.js';

type WorkflowTaskInstruction = ConversationSessionResult & {
  kind: 'workflow_execution_requested';
};

export type SaveAcpTaskFile = typeof defaultSaveTaskFile;
export type CreateAcpIssueFromTaskResult = typeof defaultCreateIssueFromTaskResult;

export interface AcpEnqueueResult {
  taskName: string;
  tasksFile: string;
  workflow: string;
  issueNumber?: number;
}

function throwIfAbortRequested(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new Error('ACP session was cancelled');
  }
}

export async function enqueueAcpTask(input: {
  cwd: string;
  instruction: WorkflowTaskInstruction;
  workflow: string;
  saveTaskFile: SaveAcpTaskFile;
  taskContext?: AcpTaskContext;
  abortSignal?: AbortSignal;
}): Promise<AcpEnqueueResult> {
  throwIfAbortRequested(input.abortSignal);
  return enqueueTask({
    cwd: input.cwd,
    task: input.instruction.task,
    workflow: input.workflow,
    worktree: true,
    autoPr: false,
    taskContext: input.taskContext,
  }, input.saveTaskFile);
}

function formatIssueEnqueueFailure(failure: IssueEnqueueFailure): string {
  if (failure.stage === 'issue_creation') {
    return safeExternalErrorMessage(failure.error);
  }
  if (failure.stage === 'cancelled_after_issue_creation') {
    if (failure.compensation.success) {
      return `Issue #${failure.issueNumber} was created and closed because task enqueue was cancelled`;
    }
    return [
      `Issue #${failure.issueNumber} was created, but task enqueue was cancelled`,
      formatIssueCloseFailure(failure.compensation),
    ].join('\n');
  }
  if (failure.compensation.success) {
    return `Issue #${failure.issueNumber} was created and closed because task saving failed: ${safeExternalErrorMessage(failure.error)}`;
  }
  return [
    `Issue #${failure.issueNumber} was created, but task saving failed: ${safeExternalErrorMessage(failure.error)}`,
    formatIssueCloseFailure(failure.compensation),
  ].join('\n');
}

function formatIssueCloseFailure(compensation: Extract<CloseIssueResult, { success: false }>): string {
  return compensation.commentCreated === true
    ? `Issue compensation comment was created, but issue close failed: ${safeExternalErrorMessage(compensation.error)}`
    : `Issue close failed: ${safeExternalErrorMessage(compensation.error)}`;
}

export async function createIssueAndEnqueueAcpTask(input: {
  cwd: string;
  instruction: WorkflowTaskInstruction;
  workflow: string;
  saveTaskFile: SaveAcpTaskFile;
  createIssueFromTaskResult?: CreateAcpIssueFromTaskResult;
  taskContext?: AcpTaskContext;
  abortSignal?: AbortSignal;
}): Promise<AcpEnqueueResult> {
  throwIfAbortRequested(input.abortSignal);
  initGitProvider(input.cwd);
  const gitProvider = getGitProvider();
  throwIfAbortRequested(input.abortSignal);
  const result = await createIssueAndEnqueueTask({
    cwd: input.cwd,
    task: input.instruction.task,
    workflow: input.workflow,
    worktree: true,
    autoPr: false,
    taskContext: input.taskContext,
    gitProvider,
    abortSignal: input.abortSignal,
  }, {
    saveTaskFile: input.saveTaskFile,
    createIssueFromTaskResult: input.createIssueFromTaskResult ?? defaultCreateIssueFromTaskResult,
  });
  if (!result.success) {
    throw new Error(formatIssueEnqueueFailure(result.failure));
  }
  return result.created;
}

export { defaultCreateIssueFromTaskResult, defaultSaveTaskFile };
