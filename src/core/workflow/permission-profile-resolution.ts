import type { PermissionMode } from '../models/types.js';
import {
  DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE,
  type ProviderPermissionProfiles,
  type ProviderProfileName,
} from '../models/provider-profiles.js';

export interface ResolvePermissionModeInput {
  stepName: string;
  requiredPermissionMode?: PermissionMode;
  provider?: ProviderProfileName;
  projectProviderProfiles?: ProviderPermissionProfiles;
  globalProviderProfiles?: ProviderPermissionProfiles;
}

export const DEFAULT_PROVIDER_PERMISSION_PROFILES: ProviderPermissionProfiles = {
  claude: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  'claude-sdk': { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  'claude-terminal': { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  codex: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  opencode: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  cursor: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  copilot: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  kiro: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  mock: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
};

/**
 * ユーザー定義のグローバルプロファイルを、デフォルト表へのプロバイダ単位の
 * 上書きとして解決する。?? で丸ごと置き換えると、書かれていないプロバイダの
 * 既定権限が黙って消える（edit: true のステップが readonly ツールで走る実障害）。
 */
export function mergeGlobalPermissionProfiles(
  userProfiles: ProviderPermissionProfiles | undefined,
): ProviderPermissionProfiles {
  return {
    ...DEFAULT_PROVIDER_PERMISSION_PROFILES,
    ...(userProfiles ?? {}),
  };
}

export function resolveStepPermissionMode(input: ResolvePermissionModeInput): PermissionMode {
  if (!input.provider) {
    return input.requiredPermissionMode ?? 'readonly';
  }

  const projectProfile = input.projectProviderProfiles?.[input.provider];
  const globalProfile = input.globalProviderProfiles?.[input.provider];

  const projectOverride = projectProfile?.stepPermissionOverrides?.[input.stepName];
  if (projectOverride) {
    return applyRequiredPermissionFloor(projectOverride, input.requiredPermissionMode);
  }

  const globalOverride = globalProfile?.stepPermissionOverrides?.[input.stepName];
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
