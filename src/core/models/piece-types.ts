import type { ProviderType } from '../../shared/types/provider.js';
import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { InteractiveMode } from './interactive-mode.js';
import type { TeamLeaderConfig } from './part.js';

export interface PieceRule {
  condition: string;
  next?: string;
  appendix?: string;
  requiresUserInput?: boolean;
  interactiveOnly?: boolean;
  isAiCondition?: boolean;
  aiConditionText?: string;
  isAggregateCondition?: boolean;
  aggregateType?: 'all' | 'any';
  aggregateConditionText?: string | string[];
}

export interface OutputContractItem {
  name: string;
  format: string;
  useJudge?: boolean;
  order?: string;
}

export type OutputContractEntry = OutputContractItem;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export interface CodexProviderOptions {
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}

export interface OpenCodeProviderOptions {
  networkAccess?: boolean;
}

export const RUNTIME_PREPARE_PRESETS = ['gradle', 'node'] as const;
export type RuntimePreparePreset = (typeof RUNTIME_PREPARE_PRESETS)[number];
export const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_VALUES)[number];
export const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_VALUES)[number];
const RUNTIME_PREPARE_PRESET_SET: ReadonlySet<string> = new Set(RUNTIME_PREPARE_PRESETS);
export function isRuntimePreparePreset(entry: string): entry is RuntimePreparePreset {
  return RUNTIME_PREPARE_PRESET_SET.has(entry);
}
export type RuntimePrepareEntry = RuntimePreparePreset | string;

export interface PieceRuntimeConfig {
  prepare?: RuntimePrepareEntry[];
}

export interface ClaudeSandboxSettings {
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
}

export interface ClaudeProviderOptions {
  allowedTools?: string[];
  effort?: ClaudeEffort;
  sandbox?: ClaudeSandboxSettings;
}

export interface MovementProviderOptions {
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  claude?: ClaudeProviderOptions;
}

export interface PieceMovement {
  name: string;
  description?: string;
  persona?: string;
  session?: 'continue' | 'refresh';
  personaDisplayName: string;
  mcpServers?: Record<string, McpServerConfig>;
  personaPath?: string;
  provider?: ProviderType;
  model?: string;
  requiredPermissionMode?: PermissionMode;
  providerOptions?: MovementProviderOptions;
  edit?: boolean;
  instruction: string;
  rules?: PieceRule[];
  outputContracts?: OutputContractEntry[];
  qualityGates?: string[];
  passPreviousResponse: boolean;
  parallel?: PieceMovement[];
  concurrency?: number;
  arpeggio?: ArpeggioMovementConfig;
  teamLeader?: TeamLeaderConfig;
  policyContents?: string[];
  knowledgeContents?: string[];
}

export interface ArpeggioMergeMovementConfig {
  readonly strategy: 'concat' | 'custom';
  readonly separator?: string;
  readonly inlineJs?: string;
  readonly file?: string;
}

export interface ArpeggioMovementConfig {
  readonly source: string;
  readonly sourcePath: string;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly templatePath: string;
  readonly merge: ArpeggioMergeMovementConfig;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly outputPath?: string;
}

export interface LoopDetectionConfig {
  maxConsecutiveSameStep?: number;
  action?: 'abort' | 'warn' | 'ignore';
}

export interface LoopMonitorRule {
  condition: string;
  next: string;
}

export interface LoopMonitorJudge {
  persona?: string;
  personaPath?: string;
  instruction?: string;
  rules: LoopMonitorRule[];
}

export interface LoopMonitorConfig {
  cycle: string[];
  threshold: number;
  judge: LoopMonitorJudge;
}

export interface PieceConfig {
  name: string;
  description?: string;
  providerOptions?: MovementProviderOptions;
  runtime?: PieceRuntimeConfig;
  personas?: Record<string, string>;
  policies?: Record<string, string>;
  knowledge?: Record<string, string>;
  instructions?: Record<string, string>;
  reportFormats?: Record<string, string>;
  movements: PieceMovement[];
  initialMovement: string;
  maxMovements: number;
  loopDetection?: LoopDetectionConfig;
  loopMonitors?: LoopMonitorConfig[];
  interactiveMode?: InteractiveMode;
  skipInteractiveModeSelection?: boolean;
}

export interface PieceState {
  pieceName: string;
  currentMovement: string;
  iteration: number;
  movementOutputs: Map<string, AgentResponse>;
  lastOutput?: AgentResponse;
  previousResponseSourcePath?: string;
  userInputs: string[];
  personaSessions: Map<string, string>;
  movementIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}
