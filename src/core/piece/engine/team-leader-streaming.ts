import { getLabel } from '../../../shared/i18n/index.js';
import type { PieceEngineOptions } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';

export function buildTeamLeaderParallelLoggerOptions(
  engineOptions: PieceEngineOptions,
  movementName: string,
  movementIteration: number,
  subMovementNames: string[],
  iteration: number,
  maxMovements: number,
): ParallelLoggerOptions {
  const options: ParallelLoggerOptions = {
    subMovementNames,
    parentOnStream: engineOptions.onStream,
    progressInfo: { iteration, maxMovements },
  };

  if (engineOptions.taskPrefix != null && engineOptions.taskColorIndex != null) {
    return {
      ...options,
      taskLabel: engineOptions.taskPrefix,
      taskColorIndex: engineOptions.taskColorIndex,
      parentMovementName: movementName,
      movementIteration,
    };
  }

  return options;
}

export function emitTeamLeaderProgressHint(
  engineOptions: PieceEngineOptions,
  kind: 'decompose' | 'feedback',
): void {
  const onStream = engineOptions.onStream;
  if (!onStream) {
    return;
  }

  const key = kind === 'decompose'
    ? 'piece.teamLeader.decomposeWait'
    : 'piece.teamLeader.feedbackWait';
  const text = `${getLabel(key, engineOptions.language)}\n`;

  onStream({ type: 'text', data: { text } });
}
