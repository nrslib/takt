import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import { saveTaskFile as defaultSaveTaskFile } from '../../features/tasks/add/index.js';
import type { AcpTaskContext } from './types.js';

type WorkflowTaskInstruction = ConversationSessionResult & {
  kind: 'workflow_execution_requested';
};

export type SaveAcpTaskFile = typeof defaultSaveTaskFile;

export interface AcpEnqueueResult {
  taskName: string;
  tasksFile: string;
  workflow: string;
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
  const created = await input.saveTaskFile(input.cwd, input.instruction.task, {
    workflow: input.workflow,
    worktree: true,
    autoPr: false,
    ...(input.taskContext?.branch !== undefined && { branch: input.taskContext.branch }),
    ...(input.taskContext?.baseBranch !== undefined && { baseBranch: input.taskContext.baseBranch }),
    ...(input.taskContext?.prNumber !== undefined && { prNumber: input.taskContext.prNumber }),
  });
  return {
    ...created,
    workflow: input.workflow,
  };
}

export { defaultSaveTaskFile };
