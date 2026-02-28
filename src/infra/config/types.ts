/**
 * Config module type definitions
 */

import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { AnalyticsConfig, SubmoduleSelection } from '../../core/models/persisted-global-config.js';

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Current piece name */
  piece?: string;
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'mock';
  /** Model selection for agent runtime */
  model?: string;
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
  /** Verbose output mode */
  verbose?: boolean;
  /** Number of tasks to run concurrently in takt run (1-10) */
  concurrency?: number;
  /** Project-level analytics overrides */
  analytics?: AnalyticsConfig;
  /** Provider-specific options (overrides global, overridden by piece/movement) */
  providerOptions?: MovementProviderOptions;
  /** Provider-specific permission profiles (project-level override) */
  providerProfiles?: ProviderPermissionProfiles;
  /** Claude Code CLI path override (project-level) */
  claudeCliPath?: string;
  /** Codex CLI path override (project-level) */
  codexCliPath?: string;
  /** cursor-agent CLI path override (project-level) */
  cursorCliPath?: string;
}

/** Persona session data for persistence */
export interface PersonaSessionData {
  personaSessions: Record<string, string>;
  updatedAt: string;
  /** Provider that created these sessions (claude, codex, etc.) */
  provider?: string;
}
