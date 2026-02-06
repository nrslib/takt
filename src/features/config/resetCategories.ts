/**
 * Reset piece categories to builtin defaults.
 */

import { getDefaultCategoriesPath } from '../../infra/config/loaders/pieceCategories.js';
import { resetPieceCategories, getPieceCategoriesPath } from '../../infra/config/global/pieceCategories.js';
import { header, success, info } from '../../shared/ui/index.js';

export async function resetCategoriesToDefault(): Promise<void> {
  header('Reset Categories');

  const defaultPath = getDefaultCategoriesPath();
  resetPieceCategories(defaultPath);

  const userPath = getPieceCategoriesPath();
  success('Categories reset to builtin defaults.');
  info(`  ${userPath}`);
}
