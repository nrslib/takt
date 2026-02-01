/**
 * Core type definitions for TAKT orchestration system
 */

/** Built-in agent types */
export type AgentType = 'coder' | 'architect' | 'supervisor' | 'custom';

/** Execution status for agents and workflows */
export type Status =
  | 'pending'
  | 'done'
  | 'blocked'
  | 'approved'
  | 'rejected'
  | 'improve'
  | 'cancelled'
  | 'interrupted'
  | 'answer';

/** How a rule match was detected */
export type RuleMatchMethod =
  | 'aggregate'
  | 'phase3_tag'
  | 'phase1_tag'
  | 'ai_judge'
  | 'ai_judge_fallback';

/** Response from an agent execution */
export interface AgentResponse {
  agent: string;
  status: Status;
  content: string;
  timestamp: Date;
  sessionId?: string;
  /** Error message when the query failed (e.g., API error, rate limit) */
  error?: string;
  /** Matched rule index (0-based) when rules-based detection was used */
  matchedRuleIndex?: number;
  /** How the rule match was detected */
  matchedRuleMethod?: RuleMatchMethod;
}

/** Session state for workflow execution */
export interface SessionState {
  task: string;
  projectDir: string;
  iterations: number;
  history: AgentResponse[];
  context: Record<string, string>;
}

/** Rule-based transition configuration (new unified format) */
export interface WorkflowRule {
  /** Human-readable condition text */
  condition: string;
  /** Next step name (e.g., implement, COMPLETE, ABORT). Optional for parallel sub-steps. */
  next?: string;
  /** Template for additional AI output */
  appendix?: string;
  /** Whether this condition uses ai() expression (set by loader) */
  isAiCondition?: boolean;
  /** The condition text inside ai("...") for AI judge evaluation (set by loader) */
  aiConditionText?: string;
  /** Whether this condition uses all()/any() aggregate expression (set by loader) */
  isAggregateCondition?: boolean;
  /** Aggregate type: 'all' requires all sub-steps match, 'any' requires at least one (set by loader) */
  aggregateType?: 'all' | 'any';
  /** The condition text inside all("...")/any("...") to match against sub-step results (set by loader) */
  aggregateConditionText?: string;
}

/** Report file configuration for a workflow step (label: path pair) */
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

/** Permission mode for tool execution */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

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
  provider?: 'claude' | 'codex' | 'mock';
  /** Model override for this step */
  model?: string;
  /** Permission mode for tool execution in this step */
  permissionMode?: PermissionMode;
  /** Whether this step is allowed to edit project files (true=allowed, false=prohibited, undefined=no prompt) */
  edit?: boolean;
  instructionTemplate: string;
  /** Rules for step routing */
  rules?: WorkflowRule[];
  /** Report file configuration. Single string, array of label:path, or object with order/format. */
  report?: string | ReportConfig[] | ReportObjectConfig;
  passPreviousResponse: boolean;
  /** Sub-steps to execute in parallel. When set, this step runs all sub-steps concurrently. */
  parallel?: WorkflowStep[];
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
  /** Per-step iteration counters (how many times each step has been executed) */
  stepIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}

/** Custom agent configuration */
export interface CustomAgentConfig {
  name: string;
  promptFile?: string;
  prompt?: string;
  allowedTools?: string[];
  claudeAgent?: string;
  claudeSkill?: string;
  provider?: 'claude' | 'codex' | 'mock';
  model?: string;
}

/** Debug configuration for takt */
export interface DebugConfig {
  enabled: boolean;
  logFile?: string;
}

/** Language setting for takt */
export type Language = 'en' | 'ja';

/** Pipeline execution configuration */
export interface PipelineConfig {
  /** Branch name prefix for pipeline-created branches (default: "takt/") */
  defaultBranchPrefix?: string;
  /** Commit message template. Variables: {title}, {issue} */
  commitMessageTemplate?: string;
  /** PR body template. Variables: {issue_body}, {report}, {issue} */
  prBodyTemplate?: string;
}

/** Global configuration for takt */
export interface GlobalConfig {
  language: Language;
  trustedDirectories: string[];
  defaultWorkflow: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  provider?: 'claude' | 'codex' | 'mock';
  model?: string;
  debug?: DebugConfig;
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktreeDir?: string;
  /** List of builtin workflow/agent names to exclude from fallback loading */
  disabledBuiltins?: string[];
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropicApiKey?: string;
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openaiApiKey?: string;
  /** Pipeline execution settings */
  pipeline?: PipelineConfig;
  /** Minimal output mode for CI - suppress AI output to prevent sensitive information leaks */
  minimalOutput?: boolean;
}

/** Project-level configuration */
export interface ProjectConfig {
  workflow?: string;
  agents?: CustomAgentConfig[];
  provider?: 'claude' | 'codex' | 'mock';
}
