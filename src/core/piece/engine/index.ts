/**
 * Piece engine module.
 *
 * Re-exports the PieceEngine class and its supporting classes.
 */

export { PieceEngine } from './PieceEngine.js';
export { MovementExecutor } from './MovementExecutor.js';
export type { MovementExecutorDeps } from './MovementExecutor.js';
export { ParallelRunner } from './ParallelRunner.js';
export { ArpeggioRunner } from './ArpeggioRunner.js';
export { OptionsBuilder } from './OptionsBuilder.js';
export { CycleDetector } from './cycle-detector.js';
export type { CycleCheckResult } from './cycle-detector.js';
