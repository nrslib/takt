/**
 * Config module type definitions
 */

import type { WorkflowCategoryConfigNode } from '../../core/models/schemas.js';

/** Permission mode for the project
 * - default: Uses Agent SDK's acceptEdits mode (auto-accepts file edits, minimal prompts)
 * - sacrifice-my-pc: Auto-approves all permission requests (bypassPermissions)
 *
 * Note: 'confirm' mode is planned but not yet implemented
 */
export type PermissionMode = 'default' | 'sacrifice-my-pc';

/** @deprecated Use PermissionMode instead */
export type ProjectPermissionMode = PermissionMode;

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Current workflow name */
  workflow?: string;
  /** Provider selection for agent runtime */
  provider?: 'claude' | 'codex';
  /** Permission mode setting */
  permissionMode?: PermissionMode;
  /** Verbose output mode */
  verbose?: boolean;
  /** Workflow categories (name -> workflow list) */
  workflow_categories?: Record<string, WorkflowCategoryConfigNode>;
  /** Show uncategorized workflows under Others category */
  show_others_category?: boolean;
  /** Display name for Others category */
  others_category_name?: string;
  /** Custom settings */
  [key: string]: unknown;
}

/** Agent session data for persistence */
export interface AgentSessionData {
  agentSessions: Record<string, string>;
  updatedAt: string;
  /** Provider that created these sessions (claude, codex, etc.) */
  provider?: string;
}
