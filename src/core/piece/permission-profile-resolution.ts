import type { PermissionMode } from '../models/types.js';
import type { ProviderPermissionProfiles, ProviderProfileName } from '../models/provider-profiles.js';

export interface ResolvePermissionModeInput {
  movementName: string;
  requiredPermissionMode?: PermissionMode;
  provider?: ProviderProfileName;
  projectProviderProfiles?: ProviderPermissionProfiles;
  globalProviderProfiles?: ProviderPermissionProfiles;
}

export const DEFAULT_PROVIDER_PERMISSION_PROFILES: ProviderPermissionProfiles = {
  claude: { defaultPermissionMode: 'edit' },
  'claude-sdk': { defaultPermissionMode: 'edit' },
  codex: { defaultPermissionMode: 'edit' },
  opencode: { defaultPermissionMode: 'edit' },
  cursor: { defaultPermissionMode: 'edit' },
  copilot: { defaultPermissionMode: 'edit' },
  mock: { defaultPermissionMode: 'edit' },
};

export function resolveMovementPermissionMode(input: ResolvePermissionModeInput): PermissionMode {
  if (!input.provider) {
    return input.requiredPermissionMode ?? 'readonly';
  }

  const projectProfile = input.projectProviderProfiles?.[input.provider];
  const globalProfile = input.globalProviderProfiles?.[input.provider];

  const projectOverride = projectProfile?.movementPermissionOverrides?.[input.movementName];
  if (projectOverride) {
    return applyRequiredPermissionFloor(projectOverride, input.requiredPermissionMode);
  }

  const globalOverride = globalProfile?.movementPermissionOverrides?.[input.movementName];
  if (globalOverride) {
    return applyRequiredPermissionFloor(globalOverride, input.requiredPermissionMode);
  }

  if (projectProfile?.defaultPermissionMode) {
    return applyRequiredPermissionFloor(projectProfile.defaultPermissionMode, input.requiredPermissionMode);
  }

  if (globalProfile?.defaultPermissionMode) {
    return applyRequiredPermissionFloor(globalProfile.defaultPermissionMode, input.requiredPermissionMode);
  }

  if (input.requiredPermissionMode) {
    return input.requiredPermissionMode;
  }

  return 'readonly';
}

const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  readonly: 0,
  edit: 1,
  full: 2,
};

function applyRequiredPermissionFloor(
  resolvedMode: PermissionMode,
  requiredMode?: PermissionMode,
): PermissionMode {
  if (!requiredMode) {
    return resolvedMode;
  }
  return PERMISSION_MODE_RANK[requiredMode] > PERMISSION_MODE_RANK[resolvedMode]
    ? requiredMode
    : resolvedMode;
}
