export const TASK_EXECUTION_ABORTED_MESSAGE = 'Task execution aborted';

export function isTaskAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === TASK_EXECUTION_ABORTED_MESSAGE;
}
