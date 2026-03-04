/**
 * Config module type definitions
 */

import type { MovementProviderOptions, PieceRuntimeConfig } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type {
  AnalyticsConfig,
  PersonaProviderEntry,
  PieceOverrides,
  PipelineConfig,
  SubmoduleSelection,
} from '../../core/models/persisted-global-config.js';

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
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
  /** Project log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
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

/** Persona session data for persistence */
export interface PersonaSessionData {
  personaSessions: Record<string, string>;
  updatedAt: string;
  /** Provider that created these sessions (claude, codex, etc.) */
  provider?: string;
}
