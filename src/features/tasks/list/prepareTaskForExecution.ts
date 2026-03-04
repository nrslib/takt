import type { TaskInfo } from '../../../infra/task/index.js';

export function prepareTaskForExecution(taskInfo: TaskInfo, selectedPiece: string): TaskInfo {
  if (!taskInfo.data) {
    throw new Error(`Task "${taskInfo.name}" is missing required data.`);
  }

  return {
    ...taskInfo,
    data: {
      ...taskInfo.data,
      piece: selectedPiece,
    },
  };
}
