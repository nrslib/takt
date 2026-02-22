import { join } from 'node:path';
import type { ScanConfig } from '../../features/repertoire/remove.js';

/**
 * Build a ScanConfig for tests using tempDir as the root.
 *
 * Maps the 3 spec-defined scan locations to subdirectories of tempDir,
 * enabling tests to run in isolation without touching real config paths.
 */
export function makeScanConfig(tempDir: string): ScanConfig {
  return {
    piecesDirs: [join(tempDir, 'pieces'), join(tempDir, '.takt', 'pieces')],
    categoriesFiles: [join(tempDir, 'preferences', 'piece-categories.yaml')],
  };
}
