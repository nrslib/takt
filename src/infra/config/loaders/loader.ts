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
  loadAgentPromptFromPath,
} from './agentLoader.js';

// Global configuration
export {
  loadGlobalConfig,
  saveGlobalConfig,
  invalidateGlobalConfigCache,
  loadProjectDebugConfig,
  getEffectiveDebugConfig,
} from '../global/globalConfig.js';
