/**
 * Piece configuration and runtime state types
 */

import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';

/** Rule-based transition configuration (unified format) */
export interface PieceRule {
  /** Human-readable condition text */
  condition: string;
  /** Next movement name (e.g., implement, COMPLETE, ABORT). Optional for parallel sub-movements. */
  next?: string;
  /** Template for additional AI output */
  appendix?: string;
  /** Require user input before continuing (interactive mode only) */
  requiresUserInput?: boolean;
  /** Rule applies only in interactive mode */
  interactiveOnly?: boolean;
  /** Whether this condition uses ai() expression (set by loader) */
  isAiCondition?: boolean;
  /** The condition text inside ai("...") for AI judge evaluation (set by loader) */
  aiConditionText?: string;
  /** Whether this condition uses all()/any() aggregate expression (set by loader) */
  isAggregateCondition?: boolean;
  /** Aggregate type: 'all' requires all sub-movements match, 'any' requires at least one (set by loader) */
  aggregateType?: 'all' | 'any';
  /** The condition text(s) inside all("...")/any("...") to match against sub-movement results (set by loader).
   * - string: all sub-movements must match this single condition (e.g., all("approved"))
   * - string[]: each sub-movement must match the corresponding condition by index (e.g., all("A", "B"))
   */
  aggregateConditionText?: string | string[];
}

/** Report file configuration for a piece movement (label: path pair) */
export interface ReportConfig {
  /** Display label (e.g., "Scope", "Decisions") */
  label: string;
  /** File path relative to report directory (e.g., "01-coder-scope.md") */
  path: string;
}

/** Report object configuration with order/format instructions */
export interface ReportObjectConfig {
  /** Report file name (e.g., "00-plan.md") */
  name: string;
  /** Instruction prepended before instruction_template (e.g., output destination) */
  order?: string;
  /** Instruction appended after instruction_template (e.g., output format) */
  format?: string;
}

/** Single movement in a piece */
export interface PieceMovement {
  name: string;
  /** Brief description of this movement's role in the piece */
  description?: string;
  /** Agent name, path, or inline prompt as specified in piece YAML. Undefined when movement runs without an agent. */
  agent?: string;
  /** Session handling for this movement */
  session?: 'continue' | 'refresh';
  /** Display name for the agent (shown in output). Falls back to agent basename if not specified */
  agentDisplayName: string;
  /** Allowed tools for this movement (optional, passed to agent execution) */
  allowedTools?: string[];
  /** Resolved absolute path to agent prompt file (set by loader) */
  agentPath?: string;
  /** Provider override for this movement */
  provider?: 'claude' | 'codex' | 'mock';
  /** Model override for this movement */
  model?: string;
  /** Permission mode for tool execution in this movement */
  permissionMode?: PermissionMode;
  /** Whether this movement is allowed to edit project files (true=allowed, false=prohibited, undefined=no prompt) */
  edit?: boolean;
  instructionTemplate: string;
  /** Rules for movement routing */
  rules?: PieceRule[];
  /** Report file configuration. Single string, array of label:path, or object with order/format. */
  report?: string | ReportConfig[] | ReportObjectConfig;
  passPreviousResponse: boolean;
  /** Sub-movements to execute in parallel. When set, this movement runs all sub-movements concurrently. */
  parallel?: PieceMovement[];
}

/** Loop detection configuration */
export interface LoopDetectionConfig {
  /** Maximum consecutive runs of the same step before triggering (default: 10) */
  maxConsecutiveSameStep?: number;
  /** Action to take when loop is detected (default: 'warn') */
  action?: 'abort' | 'warn' | 'ignore';
}

/** Rule for loop monitor judge decision */
export interface LoopMonitorRule {
  /** Human-readable condition text */
  condition: string;
  /** Next movement name to transition to */
  next: string;
}

/** Judge configuration for loop monitor */
export interface LoopMonitorJudge {
  /** Agent path, inline prompt, or undefined (uses default) */
  agent?: string;
  /** Resolved absolute path to agent prompt file (set by loader) */
  agentPath?: string;
  /** Custom instruction template for the judge (uses default if omitted) */
  instructionTemplate?: string;
  /** Rules for the judge's decision */
  rules: LoopMonitorRule[];
}

/** Loop monitor configuration for detecting cyclic patterns between movements */
export interface LoopMonitorConfig {
  /** Ordered list of movement names forming the cycle to detect */
  cycle: string[];
  /** Number of complete cycles before triggering the judge (default: 3) */
  threshold: number;
  /** Judge configuration for deciding what to do when threshold is reached */
  judge: LoopMonitorJudge;
}

/** Piece configuration */
export interface PieceConfig {
  name: string;
  description?: string;
  movements: PieceMovement[];
  initialMovement: string;
  maxIterations: number;
  /** Loop detection settings */
  loopDetection?: LoopDetectionConfig;
  /** Loop monitors for detecting cyclic patterns between movements */
  loopMonitors?: LoopMonitorConfig[];
  /**
   * Agent to use for answering AskUserQuestion prompts automatically.
   * When specified, questions from Claude Code are routed to this agent
   * instead of prompting the user interactively.
   */
  answerAgent?: string;
}

/** Runtime state of a piece execution */
export interface PieceState {
  pieceName: string;
  currentMovement: string;
  iteration: number;
  movementOutputs: Map<string, AgentResponse>;
  /** Most recent movement output (used for Previous Response injection) */
  lastOutput?: AgentResponse;
  userInputs: string[];
  agentSessions: Map<string, string>;
  /** Per-movement iteration counters (how many times each movement has been executed) */
  movementIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}
