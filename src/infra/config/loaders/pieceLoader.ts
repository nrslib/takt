/**
 * Piece configuration loader — re-export hub.
 *
 * Implementations have been split into:
 * - pieceParser.ts: YAML parsing, step/rule normalization
 * - pieceResolver.ts: 3-layer resolution (builtin → user → project-local)
 */

// Parser exports
export { normalizePieceConfig, loadPieceFromFile } from './pieceParser.js';

// Resolver exports (public API)
export {
  getBuiltinPiece,
  loadPiece,
  isPiecePath,
  loadPieceByIdentifier,
  getPieceDescription,
  loadAllPieces,
  loadAllPiecesWithSources,
  listPieces,
  listPieceEntries,
  type MovementPreview,
  type PieceDirEntry,
  type PieceSource,
  type PieceWithSource,
} from './pieceResolver.js';
