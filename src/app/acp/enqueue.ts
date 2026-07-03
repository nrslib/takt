import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import { getGitProvider, initGitProvider } from '../../infra/git/index.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../../features/tasks/add/index.js';
import {
  createIssueAndEnqueueTask,
  enqueueTask,
  formatIssueEnqueueFailure,
  joinIssueEnqueueFailureText,
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
    throw new Error(joinIssueEnqueueFailureText(
      formatIssueEnqueueFailure(result.failure, safeExternalErrorMessage),
      '\n',
    ));
  }
  return result.created;
}

export { defaultCreateIssueFromTaskResult, defaultSaveTaskFile };
