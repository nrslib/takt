import type { PermissionMode } from '../../core/models/index.js';

export const CLAUDE_PERMISSION_EXPRESSION_VALUES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
] as const;

export type ClaudePermissionExpression = (typeof CLAUDE_PERMISSION_EXPRESSION_VALUES)[number];

export function taktPermissionModeToClaudeExpression(
  mode: PermissionMode,
): ClaudePermissionExpression {
  const mapping: Record<PermissionMode, ClaudePermissionExpression> = {
    readonly: 'default',
    edit: 'acceptEdits',
    full: 'bypassPermissions',
  };
  return mapping[mode];
}
