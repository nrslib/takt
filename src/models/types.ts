/**
 * Core type definitions for TAKT orchestration system
 */

/** Built-in agent types */
export type AgentType = 'coder' | 'architect' | 'supervisor' | 'custom';

/** Execution status for agents and workflows */
export type Status =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'approved'
  | 'rejected'
  | 'improve'
  | 'cancelled'
  | 'interrupted';

/** Condition types for workflow transitions */
export type TransitionCondition =
  | 'done'
  | 'blocked'
  | 'approved'
  | 'rejected'
  | 'improve'
  | 'always';

/** Response from an agent execution */
export interface AgentResponse {
  agent: string;
  status: Status;
  content: string;
  timestamp: Date;
  sessionId?: string;
}

/** Session state for workflow execution */
export interface SessionState {
  task: string;
  projectDir: string;
  iterations: number;
  history: AgentResponse[];
  context: Record<string, string>;
}

/** Workflow step transition configuration */
export interface WorkflowTransition {
  condition: TransitionCondition;
  nextStep: string;
}

/** Behavior when no status marker is found in agent output */
export type OnNoStatusBehavior = 'complete' | 'continue' | 'stay';

/** Single step in a workflow */
export interface WorkflowStep {
  name: string;
  /** Agent name or path as specified in workflow YAML */
  agent: string;
  /** Display name for the agent (shown in output). Falls back to agent basename if not specified */
  agentDisplayName: string;
  /** Allowed tools for this step (optional, passed to agent execution) */
  allowedTools?: string[];
  /** Resolved absolute path to agent prompt file (set by loader) */
  agentPath?: string;
  /** Provider override for this step */
  provider?: 'claude' | 'codex';
  /** Model override for this step */
  model?: string;
  instructionTemplate: string;
  transitions: WorkflowTransition[];
  passPreviousResponse: boolean;
  /**
   * Behavior when agent doesn't output a status marker (in_progress).
   * - 'complete': Treat as done, follow done/always transition or complete workflow (default)
   * - 'continue': Treat as done, follow done/always transition or move to next step
   * - 'stay': Stay on current step (may cause loops, use with caution)
   */
  onNoStatus?: OnNoStatusBehavior;
}

/** Loop detection configuration */
export interface LoopDetectionConfig {
  /** Maximum consecutive runs of the same step before triggering (default: 10) */
  maxConsecutiveSameStep?: number;
  /** Action to take when loop is detected (default: 'warn') */
  action?: 'abort' | 'warn' | 'ignore';
}

/** Workflow configuration */
export interface WorkflowConfig {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  initialStep: string;
  maxIterations: number;
  /** Loop detection settings */
  loopDetection?: LoopDetectionConfig;
  /**
   * Agent to use for answering AskUserQuestion prompts automatically.
   * When specified, questions from Claude Code are routed to this agent
   * instead of prompting the user interactively.
   */
  answerAgent?: string;
}

/** Runtime state of a workflow execution */
export interface WorkflowState {
  workflowName: string;
  currentStep: string;
  iteration: number;
  stepOutputs: Map<string, AgentResponse>;
  userInputs: string[];
  agentSessions: Map<string, string>;
  status: 'running' | 'completed' | 'aborted';
}

/** Custom agent configuration */
export interface CustomAgentConfig {
  name: string;
  promptFile?: string;
  prompt?: string;
  allowedTools?: string[];
  statusPatterns?: Record<string, string>;
  claudeAgent?: string;
  claudeSkill?: string;
  provider?: 'claude' | 'codex';
  model?: string;
}

/** Debug configuration for takt */
export interface DebugConfig {
  enabled: boolean;
  logFile?: string;
}

/** Language setting for takt */
export type Language = 'en' | 'ja';

/** Global configuration for takt */
export interface GlobalConfig {
  language: Language;
  trustedDirectories: string[];
  defaultWorkflow: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  provider?: 'claude' | 'codex';
  model?: string;
  debug?: DebugConfig;
}

/** Project-level configuration */
export interface ProjectConfig {
  workflow?: string;
  agents?: CustomAgentConfig[];
  provider?: 'claude' | 'codex';
}
