/**
 * Workflow engine type definitions
 *
 * Contains types for workflow events, requests, and callbacks
 * used by the workflow execution engine.
 */

import type { WorkflowStep, AgentResponse, WorkflowState, Language } from '../models/types.js';
import type { StreamCallback } from '../agents/runner.js';
import type { PermissionHandler, AskUserQuestionHandler } from '../claude/process.js';

/** Events emitted by workflow engine */
export interface WorkflowEvents {
  'step:start': (step: WorkflowStep, iteration: number) => void;
  'step:complete': (step: WorkflowStep, response: AgentResponse, instruction: string) => void;
  'step:report': (step: WorkflowStep, filePath: string, fileName: string) => void;
  'step:blocked': (step: WorkflowStep, response: AgentResponse) => void;
  'step:user_input': (step: WorkflowStep, userInput: string) => void;
  'workflow:complete': (state: WorkflowState) => void;
  'workflow:abort': (state: WorkflowState, reason: string) => void;
  'iteration:limit': (iteration: number, maxIterations: number) => void;
  'step:loop_detected': (step: WorkflowStep, consecutiveCount: number) => void;
}

/** User input request for blocked state */
export interface UserInputRequest {
  /** The step that is blocked */
  step: WorkflowStep;
  /** The blocked response from the agent */
  response: AgentResponse;
  /** Prompt for the user (extracted from blocked message) */
  prompt: string;
}

/** Iteration limit request */
export interface IterationLimitRequest {
  /** Current iteration count */
  currentIteration: number;
  /** Current max iterations */
  maxIterations: number;
  /** Current step name */
  currentStep: string;
}

/** Callback for session updates (when agent session IDs change) */
export type SessionUpdateCallback = (agentName: string, sessionId: string) => void;

/**
 * Callback for iteration limit reached.
 * Returns the number of additional iterations to continue, or null to stop.
 */
export type IterationLimitCallback = (request: IterationLimitRequest) => Promise<number | null>;

/** Options for workflow engine */
export interface WorkflowEngineOptions {
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
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Project root directory (where .takt/ lives). Defaults to cwd if not specified. */
  projectCwd?: string;
  /** Language for instruction metadata. Defaults to 'en'. */
  language?: Language;
}

/** Loop detection result */
export interface LoopCheckResult {
  isLoop: boolean;
  count: number;
  shouldAbort: boolean;
  shouldWarn?: boolean;
}
