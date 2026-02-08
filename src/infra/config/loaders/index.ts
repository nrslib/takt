/**
 * Configuration loaders - barrel exports
 */

export {
  getBuiltinPiece,
  loadPiece,
  loadPieceByIdentifier,
  isPiecePath,
  getPieceDescription,
  loadAllPieces,
  loadAllPiecesWithSources,
  listPieces,
  listPieceEntries,
  type MovementPreview,
  type PieceDirEntry,
  type PieceSource,
  type PieceWithSource,
} from './pieceLoader.js';

export {
  loadDefaultCategories,
  getDefaultCategoriesPath,
  getPieceCategories,
  buildCategorizedPieces,
  findPieceCategories,
  type CategoryConfig,
  type CategorizedPieces,
  type MissingPiece,
  type PieceCategoryNode,
} from './pieceCategories.js';

export {
  loadAgentsFromDir,
  loadCustomAgents,
  listCustomAgents,
  loadAgentPrompt,
  loadPersonaPromptFromPath,
} from './agentLoader.js';
