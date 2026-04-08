/**
 * Provider-specific permission profile types.
 */

import type { PermissionMode } from './status.js';

/** Supported providers for profile-based permission resolution. */
export type ProviderProfileName =
  | 'claude'
  | 'claude-sdk'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'copilot'
  | 'mock';

/** Permission profile for a single provider. */
export interface ProviderPermissionProfile {
  /** Default permission mode for steps that do not have an explicit override. */
  defaultPermissionMode: PermissionMode;
  /** Per-step permission overrides keyed by step name. */
  stepPermissionOverrides?: Record<string, PermissionMode>;
}

/** Provider -> permission profile map. */
export type ProviderPermissionProfiles = Partial<Record<ProviderProfileName, ProviderPermissionProfile>>;
