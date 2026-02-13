/**
 * Piece switching command
 */

import {
  loadPiece,
  getCurrentPiece,
  setCurrentPiece,
} from '../../infra/config/index.js';
import { info, success, error } from '../../shared/ui/index.js';
import { selectPiece } from '../pieceSelection/index.js';

/**
 * Switch to a different piece
 * @returns true if switch was successful
 */
export async function switchPiece(cwd: string, pieceName?: string): Promise<boolean> {
  if (!pieceName) {
    const current = getCurrentPiece(cwd);
    info(`Current piece: ${current}`);

    const selected = await selectPiece(cwd, { fallbackToDefault: false });
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
