/**
 * Execution module type definitions
 */

import type { Language } from '../../../core/models/index.js';
import type {
  AutoRoutingConfig,
  AutoRoutingStrategy,
  PersonaProviderEntry,
  ProviderRoutingConfig,
} from '../../../core/models/config-types.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { McpServerConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import type {
  AskUserQuestionHandler,
  StepProviderInfo,
  WorkflowCallResolver,
  WorkflowTraceTaskMetadata,
} from '../../../core/workflow/types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderResolutionSource,
} from '../../../core/workflow/provider-options-trace.js';
import type { DirectResumeMetadata } from './runMeta.js';
import type { TaskAttachment } from '../attachments.js';
import type { TraceTaskContext } from './traceTaskMetadata.js';

/** Info captured when iteration limit is hit in non-interactive mode */
export interface ExceededInfo {
  currentStep: string;
  newMaxSteps: number;
  currentIteration: number;
  resumePoint?: WorkflowResumePoint;
}

export type WorkflowExecutionEvent =
  | {
      type: 'run_started';
      runDirectory: string;
      reportDirectory: string;
      ndjsonLogPath: string;
    }
  | {
      type: 'step_started';
      step: string;
      iteration: number;
      maxSteps: number | 'infinite';
    }
  | {
      type: 'step_completed';
      step: string;
      status: string;
    }
  | {
      type: 'rate_limited';
      step?: string;
      message: string;
    }
  | {
      type: 'blocked';
      step: string;
      confirmationId: string;
      message: string;
    }
  | {
      type: 'progress';
      message: string;
      step?: string;
    }
  | {
      type: 'output';
      outputType: 'text' | 'thinking' | 'tool_output' | 'tool_result' | 'result' | 'error';
      message: string;
      step?: string;
      tool?: string;
      isError?: boolean;
    }
  | {
      type: 'tool_started';
      toolCallId: string;
      tool: string;
      input: Record<string, unknown>;
      step?: string;
    }
  | {
      type: 'tool_completed';
      toolCallId: string;
      message: string;
      step?: string;
      isError?: boolean;
    }
  | {
      type: 'confirmation_requested';
      confirmationId: string;
      message: string;
      step?: string;
    }
  | {
      type: 'error';
      message: string;
      step?: string;
    }
  | {
      type: 'completed';
      success: true;
      reportDirectory?: string;
    }
  | {
      type: 'completed';
      success: false;
      reason: string;
      reportDirectory?: string;
    };

export type WorkflowExecutionEventSink = (event: WorkflowExecutionEvent) => void | Promise<void>;

/** Result of workflow execution */
export interface WorkflowExecutionResult {
  success: boolean;
  reason?: string;
  lastStep?: string;
  lastMessage?: string;
  runDirectory?: string;
  reportDirectory?: string;
  ndjsonLogPath?: string;
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
  /** Controls terminal-oriented output side effects. */
  outputMode?: 'terminal' | 'silent';
  /** Receives workflow lifecycle events for non-CLI adapters. */
  eventSink?: WorkflowExecutionEventSink;
  /** Handles provider AskUserQuestion calls for non-CLI adapters. */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** MCP servers supplied by a trusted application adapter for this run. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Override maxSteps from workflow config (used when resuming exceeded tasks) */
  maxStepsOverride?: number;
  /** Override initial iteration count (used when resuming exceeded tasks) */
  initialIterationOverride?: number;
  /** Language for instruction metadata */
  language?: Language;
  provider?: ProviderType;
  /** Source layer of `provider`. */
  providerSource?: ProviderResolutionSource;
  model?: string;
  /** Source layer of `model`. */
  modelSource?: ProviderResolutionSource;
  /** Provider/model used only for report phase fallback after OpenCode report retries fail. */
  reportFallbackProvider?: StepProviderInfo;
  /** Resolved provider options */
  providerOptions?: StepProviderOptions;
  /** Resolved automatic provider/model routing configuration */
  autoRouting?: AutoRoutingConfig;
  /** Strategy override for automatic provider/model routing. */
  autoStrategy?: AutoRoutingStrategy;
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Nested origin resolver for resolved provider options */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Provider routing rules by raw persona key, workflow step tag, and workflow step name */
  providerRouting?: ProviderRoutingConfig;
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
  /** Resume point for workflow_call-aware retries */
  resumePoint?: WorkflowResumePoint;
  /** Source direct run metadata for resumed direct executions */
  directResume?: DirectResumeMetadata;
  /** Resolver used to inspect workflow_call targets before engine construction. */
  workflowCallResolver?: WorkflowCallResolver;
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
  /** Task metadata used only for trace discovery attributes. */
  traceTaskMetadata?: WorkflowTraceTaskMetadata;
}

export interface TaskExecutionOptions {
  provider?: ProviderType;
  /** Source layer of `provider` (defaults to 'cli' when set via --provider). */
  providerSource?: ProviderResolutionSource;
  model?: string;
  /** Source layer of `model` (defaults to 'cli' when set via --model). */
  modelSource?: ProviderResolutionSource;
  /** Strategy override for automatic provider/model routing. */
  autoStrategy?: AutoRoutingStrategy;
}

export interface TaskExecutionContextOverride {
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
}

export interface RunAllTasksOptions extends TaskExecutionOptions {
  ignoreExceed?: boolean;
}

export interface TaskExecutionParallelOptions {
  abortSignal?: AbortSignal;
  taskPrefix?: string;
  taskColorIndex?: number;
  taskDisplayLabel?: string;
  outputMode?: 'terminal' | 'silent';
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
  /** Controls terminal-oriented output side effects. */
  outputMode?: 'terminal' | 'silent';
  /** Receives workflow lifecycle events for non-CLI adapters. */
  eventSink?: WorkflowExecutionEventSink;
  /** Handles provider AskUserQuestion calls for non-CLI adapters. */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** MCP servers supplied by a trusted application adapter for this run. */
  mcpServers?: Record<string, McpServerConfig>;
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
  /** Resume point for workflow_call-aware retries */
  resumePoint?: WorkflowResumePoint;
  /** Source direct run metadata for resumed direct executions */
  directResume?: DirectResumeMetadata;
  /** Override report directory name (e.g. "20260201-015714-foptng") */
  reportDirName?: string;
  /** Provider permission profile overrides supplied by a trusted runtime boundary. */
  providerProfileOverrides?: ProviderPermissionProfiles;
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
  /** Source metadata used by the task feature to build trace discovery attributes. */
  traceTaskContext?: TraceTaskContext;
  /** Task metadata used only for trace discovery attributes. */
  traceTaskMetadata?: WorkflowTraceTaskMetadata;
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
  /** Strategy override for automatic provider/model routing. */
  autoStrategy?: AutoRoutingStrategy;
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
  /** Images pasted during interactive task input. */
  attachments?: TaskAttachment[];
  /** Source metadata for direct trace discovery when no task record exists. */
  traceTaskContext?: TraceTaskContext;
  /** Override report directory name (e.g. "20260201-015714-foptng") */
  reportDirName?: string;
  /** Provider permission profile overrides supplied by a trusted runtime boundary. */
  providerProfileOverrides?: ProviderPermissionProfiles;
  /** When false, throw an error instead of calling process.exit(1) on task failure (default: true). */
  exitOnFailure?: boolean;
}
