/**
 * Piece switching command
 */

import {
  listPieceEntries,
  loadAllPiecesWithSources,
  getPieceCategories,
  buildCategorizedPieces,
  loadPiece,
  getCurrentPiece,
  setCurrentPiece,
} from '../../infra/config/index.js';
import { info, success, error } from '../../shared/ui/index.js';
import {
  warnMissingPieces,
  selectPieceFromCategorizedPieces,
  selectPieceFromEntries,
} from '../pieceSelection/index.js';

/**
 * Switch to a different piece
 * @returns true if switch was successful
 */
export async function switchPiece(cwd: string, pieceName?: string): Promise<boolean> {
  // No piece specified - show selection prompt
  if (!pieceName) {
    const current = getCurrentPiece(cwd);
    info(`Current piece: ${current}`);

    const categoryConfig = getPieceCategories();
    let selected: string | null;
    if (categoryConfig) {
      const allPieces = loadAllPiecesWithSources(cwd);
      if (allPieces.size === 0) {
        info('No pieces found.');
        selected = null;
      } else {
        const categorized = buildCategorizedPieces(allPieces, categoryConfig);
        warnMissingPieces(categorized.missingPieces);
        selected = await selectPieceFromCategorizedPieces(categorized, current);
      }
    } else {
      const entries = listPieceEntries(cwd);
      selected = await selectPieceFromEntries(entries, current);
    }

    if (!selected) {
      info('Cancelled');
      return false;
    }

    pieceName = selected;
  }

  // Check if piece exists
  const config = loadPiece(pieceName, cwd);

  if (!config) {
    error(`Piece "${pieceName}" not found`);
    return false;
  }

  // Save to project config
  setCurrentPiece(cwd, pieceName);
  success(`Switched to piece: ${pieceName}`);

  return true;
}
