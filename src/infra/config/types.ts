/**
 * Config module type definitions
 */

import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { AnalyticsConfig } from '../../core/models/persisted-global-config.js';

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Current piece name */
  piece?: string;
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  /** Auto-create PR after worktree execution */
  auto_pr?: boolean;
  /** Create PR as draft */
  draft_pr?: boolean;
  /** Verbose output mode */
  verbose?: boolean;
  /** Project-level analytics overrides */
  analytics?: AnalyticsConfig;
  /** Provider-specific options (overrides global, overridden by piece/movement) */
  provider_options?: MovementProviderOptions;
  /** Provider-specific options (camelCase alias) */
  providerOptions?: MovementProviderOptions;
  /** Provider-specific permission profiles (project-level override) */
  provider_profiles?: ProviderPermissionProfiles;
  /** Provider-specific permission profiles (camelCase alias) */
  providerProfiles?: ProviderPermissionProfiles;
  /** Custom settings */
  [key: string]: unknown;
}

/** Persona session data for persistence */
export interface PersonaSessionData {
  personaSessions: Record<string, string>;
  updatedAt: string;
  /** Provider that created these sessions (claude, codex, etc.) */
  provider?: string;
}
