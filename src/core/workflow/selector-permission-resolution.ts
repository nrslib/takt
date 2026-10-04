import type { PermissionMode } from '../models/types.js';

export type SelectorPermissionSource = 'explicit' | 'synthetic';

export interface ResolvedSelectorPermission {
  readonly permissionMode: PermissionMode;
  readonly permissionModeSource: SelectorPermissionSource;
}

export function resolveSelectorPermissionMode(
  permissionMode: PermissionMode | undefined,
): ResolvedSelectorPermission {
  return {
    permissionMode: permissionMode ?? 'readonly',
    permissionModeSource: permissionMode === undefined ? 'synthetic' : 'explicit',
  };
}
