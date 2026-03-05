/**
 * Status and classification types
 */

/** Built-in agent types */
export type AgentType = 'coder' | 'architect' | 'supervisor' | 'custom';

/** Execution status for agents and pieces */
export const STATUS_VALUES = ['done', 'blocked', 'error'] as const;

/** Execution status for agents and pieces */
export type Status = typeof STATUS_VALUES[number];

/** How a rule match was detected */
export type RuleMatchMethod =
  | 'aggregate'
  | 'auto_select'
  | 'structured_output'
  | 'phase3_tag'
  | 'phase1_tag'
  | 'ai_judge'
  | 'ai_judge_fallback';

/** Permission mode for tool execution (provider-agnostic) */
export type PermissionMode = 'readonly' | 'edit' | 'full';
