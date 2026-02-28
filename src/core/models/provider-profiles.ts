/**
 * Provider-specific permission profile types.
 */

import type { PermissionMode } from './status.js';

/** Supported providers for profile-based permission resolution. */
export type ProviderProfileName = 'claude' | 'codex' | 'opencode' | 'cursor' | 'mock';

/** Permission profile for a single provider. */
export interface ProviderPermissionProfile {
  /** Default permission mode for movements that do not have an explicit override. */
  defaultPermissionMode: PermissionMode;
  /** Per-movement permission overrides keyed by movement name. */
  movementPermissionOverrides?: Record<string, PermissionMode>;
}

/** Provider -> permission profile map. */
export type ProviderPermissionProfiles = Partial<Record<ProviderProfileName, ProviderPermissionProfile>>;
