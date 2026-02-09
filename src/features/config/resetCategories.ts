/**
 * Reset user piece categories overlay.
 */

import { resetPieceCategories, getPieceCategoriesPath } from '../../infra/config/global/pieceCategories.js';
import { header, success, info } from '../../shared/ui/index.js';

export async function resetCategoriesToDefault(): Promise<void> {
  header('Reset Categories');

  resetPieceCategories();

  const userPath = getPieceCategoriesPath();
  success('User category overlay reset.');
  info(`  ${userPath}`);
}
