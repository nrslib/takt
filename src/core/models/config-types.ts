/**
 * Configuration types (global and project)
 *
 * 3-layer model:
 *   ProjectConfig  — .takt/config.yaml (project-level)
 *   GlobalConfig   — ~/.takt/config.yaml (user-level, superset of ProjectConfig)
 *   LoadedConfig   — resolved values with NonNullable defaults (defined in resolvedConfig.ts)
 */

import type { ProviderType } from '../../shared/types/provider.js';
import type { StepProviderOptions, WorkflowRuntimeConfig } from './workflow-types.js';
import type { ProviderPermissionProfiles } from './provider-profiles.js';
import type { VcsProviderType } from './vcs-types.js';

export interface PersonaProviderEntry {
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}

export interface TaktProviderEntry {
  provider: ProviderType;
  model?: string;
}

export type TaktProviderModelOnlyEntry = {
  provider?: ProviderType;
  model: string;
};

export type TaktProviderConfigEntry = TaktProviderEntry | TaktProviderModelOnlyEntry;

export interface TaktProvidersConfig {
  assistant: TaktProviderConfigEntry;
}

/** Step-specific quality gates override */
export interface StepQualityGatesOverride {
  qualityGates?: string[];
}

/** Workflow-level overrides (quality_gates, etc.) */
export interface WorkflowOverrides {
  /** Global quality gates applied to all steps */
  qualityGates?: string[];
  /** Whether to apply quality_gates only to edit: true steps */
  qualityGatesEditOnly?: boolean;
  /** Step-specific quality gates overrides */
  steps?: Record<string, StepQualityGatesOverride>;
  /** Persona-specific quality gates overrides */
  personas?: Record<string, StepQualityGatesOverride>;
}

/** Custom agent configuration */
export interface CustomAgentConfig {
  name: string;
  promptFile?: string;
  prompt?: string;
  allowedTools?: string[];
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

/** Workflow-level runtime.prepare policy */
export interface WorkflowRuntimePrepareConfig {
  /** Allow custom script paths from workflow YAML (default: false) */
  customScripts?: boolean;
}

/** Workflow-level Arpeggio custom capability policy */
export interface WorkflowArpeggioConfig {
  /** Allow non-builtin Arpeggio data sources from workflow YAML (default: false) */
  customDataSourceModules?: boolean;
  /** Allow inline JS custom merge functions from workflow YAML (default: false) */
  customMergeInlineJs?: boolean;
  /** Allow external JS custom merge files from workflow YAML (default: false) */
  customMergeFiles?: boolean;
}

/** Sync conflict resolver configuration */
export interface SyncConflictResolverConfig {
  /** Auto-approve conflict resolver tool requests (default: false) */
  autoApproveTools?: boolean;
}

/** Workflow-level MCP transport policy */
export interface WorkflowMcpServersConfig {
  /** Allow stdio MCP servers from workflow YAML (default: false) */
  stdio?: boolean;
  /** Allow SSE MCP servers from workflow YAML (default: false) */
  sse?: boolean;
  /** Allow HTTP MCP servers from workflow YAML (default: false) */
  http?: boolean;
}


/** Notification sound toggles per event timing */
export interface NotificationSoundEventsConfig {
  /** Warning when iteration limit is reached */
  iterationLimit?: boolean;
  /** Success notification when workflow execution completes */
  workflowComplete?: boolean;
  /** Error notification when workflow execution aborts */
  workflowAbort?: boolean;
  /** Success notification when runAllTasks finishes without failures */
  runComplete?: boolean;
  /** Error notification when runAllTasks finishes with failures or aborts */
  runAbort?: boolean;
}

/**
 * Project-level configuration stored in .takt/config.yaml.
 */
export interface ProjectConfig {
  /** UI / builtin resource language override for this project */
  language?: Language;
  /** Provider selection for agent runtime */
  provider?: ProviderType;
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
  /** VCS provider selection (github or gitlab) */
  vcsProvider?: VcsProviderType;
  /** Base branch to clone from (overrides global baseBranch) */
  baseBranch?: string;
  /** Submodule acquisition mode (all or explicit path list) */
  submodules?: SubmoduleSelection;
  /** Compatibility flag for full submodule acquisition when submodules is unset */
  withSubmodules?: boolean;
  /** Pipeline execution settings */
  pipeline?: PipelineConfig;
  /** TAKT internal target provider/model overrides */
  taktProviders?: TaktProvidersConfig;
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
  /** Number of step previews in interactive mode */
  interactivePreviewSteps?: number;
  /** Sync project-local .takt resources from root when retry reuses a worktree */
  syncProjectLocalTaktOnRetry?: boolean;
  /** Project-level analytics overrides */
  analytics?: AnalyticsConfig;
  /** Provider-specific options (overrides global, overridden by workflow/step) */
  providerOptions?: StepProviderOptions;
  /** Provider-specific permission profiles (project-level override) */
  providerProfiles?: ProviderPermissionProfiles;
  /** Workflow-level overrides (quality_gates, etc.) */
  workflowOverrides?: WorkflowOverrides;
  /** Runtime environment configuration (project-level override) */
  runtime?: WorkflowRuntimeConfig;
  /** Workflow-level runtime.prepare policy */
  workflowRuntimePrepare?: WorkflowRuntimePrepareConfig;
  /** Workflow-level Arpeggio policy */
  workflowArpeggio?: WorkflowArpeggioConfig;
  /** Sync conflict resolver behavior */
  syncConflictResolver?: SyncConflictResolverConfig;
  /** Workflow-level MCP transport policy */
  workflowMcpServers?: WorkflowMcpServersConfig;
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
  /** List of builtin workflow/agent names to exclude from fallback loading */
  disabledBuiltins?: string[];
  /** @globalOnly */
  /** Enable builtin workflows from builtins/{lang}/workflows */
  enableBuiltinWorkflows?: boolean;
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
  /**
   * User categories overlay path (default: ~/.takt/preferences/workflow-categories.yaml).
   * Builtin defaults: builtins/{lang}/workflow-categories.yaml (canonical keys: `workflow_categories` / `workflows`).
   */
  workflowCategoriesFile?: string;
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
