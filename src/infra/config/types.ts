/**
 * Config module type definitions
 */

import type { PieceCategoryConfigNode } from '../../core/models/schemas.js';
import type { MovementProviderOptions } from '../../core/models/piece-types.js';

/** Permission mode for the project
 * - default: Uses Agent SDK's acceptEdits mode (auto-accepts file edits, minimal prompts)
 * - sacrifice-my-pc: Auto-approves all permission requests (bypassPermissions)
 *
 * Note: 'confirm' mode is planned but not yet implemented
 */
export type PermissionMode = 'default' | 'sacrifice-my-pc';

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Current piece name */
  piece?: string;
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex' | 'opencode';
  /** Permission mode setting */
  permissionMode?: PermissionMode;
  /** Verbose output mode */
  verbose?: boolean;
  /** Provider-specific options (overrides global, overridden by piece/movement) */
  provider_options?: MovementProviderOptions;
  /** Piece categories (name -> piece list) */
  piece_categories?: Record<string, PieceCategoryConfigNode>;
  /** Show uncategorized pieces under Others category */
  show_others_category?: boolean;
  /** Display name for Others category */
  others_category_name?: string;
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
