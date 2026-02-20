/**
 * Execution module type definitions
 */

import type { Language } from '../../../core/models/index.js';
import type { PersonaProviderEntry } from '../../../core/models/persisted-global-config.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';
import type { MovementProviderOptions } from '../../../core/models/piece-types.js';
import type { ProviderType } from '../../../infra/providers/index.js';
import type { GitHubIssue } from '../../../infra/github/index.js';
import type { ProviderOptionsSource } from '../../../core/piece/types.js';

/** Result of piece execution */
export interface PieceExecutionResult {
  success: boolean;
  reason?: string;
  lastMovement?: string;
  lastMessage?: string;
}

/** Metadata from interactive mode, passed through to NDJSON logging */
export interface InteractiveMetadata {
  /** Whether the user confirmed with /go */
  confirmed: boolean;
  /** The assembled task text (only meaningful when confirmed=true) */
  task?: string;
}

/** Options for piece execution */
export interface PieceExecutionOptions {
  /** Header prefix for display */
  headerPrefix?: string;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Language for instruction metadata */
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
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** Override initial movement (default: piece config's initialMovement) */
  startMovement?: string;
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
  /** Piece name or path (auto-detected by isPiecePath) */
  pieceIdentifier: string;
  /** Project root (where .takt/ lives) */
  projectCwd: string;
  /** Agent provider/model overrides */
  agentOverrides?: TaskExecutionOptions;
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** Override initial movement (default: piece config's initialMovement) */
  startMovement?: string;
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
}

export interface PipelineExecutionOptions {
  /** GitHub issue number */
  issueNumber?: number;
  /** Task content (alternative to issue) */
  task?: string;
  /** Piece name or path to piece file */
  piece: string;
  /** Branch name (auto-generated if omitted) */
  branch?: string;
  /** Whether to create a PR after successful execution */
  autoPr: boolean;
  /** Whether to create PR as draft */
  draftPr?: boolean;
  /** Repository in owner/repo format */
  repo?: string;
  /** Skip branch creation, commit, and push (piece-only execution) */
  skipGit?: boolean;
  /** Working directory */
  cwd: string;
  provider?: ProviderType;
  model?: string;
}

export interface WorktreeConfirmationResult {
  execCwd: string;
  isWorktree: boolean;
  branch?: string;
  baseBranch?: string;
  taskSlug?: string;
}

export interface SelectAndExecuteOptions {
  autoPr?: boolean;
  draftPr?: boolean;
  repo?: string;
  piece?: string;
  createWorktree?: boolean | undefined;
  /** Enable interactive user input during step transitions */
  interactiveUserInput?: boolean;
  /** Interactive mode result metadata for NDJSON logging */
  interactiveMetadata?: InteractiveMetadata;
  /** GitHub Issues to associate with the PR (adds "Closes #N" for each issue) */
  issues?: GitHubIssue[];
}
