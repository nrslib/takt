/**
 * Piece configuration and runtime state types
 */

import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { InteractiveMode } from './interactive-mode.js';

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

/** Output contract configuration (label: path pair format) */
export interface OutputContractLabelPath {
  /** Display label (e.g., "Scope", "Decisions") */
  label: string;
  /** File path relative to report directory (e.g., "01-coder-scope.md") */
  path: string;
}

/** Output contract item configuration with order/format instructions */
export interface OutputContractItem {
  /** Report file name (e.g., "00-plan.md") */
  name: string;
  /** Instruction prepended before instruction_template (e.g., output destination) */
  order?: string;
  /** Instruction appended after instruction_template (e.g., output format) - resolved from report_formats */
  format?: string;
}

/** Union type for output contract entries */
export type OutputContractEntry = OutputContractLabelPath | OutputContractItem;

/** MCP server configuration for stdio transport */
export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP server configuration for SSE transport */
export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** MCP server configuration for HTTP transport */
export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** MCP server configuration (union of all YAML-configurable transports) */
export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

/** Single movement in a piece */
export interface PieceMovement {
  name: string;
  /** Brief description of this movement's role in the piece */
  description?: string;
  /** Resolved persona spec (file path or inline prompt). Set from persona field in YAML. */
  persona?: string;
  /** Session handling for this movement */
  session?: 'continue' | 'refresh';
  /** Display name for the persona (shown in output). Falls back to persona basename if not specified */
  personaDisplayName: string;
  /** Allowed tools for this movement (optional, passed to agent execution) */
  allowedTools?: string[];
  /** MCP servers configuration for this movement */
  mcpServers?: Record<string, McpServerConfig>;
  /** Resolved absolute path to persona prompt file (set by loader) */
  personaPath?: string;
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
  /** Output contracts for this movement (report definitions) */
  outputContracts?: OutputContractEntry[];
  /** Quality gates for this movement (AI directives for completion requirements) */
  qualityGates?: string[];
  passPreviousResponse: boolean;
  /** Sub-movements to execute in parallel. When set, this movement runs all sub-movements concurrently. */
  parallel?: PieceMovement[];
  /** Arpeggio configuration for data-driven batch processing. When set, this movement reads from a data source, expands templates, and calls LLM per batch. */
  arpeggio?: ArpeggioMovementConfig;
  /** Resolved policy content strings (from piece-level policies map, resolved at parse time) */
  policyContents?: string[];
  /** Resolved knowledge content strings (from piece-level knowledge map, resolved at parse time) */
  knowledgeContents?: string[];
}

/** Merge configuration for arpeggio results */
export interface ArpeggioMergeMovementConfig {
  /** Merge strategy: 'concat' (default), 'custom' */
  readonly strategy: 'concat' | 'custom';
  /** Inline JS merge function body (for custom strategy) */
  readonly inlineJs?: string;
  /** Path to external JS merge file (for custom strategy, resolved to absolute) */
  readonly filePath?: string;
  /** Separator for concat strategy (default: '\n') */
  readonly separator?: string;
}

/** Arpeggio configuration for data-driven batch processing movements */
export interface ArpeggioMovementConfig {
  /** Data source type (e.g., 'csv') */
  readonly source: string;
  /** Path to the data source file (resolved to absolute) */
  readonly sourcePath: string;
  /** Number of rows per batch (default: 1) */
  readonly batchSize: number;
  /** Number of concurrent LLM calls (default: 1) */
  readonly concurrency: number;
  /** Path to prompt template file (resolved to absolute) */
  readonly templatePath: string;
  /** Merge configuration */
  readonly merge: ArpeggioMergeMovementConfig;
  /** Maximum retry attempts per batch (default: 2) */
  readonly maxRetries: number;
  /** Delay between retries in ms (default: 1000) */
  readonly retryDelayMs: number;
  /** Optional output file path (resolved to absolute) */
  readonly outputPath?: string;
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
  /** Persona spec (file path or inline prompt), resolved from persona field */
  persona?: string;
  /** Resolved absolute path to persona prompt file (set by loader) */
  personaPath?: string;
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
  /** Persona definitions — map of name to file path or inline content (raw, not content-resolved) */
  personas?: Record<string, string>;
  /** Resolved policy definitions — map of name to file content (resolved at parse time) */
  policies?: Record<string, string>;
  /** Resolved knowledge definitions — map of name to file content (resolved at parse time) */
  knowledge?: Record<string, string>;
  /** Resolved instruction definitions — map of name to file content (resolved at parse time) */
  instructions?: Record<string, string>;
  /** Resolved report format definitions — map of name to file content (resolved at parse time) */
  reportFormats?: Record<string, string>;
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
  /** Default interactive mode for this piece (overrides user default) */
  interactiveMode?: InteractiveMode;
}

/** Runtime state of a piece execution */
export interface PieceState {
  pieceName: string;
  currentMovement: string;
  iteration: number;
  movementOutputs: Map<string, AgentResponse>;
  /** Most recent movement output (used for Previous Response injection) */
  lastOutput?: AgentResponse;
  /** Source path of the latest previous response snapshot */
  previousResponseSourcePath?: string;
  userInputs: string[];
  personaSessions: Map<string, string>;
  /** Per-movement iteration counters (how many times each movement has been executed) */
  movementIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}
