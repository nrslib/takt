/**
 * Configuration types (global and project)
 */

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
  defaultPiece: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  provider?: 'claude' | 'codex' | 'mock';
  model?: string;
  debug?: DebugConfig;
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktreeDir?: string;
  /** Auto-create PR after worktree execution (default: prompt in interactive mode) */
  autoPr?: boolean;
  /** List of builtin piece/agent names to exclude from fallback loading */
  disabledBuiltins?: string[];
  /** Enable builtin pieces from builtins/{lang}/pieces */
  enableBuiltinPieces?: boolean;
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropicApiKey?: string;
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openaiApiKey?: string;
  /** Pipeline execution settings */
  pipeline?: PipelineConfig;
  /** Minimal output mode for CI - suppress AI output to prevent sensitive information leaks */
  minimalOutput?: boolean;
  /** Path to bookmarks file (default: ~/.takt/preferences/bookmarks.yaml) */
  bookmarksFile?: string;
  /** Path to piece categories file (default: ~/.takt/preferences/piece-categories.yaml) */
  pieceCategoriesFile?: string;
  /** Branch name generation strategy: 'romaji' (fast, default) or 'ai' (slow) */
  branchNameStrategy?: 'romaji' | 'ai';
  /** Prevent macOS idle sleep during takt execution using caffeinate (default: false) */
  preventSleep?: boolean;
  /** Enable notification sounds (default: true when undefined) */
  notificationSound?: boolean;
  /** Number of movement previews to inject into interactive mode (0 to disable, max 10) */
  interactivePreviewMovements?: number;
  /** Number of tasks to run concurrently in takt run (default: 1 = sequential) */
  concurrency: number;
}

/** Project-level configuration */
export interface ProjectConfig {
  piece?: string;
  agents?: CustomAgentConfig[];
  provider?: 'claude' | 'codex' | 'mock';
}
