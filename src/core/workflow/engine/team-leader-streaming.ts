import { getLabel } from '../../../shared/i18n/index.js';
import type { WorkflowEngineOptions } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';
import type { WorkflowMaxSteps } from '../../models/types.js';

export function buildTeamLeaderParallelLoggerOptions(
  engineOptions: WorkflowEngineOptions,
  stepName: string,
  stepIteration: number,
  subStepNames: string[],
  iteration: number,
  maxSteps: WorkflowMaxSteps,
): ParallelLoggerOptions {
  const options: ParallelLoggerOptions = {
    subStepNames,
    parentOnStream: engineOptions.onStream,
    progressInfo: { iteration, maxSteps },
  };

  if (engineOptions.taskPrefix != null && engineOptions.taskColorIndex != null) {
    return {
      ...options,
      taskLabel: engineOptions.taskPrefix,
      taskColorIndex: engineOptions.taskColorIndex,
      parentStepName: stepName,
      stepIteration,
    };
  }

  return options;
}

export function emitTeamLeaderProgressHint(
  engineOptions: WorkflowEngineOptions,
  kind: 'decompose' | 'feedback',
): void {
  const onStream = engineOptions.onStream;
  if (!onStream) {
    return;
  }

  const key = kind === 'decompose'
    ? 'workflow.teamLeader.decomposeWait'
    : 'workflow.teamLeader.feedbackWait';
  const text = `${getLabel(key, engineOptions.language)}\n`;

  onStream({ type: 'text', data: { text } });
}
