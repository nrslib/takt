import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import {
  createIssueFromTask as defaultCreateIssueFromTask,
  saveTaskFile as defaultSaveTaskFile,
} from '../../features/tasks/add/index.js';
import type { AcpTaskContext } from './types.js';

type WorkflowTaskInstruction = ConversationSessionResult & {
  kind: 'workflow_execution_requested';
};

export type SaveAcpTaskFile = typeof defaultSaveTaskFile;
export type CreateAcpIssueFromTask = typeof defaultCreateIssueFromTask;

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

function buildTaskSaveOptions(input: {
  workflow: string;
  taskContext?: AcpTaskContext;
  issueNumber?: number;
}): Parameters<SaveAcpTaskFile>[2] {
  return {
    workflow: input.workflow,
    worktree: true,
    autoPr: false,
    ...(input.issueNumber !== undefined && { issue: input.issueNumber }),
    ...(input.taskContext?.branch !== undefined && { branch: input.taskContext.branch }),
    ...(input.taskContext?.baseBranch !== undefined && { baseBranch: input.taskContext.baseBranch }),
    ...(input.taskContext?.prNumber !== undefined && { prNumber: input.taskContext.prNumber }),
  };
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
  const created = await input.saveTaskFile(
    input.cwd,
    input.instruction.task,
    buildTaskSaveOptions({
      workflow: input.workflow,
      taskContext: input.taskContext,
    }),
  );
  return {
    ...created,
    workflow: input.workflow,
  };
}

export async function createIssueAndEnqueueAcpTask(input: {
  cwd: string;
  instruction: WorkflowTaskInstruction;
  workflow: string;
  saveTaskFile: SaveAcpTaskFile;
  createIssueFromTask: CreateAcpIssueFromTask;
  taskContext?: AcpTaskContext;
  abortSignal?: AbortSignal;
}): Promise<AcpEnqueueResult> {
  throwIfAbortRequested(input.abortSignal);
  const issueNumber = input.createIssueFromTask(input.instruction.task, {
    cwd: input.cwd,
    outputMode: 'silent',
  });
  if (issueNumber === undefined) {
    throw new Error('Issue creation failed');
  }
  throwIfAbortRequested(input.abortSignal);
  const created = await input.saveTaskFile(
    input.cwd,
    input.instruction.task,
    buildTaskSaveOptions({
      workflow: input.workflow,
      taskContext: input.taskContext,
      issueNumber,
    }),
  );
  return {
    ...created,
    workflow: input.workflow,
    issueNumber,
  };
}

export { defaultCreateIssueFromTask, defaultSaveTaskFile };
