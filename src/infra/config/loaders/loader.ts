/**
 * Configuration loader for takt
 *
 * Re-exports from specialized loaders.
 */

// Piece loading
export {
  getBuiltinPiece,
  loadPiece,
  loadPieceByIdentifier,
  isPiecePath,
  loadAllPieces,
  listPieces,
} from './pieceLoader.js';

// Agent loading
export {
  loadAgentsFromDir,
  loadCustomAgents,
  listCustomAgents,
  loadAgentPrompt,
  loadPersonaPromptFromPath,
} from './agentLoader.js';

// Global configuration
export {
  loadGlobalConfig,
  saveGlobalConfig,
  invalidateGlobalConfigCache,
} from '../global/globalConfig.js';
