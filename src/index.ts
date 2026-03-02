/**
 * TAKT - TAKT Agent Koordination Topology
 *
 * This module exports the public API for programmatic usage.
 */

// Models
export type {
  Status,
  PieceRule,
  PieceMovement,
  PieceConfig,
  PieceState,
  Language,
  PartDefinition,
  PartResult,
} from './core/models/types.js';

// Configuration
export {
  loadPiece,
  loadPieceByIdentifier,
  listPieces,
  listPieceEntries,
  loadAllPieces,
  loadAllPiecesWithSources,
  getPieceDescription,
  getBuiltinPiece,
  isPiecePath,
} from './infra/config/loaders/index.js';
export type { PieceSource, PieceWithSource, PieceDirEntry } from './infra/config/loaders/index.js';
export {
  saveProjectConfig,
  updateProjectConfig,
  setCurrentPiece,
  isVerboseMode,
  type ProjectLocalConfig,
} from './infra/config/project/index.js';

// Piece engine
export {
  PieceEngine,
  isOutputContractItem,
} from './core/piece/index.js';
export type {
  PieceEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  PieceEngineOptions,
  ProviderType,
} from './core/piece/index.js';

// Agent usecases
export {
  executeAgent,
  generateReport,
  executePart,
  judgeStatus,
  evaluateCondition,
  decomposeTask,
} from './agents/agent-usecases.js';
export type { JudgeStatusResult } from './agents/agent-usecases.js';
