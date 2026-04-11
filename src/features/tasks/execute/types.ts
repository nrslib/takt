/**
 * Execution module type definitions
 */

import type { Language } from '../../../core/models/index.js';
import type { PersonaProviderEntry } from '../../../core/models/config-types.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { ProviderType } from '../../../infra/providers/index.js';
import type { ProviderOptionsOriginResolver, ProviderOptionsSource } from '../../../core/workflow/types.js';

/** Info captured when iteration limit is hit in non-interactive mode */
export interface ExceededInfo {
  currentStep: string;
  newMaxSteps: number;
  currentIteration: number;
}

/** Result of workflow execution */
export interface WorkflowExecutionResult {
  success: boolean;
  reason?: string;
  lastStep?: string;
  lastMessage?: string;
  /** True when iteration limit was hit in non-interactive mode */
  exceeded?: boolean;
  exceededInfo?: ExceededInfo;
}

/** Metadata from interactive mode, passed through to NDJSON logging */
export interface InteractiveMetadata {
  /** Whether the user confirmed with /go */
  confirmed: boolean;
  /** The assembled task text (only meaningful when confirmed=true) */
  task?: string;
}

/** Options for workflow execution */
export interface WorkflowExecutionOptions {
  /** Header prefix for display */
  headerPrefix?: string;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Override maxSteps from workflow config (used when resuming exceeded tasks) */
  maxStepsOverride?: number;
  /** Override initial iteration count (used when resuming exceeded tasks) */
  initialIterationOverride?: number;
  /** Language for instruction metadata */
  language?: Language;
  provider?: ProviderType;
  model?: string;
  /** Resolved provider options */
  providerOptions?: StepProviderOptions;
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Nested origin resolver for resolved provider options */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Resolved provider permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** Override initial step (default: workflow config's initialStep) */
  startStep?: string;
  /** Retry note explaining why task is being retried */
  retryNote?: string;
  /** Override report directory name (e.g. "20260201-015714-foptng") */
  reportDirName?: string;
  /** External abort signal for parallel execution — when provided, SIGINT handling is delegated to caller */
  abortSignal?: AbortSignal;
  /** Task name prefix for parallel execution output (e.g. "[task-name] output...") */
  taskPrefix?: string;
  /** Optional full task label used instead of taskName truncation when prefixed output is rendered */
  taskDisplayLabel?: string;
  /** Color index for task prefix (cycled mod 4 across concurrent tasks) */
  taskColorIndex?: number;
  /** Current task issue number for system-step context resolution */
  currentTaskIssueNumber?: number;
}

export interface TaskExecutionOptions {
  provider?: ProviderType;
  model?: string;
}

export interface ExecuteTaskOptions {
  /** Task content */
  task: string;
  /** Working directory (may be a clone path) */
  cwd: string;
  /** Workflow name or path (auto-detected by isWorkflowPath) */
  workflowIdentifier: string;
  /** Project root (where .takt/ lives) */
  projectCwd: string;
  /** Agent provider/model overrides */
  agentOverrides?: TaskExecutionOptions;
  /** Override maxSteps from workflow config (used when resuming exceeded tasks) */
  maxStepsOverride?: number;
  /** Override initial iteration count (used when resuming exceeded tasks) */
  initialIterationOverride?: number;
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** Override initial step (default: workflow config's initialStep) */
  startStep?: string;
  /** Retry note explaining why task is being retried */
  retryNote?: string;
  /** Override report directory name (e.g. "20260201-015714-foptng") */
  reportDirName?: string;
  /** External abort signal for parallel execution — when provided, SIGINT handling is delegated to caller */
  abortSignal?: AbortSignal;
  /** Task name prefix for parallel execution output (e.g. "[task-name] output...") */
  taskPrefix?: string;
  /** Optional full task label used instead of taskName truncation when prefixed output is rendered */
  taskDisplayLabel?: string;
  /** Color index for task prefix (cycled mod 4 across concurrent tasks) */
  taskColorIndex?: number;
  /** Current task issue number for system-step context resolution */
  currentTaskIssueNumber?: number;
}

export interface PipelineExecutionOptions {
  /** GitHub issue number */
  issueNumber?: number;
  /** PR number to fetch review comments */
  prNumber?: number;
  /** Task content (alternative to issue) */
  task?: string;
  /** Workflow name or path to workflow file */
  workflow: string;
  /** Branch name (auto-generated if omitted) */
  branch?: string;
  /** Whether to create a PR after successful execution */
  autoPr: boolean;
  /** Whether to create PR as draft */
  draftPr?: boolean;
  /** Repository in owner/repo format */
  repo?: string;
  /** Skip branch creation, commit, and push (workflow-only execution) */
  skipGit?: boolean;
  /** Working directory */
  cwd: string;
  provider?: ProviderType;
  model?: string;
  /** Whether to create worktree for task execution */
  createWorktree?: boolean | undefined;
}

export interface WorktreeConfirmationResult {
  execCwd: string;
  isWorktree: boolean;
  branch?: string;
  baseBranch?: string;
  taskSlug?: string;
}

export interface SelectAndExecuteOptions {
  workflow?: string;
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** Skip adding task to tasks.yaml */
  skipTaskList?: boolean;
}
