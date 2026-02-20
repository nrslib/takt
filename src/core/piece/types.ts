/**
 * Piece engine type definitions
 *
 * Contains types for piece events, requests, and callbacks
 * used by the piece execution engine.
 */

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PieceMovement, AgentResponse, PieceState, Language, LoopMonitorConfig } from '../models/types.js';
import type { PersonaProviderEntry } from '../models/persisted-global-config.js';
import type { ProviderPermissionProfiles } from '../models/provider-profiles.js';
import type { MovementProviderOptions } from '../models/piece-types.js';

export type ProviderType = 'claude' | 'codex' | 'opencode' | 'mock';
export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';

export interface StreamInitEventData {
  model: string;
  sessionId: string;
}

export interface StreamToolUseEventData {
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface StreamToolResultEventData {
  content: string;
  isError: boolean;
}

export interface StreamToolOutputEventData {
  tool: string;
  output: string;
}

export interface StreamTextEventData {
  text: string;
}

export interface StreamThinkingEventData {
  thinking: string;
}

export interface StreamResultEventData {
  result: string;
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface StreamErrorEventData {
  message: string;
  raw?: string;
}

export type StreamEvent =
  | { type: 'init'; data: StreamInitEventData }
  | { type: 'tool_use'; data: StreamToolUseEventData }
  | { type: 'tool_result'; data: StreamToolResultEventData }
  | { type: 'tool_output'; data: StreamToolOutputEventData }
  | { type: 'text'; data: StreamTextEventData }
  | { type: 'thinking'; data: StreamThinkingEventData }
  | { type: 'result'; data: StreamResultEventData }
  | { type: 'error'; data: StreamErrorEventData };

export type StreamCallback = (event: StreamEvent) => void;

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

export type { PermissionResult, PermissionUpdate };

export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionResult>;

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

export type AskUserQuestionHandler = (
  input: AskUserQuestionInput
) => Promise<Record<string, string>>;

export type RuleIndexDetector = (content: string, movementName: string) => number;

export interface AiJudgeCondition {
  index: number;
  text: string;
}

export type AiJudgeCaller = (
  agentOutput: string,
  conditions: AiJudgeCondition[],
  options: { cwd: string }
) => Promise<number>;

export type PhaseName = 'execute' | 'report' | 'judge';

/** Events emitted by piece engine */
export interface PieceEvents {
  'movement:start': (step: PieceMovement, iteration: number, instruction: string) => void;
  'movement:complete': (step: PieceMovement, response: AgentResponse, instruction: string) => void;
  'movement:report': (step: PieceMovement, filePath: string, fileName: string) => void;
  'movement:blocked': (step: PieceMovement, response: AgentResponse) => void;
  'movement:user_input': (step: PieceMovement, userInput: string) => void;
  'phase:start': (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  'phase:complete': (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
  'piece:complete': (state: PieceState) => void;
  'piece:abort': (state: PieceState, reason: string) => void;
  'iteration:limit': (iteration: number, maxMovements: number) => void;
  'movement:loop_detected': (step: PieceMovement, consecutiveCount: number) => void;
  'movement:cycle_detected': (monitor: LoopMonitorConfig, cycleCount: number) => void;
}

/** User input request for blocked state */
export interface UserInputRequest {
  /** The movement that is blocked */
  movement: PieceMovement;
  /** The blocked response from the agent */
  response: AgentResponse;
  /** Prompt for the user (extracted from blocked message) */
  prompt: string;
}

/** Iteration limit request */
export interface IterationLimitRequest {
  /** Current iteration count */
  currentIteration: number;
  /** Current max movements */
  maxMovements: number;
  /** Current movement name */
  currentMovement: string;
}

/** Callback for session updates (when persona session IDs change) */
export type SessionUpdateCallback = (persona: string, sessionId: string) => void;

/**
 * Callback for iteration limit reached.
 * Returns the number of additional iterations to continue, or null to stop.
 */
export type IterationLimitCallback = (request: IterationLimitRequest) => Promise<number | null>;

/** Options for piece engine */
export interface PieceEngineOptions {
  abortSignal?: AbortSignal;
  /** Callback for streaming real-time output */
  onStream?: StreamCallback;
  /** Callback for requesting user input when an agent is blocked */
  onUserInput?: (request: UserInputRequest) => Promise<string | null>;
  /** Initial agent sessions to restore (agent name -> session ID) */
  initialSessions?: Record<string, string>;
  /** Callback when agent session ID is updated */
  onSessionUpdate?: SessionUpdateCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Initial user inputs to share with all agents */
  initialUserInputs?: string[];
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Callback when iteration limit is reached - returns additional iterations or null to stop */
  onIterationLimit?: IterationLimitCallback;
  /** Bypass all permission checks */
  bypassPermissions?: boolean;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Language for instruction metadata. Defaults to 'en'. */
  language?: Language;
  provider?: ProviderType;
  model?: string;
  /** Resolved provider options */
  providerOptions?: MovementProviderOptions;
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Resolved provider permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Enable interactive-only rules and user-input transitions */
  interactive?: boolean;
  /** Rule tag index detector (required for rules evaluation) */
  detectRuleIndex?: RuleIndexDetector;
  /** AI judge caller (required for rules evaluation) */
  callAiJudge?: AiJudgeCaller;
  /** Override initial movement (default: piece config's initialMovement) */
  startMovement?: string;
  /** Retry note explaining why task is being retried */
  retryNote?: string;
  /** Override report directory name (without parent path). */
  reportDirName?: string;
  /** Task name prefix for parallel task execution output */
  taskPrefix?: string;
  /** Color index for task prefix (cycled across tasks) */
  taskColorIndex?: number;
}

/** Loop detection result */
export interface LoopCheckResult {
  isLoop: boolean;
  count: number;
  shouldAbort: boolean;
  shouldWarn?: boolean;
}
