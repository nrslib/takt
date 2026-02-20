/**
 * Configuration types (global and project)
 */

import type { MovementProviderOptions, PieceRuntimeConfig } from './piece-types.js';
import type { ProviderPermissionProfiles } from './provider-profiles.js';

export interface PersonaProviderEntry {
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  model?: string;
}

/** Custom agent configuration */
export interface CustomAgentConfig {
  name: string;
  promptFile?: string;
  prompt?: string;
  allowedTools?: string[];
  claudeAgent?: string;
  claudeSkill?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  model?: string;
}

/** Observability configuration for runtime event logs */
export interface ObservabilityConfig {
  /** Enable provider stream event logging (default: false when undefined) */
  providerEvents?: boolean;
}

/** Analytics configuration for local metrics collection */
export interface AnalyticsConfig {
  /** Whether analytics collection is enabled */
  enabled?: boolean;
  /** Custom path for analytics events directory (default: ~/.takt/analytics/events) */
  eventsPath?: string;
  /** Retention period in days for analytics event files (default: 30) */
  retentionDays?: number;
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

/** Notification sound toggles per event timing */
export interface NotificationSoundEventsConfig {
  /** Warning when iteration limit is reached */
  iterationLimit?: boolean;
  /** Success notification when piece execution completes */
  pieceComplete?: boolean;
  /** Error notification when piece execution aborts */
  pieceAbort?: boolean;
  /** Success notification when runAllTasks finishes without failures */
  runComplete?: boolean;
  /** Error notification when runAllTasks finishes with failures or aborts */
  runAbort?: boolean;
}

/** Persisted global configuration for ~/.takt/config.yaml */
export interface PersistedGlobalConfig {
  language: Language;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  model?: string;
  observability?: ObservabilityConfig;
  analytics?: AnalyticsConfig;
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktreeDir?: string;
  /** Auto-create PR after worktree execution (default: prompt in interactive mode) */
  autoPr?: boolean;
  /** Create PR as draft (default: prompt in interactive mode when autoPr is true) */
  draftPr?: boolean;
  /** List of builtin piece/agent names to exclude from fallback loading */
  disabledBuiltins?: string[];
  /** Enable builtin pieces from builtins/{lang}/pieces */
  enableBuiltinPieces?: boolean;
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropicApiKey?: string;
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openaiApiKey?: string;
  /** External Codex CLI path for Codex SDK override (overridden by TAKT_CODEX_CLI_PATH env var) */
  codexCliPath?: string;
  /** OpenCode API key for OpenCode SDK (overridden by TAKT_OPENCODE_API_KEY env var) */
  opencodeApiKey?: string;
  /** Pipeline execution settings */
  pipeline?: PipelineConfig;
  /** Minimal output mode for CI - suppress AI output to prevent sensitive information leaks */
  minimalOutput?: boolean;
  /** Path to bookmarks file (default: ~/.takt/preferences/bookmarks.yaml) */
  bookmarksFile?: string;
  /** Path to piece categories file (default: ~/.takt/preferences/piece-categories.yaml) */
  pieceCategoriesFile?: string;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Global provider-specific options (lowest priority) */
  providerOptions?: MovementProviderOptions;
  /** Provider-specific permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Global runtime environment defaults (can be overridden by piece runtime) */
  runtime?: PieceRuntimeConfig;
  /** Branch name generation strategy: 'romaji' (fast, default) or 'ai' (slow) */
  branchNameStrategy?: 'romaji' | 'ai';
  /** Prevent macOS idle sleep during takt execution using caffeinate (default: false) */
  preventSleep?: boolean;
  /** Enable notification sounds (default: true when undefined) */
  notificationSound?: boolean;
  /** Notification sound toggles per event timing */
  notificationSoundEvents?: NotificationSoundEventsConfig;
  /** Number of movement previews to inject into interactive mode (0 to disable, max 10) */
  interactivePreviewMovements?: number;
  /** Verbose output mode */
  verbose?: boolean;
  /** Number of tasks to run concurrently in takt run (default: 1 = sequential) */
  concurrency: number;
  /** Polling interval in ms for picking up new tasks during takt run (default: 500, range: 100-5000) */
  taskPollIntervalMs: number;
}

/** Project-level configuration */
export interface ProjectConfig {
  piece?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  providerOptions?: MovementProviderOptions;
  /** Provider-specific permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
}
