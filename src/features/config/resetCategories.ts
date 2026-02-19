/**
 * Reset user piece categories overlay.
 */

import { resetPieceCategories, getPieceCategoriesPath } from '../../infra/config/global/pieceCategories.js';
import { header, success, info } from '../../shared/ui/index.js';

export async function resetCategoriesToDefault(cwd: string): Promise<void> {
  header('Reset Categories');

  resetPieceCategories(cwd);

  const userPath = getPieceCategoriesPath(cwd);
  success('User category overlay reset.');
  info(`  ${userPath}`);
}
