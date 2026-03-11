/**
 * Configuration types (global and project)
 *
 * 3-layer model:
 *   ProjectConfig  — .takt/config.yaml (project-level)
 *   GlobalConfig   — ~/.takt/config.yaml (user-level, superset of ProjectConfig)
 *   LoadedConfig   — resolved values with NonNullable defaults (defined in resolvedConfig.ts)
 */

import type { MovementProviderOptions, PieceRuntimeConfig } from './piece-types.js';
import type { ProviderPermissionProfiles } from './provider-profiles.js';

export interface PersonaProviderEntry {
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
  model?: string;
}

/** Movement-specific quality gates override */
export interface MovementQualityGatesOverride {
  qualityGates?: string[];
}

/** Piece-level overrides (quality_gates, etc.) */
export interface PieceOverrides {
  /** Global quality gates applied to all movements */
  qualityGates?: string[];
  /** Whether to apply quality_gates only to edit: true movements */
  qualityGatesEditOnly?: boolean;
  /** Movement-specific quality gates overrides */
  movements?: Record<string, MovementQualityGatesOverride>;
  /** Persona-specific quality gates overrides */
  personas?: Record<string, MovementQualityGatesOverride>;
}

/** Custom agent configuration */
export interface CustomAgentConfig {
  name: string;
  promptFile?: string;
  prompt?: string;
  allowedTools?: string[];
  claudeAgent?: string;
  claudeSkill?: string;
}

/** Logging configuration for runtime output */
export interface LoggingConfig {
  /** Log level for global output behavior */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Enable trace logging */
  trace?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable provider stream event logging (default: false when undefined) */
  providerEvents?: boolean;
  /** Enable usage event logging (default: false when undefined) */
  usageEvents?: boolean;
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

/** Project-level submodule acquisition selection */
export type SubmoduleSelection = 'all' | string[];

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

/**
 * Project-level configuration stored in .takt/config.yaml.
 */
export interface ProjectConfig {
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
  /** Model selection for agent runtime */
  model?: string;
  /** Allow git hooks during TAKT-managed auto-commit */
  allowGitHooks?: boolean;
  /** Allow git filters during TAKT-managed auto-commit */
  allowGitFilters?: boolean;
  /** Auto-create PR after worktree execution */
  autoPr?: boolean;
  /** Create PR as draft */
  draftPr?: boolean;
  /** Base branch to clone from (overrides global baseBranch) */
  baseBranch?: string;
  /** Submodule acquisition mode (all or explicit path list) */
  submodules?: SubmoduleSelection;
  /** Compatibility flag for full submodule acquisition when submodules is unset */
  withSubmodules?: boolean;
  /** Pipeline execution settings */
  pipeline?: PipelineConfig;
  /** Per-persona provider/model overrides */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Branch name generation strategy */
  branchNameStrategy?: 'romaji' | 'ai';
  /** Minimal output mode */
  minimalOutput?: boolean;
  /** Number of tasks to run concurrently in takt run (1-10) */
  concurrency?: number;
  /** Polling interval in ms for task pickup */
  taskPollIntervalMs?: number;
  /** Number of movement previews in interactive mode */
  interactivePreviewMovements?: number;
  /** Project-level analytics overrides */
  analytics?: AnalyticsConfig;
  /** Provider-specific options (overrides global, overridden by piece/movement) */
  providerOptions?: MovementProviderOptions;
  /** Provider-specific permission profiles (project-level override) */
  providerProfiles?: ProviderPermissionProfiles;
  /** Piece-level overrides (quality_gates, etc.) */
  pieceOverrides?: PieceOverrides;
  /** Runtime environment configuration (project-level override) */
  runtime?: PieceRuntimeConfig;
}

/**
 * Global configuration persisted in ~/.takt/config.yaml.
 *
 * Extends ProjectConfig with global-only fields (API keys, CLI paths, etc.).
 * For overlapping keys, ProjectConfig values take priority at runtime
 * — handled by the resolution layer.
 */
export interface GlobalConfig extends Omit<ProjectConfig, 'submodules' | 'withSubmodules'> {
  /** @globalOnly */
  language: Language;
  /** @globalOnly */
  logging?: LoggingConfig;
  /** @globalOnly */
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktreeDir?: string;
  /** @globalOnly */
  /** List of builtin piece/agent names to exclude from fallback loading */
  disabledBuiltins?: string[];
  /** @globalOnly */
  /** Enable builtin pieces from builtins/{lang}/pieces */
  enableBuiltinPieces?: boolean;
  /** @globalOnly */
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropicApiKey?: string;
  /** @globalOnly */
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openaiApiKey?: string;
  /** @globalOnly */
  /** Gemini API key (overridden by TAKT_GEMINI_API_KEY env var) */
  geminiApiKey?: string;
  /** @globalOnly */
  /** Google API key (overridden by TAKT_GOOGLE_API_KEY env var) */
  googleApiKey?: string;
  /** @globalOnly */
  /** Groq API key (overridden by TAKT_GROQ_API_KEY env var) */
  groqApiKey?: string;
  /** @globalOnly */
  /** OpenRouter API key (overridden by TAKT_OPENROUTER_API_KEY env var) */
  openrouterApiKey?: string;
  /** @globalOnly */
  /** External Codex CLI path for Codex SDK override (overridden by TAKT_CODEX_CLI_PATH env var) */
  codexCliPath?: string;
  /** @globalOnly */
  /** External Claude Code CLI path (overridden by TAKT_CLAUDE_CLI_PATH env var) */
  claudeCliPath?: string;
  /** @globalOnly */
  /** External cursor-agent CLI path (overridden by TAKT_CURSOR_CLI_PATH env var) */
  cursorCliPath?: string;
  /** @globalOnly */
  /** External Copilot CLI path (overridden by TAKT_COPILOT_CLI_PATH env var) */
  copilotCliPath?: string;
  /** @globalOnly */
  /** Copilot GitHub token (overridden by TAKT_COPILOT_GITHUB_TOKEN env var) */
  copilotGithubToken?: string;
  /** @globalOnly */
  /** OpenCode API key for OpenCode SDK (overridden by TAKT_OPENCODE_API_KEY env var) */
  opencodeApiKey?: string;
  /** @globalOnly */
  /** Cursor API key for Cursor Agent CLI/API (overridden by TAKT_CURSOR_API_KEY env var) */
  cursorApiKey?: string;
  /** @globalOnly */
  /** Path to bookmarks file (default: ~/.takt/preferences/bookmarks.yaml) */
  bookmarksFile?: string;
  /** @globalOnly */
  /** Path to piece categories file (default: ~/.takt/preferences/piece-categories.yaml) */
  pieceCategoriesFile?: string;
  /** @globalOnly */
  /** Prevent macOS idle sleep during takt execution using caffeinate (default: false) */
  preventSleep?: boolean;
  /** @globalOnly */
  /** Enable notification sounds (default: true when undefined) */
  notificationSound?: boolean;
  /** @globalOnly */
  /** Notification sound toggles per event timing */
  notificationSoundEvents?: NotificationSoundEventsConfig;
  /** @globalOnly */
  /** Opt-in: fetch remote before cloning to keep clones up-to-date (default: false) */
  autoFetch: boolean;
}
