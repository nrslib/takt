/**
 * Core type definitions for TAKT orchestration system
 *
 * This file re-exports all types from categorized sub-modules.
 * Consumers import from './types.js' — no path changes needed.
 */

// Status and classification types
export type {
  AgentType,
  Status,
  RuleMatchMethod,
  PermissionMode,
} from './status.js';

// Agent response
export type {
  AgentResponse,
} from './response.js';

// Session state (authoritative definition with createSessionState)
export type {
  SessionState,
} from './session.js';

// Piece configuration and runtime state
export type {
  PieceRule,
  OutputContractLabelPath,
  OutputContractItem,
  OutputContractEntry,
  McpServerConfig,
  PieceMovement,
  ArpeggioMovementConfig,
  ArpeggioMergeMovementConfig,
  LoopDetectionConfig,
  LoopMonitorConfig,
  LoopMonitorJudge,
  LoopMonitorRule,
  PieceConfig,
  PieceState,
} from './piece-types.js';

// Configuration types (global and project)
export type {
  CustomAgentConfig,
  DebugConfig,
  ObservabilityConfig,
  Language,
  PipelineConfig,
  GlobalConfig,
  ProjectConfig,
} from './global-config.js';
