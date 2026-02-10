/**
 * Piece module public API
 *
 * This file exports all public types, functions, and classes
 * from the piece module.
 */

// Main engine
export { PieceEngine } from './engine/index.js';

// Constants
export { COMPLETE_MOVEMENT, ABORT_MOVEMENT, ERROR_MESSAGES } from './constants.js';

// Types
export type {
  PieceEvents,
  PhaseName,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  PieceEngineOptions,
  LoopCheckResult,
  StreamEvent,
  StreamCallback,
  PermissionHandler,
  PermissionResult,
  AskUserQuestionHandler,
  ProviderType,
} from './types.js';

// Transitions (engine/)
export { determineNextMovementByRules, extractBlockedPrompt } from './engine/transitions.js';

// Loop detection (engine/)
export { LoopDetector } from './engine/loop-detector.js';

// Cycle detection (engine/)
export { CycleDetector, type CycleCheckResult } from './engine/cycle-detector.js';

// State management (engine/)
export {
  createInitialState,
  addUserInput,
  getPreviousOutput,
  incrementMovementIteration,
} from './engine/state-manager.js';

// Blocked handling (engine/)
export { handleBlocked, type BlockedHandlerResult } from './engine/blocked-handler.js';

// Parallel logger (engine/)
export { ParallelLogger } from './engine/parallel-logger.js';

// Instruction building
export { InstructionBuilder, isOutputContractItem } from './instruction/InstructionBuilder.js';
export { ReportInstructionBuilder, type ReportInstructionContext } from './instruction/ReportInstructionBuilder.js';
export { StatusJudgmentBuilder, type StatusJudgmentContext } from './instruction/StatusJudgmentBuilder.js';
export { buildEditRule, type InstructionContext } from './instruction/instruction-context.js';
export { generateStatusRulesComponents, type StatusRulesComponents } from './instruction/status-rules.js';

// Rule evaluation
export { RuleEvaluator, type RuleMatch, type RuleEvaluatorContext, detectMatchedRule, evaluateAggregateConditions } from './evaluation/index.js';
export { AggregateEvaluator } from './evaluation/AggregateEvaluator.js';

// Phase runner
export { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase, type ReportPhaseBlockedResult } from './phase-runner.js';
