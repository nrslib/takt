import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { writeLoopAnalysisPublicationMarker } from './loopAnalysisJob.js';

const log = createLogger('loopAnalysisPublication');

export interface LoopAnalysisPublicationCoordinator {
  readonly branch: string;
  register(markerPath: string): void;
  settle(): void;
}

export function createLoopAnalysisPublicationCoordinator(
  branch: string,
): LoopAnalysisPublicationCoordinator {
  if (branch.trim().length === 0) {
    throw new Error('Loop analysis publication branch must be non-empty');
  }
  let markerPath: string | undefined;
  let settled = false;

  return {
    branch,
    register(path): void {
      if (markerPath !== undefined) {
        throw new Error('Loop analysis publication coordinator is already registered');
      }
      markerPath = path;
      writeLoopAnalysisPublicationMarker(path, 'pending');
      if (settled) {
        writeLoopAnalysisPublicationMarker(path, 'settled');
      }
    },
    settle(): void {
      settled = true;
      if (markerPath !== undefined) {
        writeLoopAnalysisPublicationMarker(markerPath, 'settled');
      }
    },
  };
}

export function settleLoopAnalysisPublication(
  coordinator: LoopAnalysisPublicationCoordinator | undefined,
): void {
  if (coordinator === undefined) {
    return;
  }
  try {
    coordinator.settle();
  } catch (error) {
    log.error('Loop analysis publication settlement failed', {
      branch: coordinator.branch,
      error: getErrorMessage(error),
    });
  }
}
