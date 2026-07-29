import { join } from 'node:path';
import type { ScanConfig } from '../../features/repertoire/remove.js';

/**
 * Build a ScanConfig for tests using tempDir as the root.
 *
 * Maps the scan locations to subdirectories of tempDir,
 * enabling tests to run in isolation without touching real config paths.
 */
export function makeScanConfig(tempDir: string): ScanConfig {
  return {
    workflowDirs: [join(tempDir, 'workflows'), join(tempDir, '.takt', 'workflows')],
    providerOptionsDirs: [join(tempDir, 'provider-options'), join(tempDir, '.takt', 'provider-options')],
    stepsDirs: [join(tempDir, 'steps'), join(tempDir, '.takt', 'steps')],
    categoriesFiles: [join(tempDir, 'preferences', 'workflow-categories.yaml')],
  };
}

export async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected action to reject');
}
