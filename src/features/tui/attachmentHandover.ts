import type { InteractiveModeResult } from '../interactive/interactive.js';

/**
 * Hands the pasted images to the caller together with the safety net.
 *
 * The run is over, but the files are not: the caller still puts them through a
 * label selector and a workflow, and those can end the process on Ctrl+C. The
 * net therefore stays armed until the caller's own attachment cleanup runs,
 * which is the moment the files stop being needed. With nothing pasted there is
 * no cleanup to wait for, so the net comes down straight away.
 */
export function handOverAttachments(
  result: InteractiveModeResult,
  releaseExitCleanup: () => void,
): InteractiveModeResult {
  const cleanupAttachments = result.cleanupAttachments;
  if (cleanupAttachments === undefined) {
    releaseExitCleanup();
    return result;
  }
  let released = false;
  return {
    ...result,
    cleanupAttachments: () => {
      try {
        cleanupAttachments();
      } finally {
        // A caller that cleans up twice must not take the net down twice.
        if (!released) {
          released = true;
          releaseExitCleanup();
        }
      }
    },
  };
}
