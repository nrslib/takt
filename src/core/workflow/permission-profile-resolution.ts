import type { PermissionMode } from '../models/types.js';
import {
  DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE,
  type ProviderPermissionProfiles,
  type ProviderProfileName,
} from '../models/provider-profiles.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface ResolvePermissionModeInput {
  stepName: string;
  requiredPermissionMode?: PermissionMode;
  provider?: ProviderProfileName;
  projectProviderProfiles?: ProviderPermissionProfiles;
  globalProviderProfiles?: ProviderPermissionProfiles;
  defaultProviderProfiles?: ProviderPermissionProfiles;
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
  pi: { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
  'deepseek-harness': { defaultPermissionMode: DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE },
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

export interface ResolvedPermissionMode {
  value: PermissionMode;
  source: ProviderResolutionSource;
}

export function resolveStepPermissionMode(input: ResolvePermissionModeInput): PermissionMode {
  return resolveStepPermissionModeWithSource(input).value;
}

export function resolveStepPermissionModeWithSource(
  input: ResolvePermissionModeInput,
): ResolvedPermissionMode {
  if (!input.provider) {
    return input.requiredPermissionMode === undefined
      ? { value: 'readonly', source: 'default' }
      : { value: input.requiredPermissionMode, source: 'step' };
  }

  const projectProfile = input.projectProviderProfiles?.[input.provider];
  const configuredGlobalProfile = input.globalProviderProfiles?.[input.provider];
  const globalProfile = configuredGlobalProfile
    ?? input.defaultProviderProfiles?.[input.provider];
  const globalProfileSource: ProviderResolutionSource = configuredGlobalProfile === undefined
    ? 'default'
    : 'global';

  const projectOverride = projectProfile?.stepPermissionOverrides?.[input.stepName];
  if (projectOverride) {
    return applyRequiredPermissionFloorWithSource(projectOverride, input.requiredPermissionMode, 'project');
  }

  const globalOverride = globalProfile?.stepPermissionOverrides?.[input.stepName];
  if (globalOverride) {
    return applyRequiredPermissionFloorWithSource(globalOverride, input.requiredPermissionMode, globalProfileSource);
  }

  if (projectProfile?.defaultPermissionMode) {
    return applyRequiredPermissionFloorWithSource(
      projectProfile.defaultPermissionMode,
      input.requiredPermissionMode,
      'project',
    );
  }

  if (globalProfile?.defaultPermissionMode) {
    return applyRequiredPermissionFloorWithSource(
      globalProfile.defaultPermissionMode,
      input.requiredPermissionMode,
      globalProfileSource,
    );
  }

  if (input.requiredPermissionMode) {
    return { value: input.requiredPermissionMode, source: 'step' };
  }

  return { value: 'readonly', source: 'default' };
}

const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  readonly: 0,
  edit: 1,
  full: 2,
};

function applyRequiredPermissionFloorWithSource(
  resolvedMode: PermissionMode,
  requiredMode: PermissionMode | undefined,
  source: ProviderResolutionSource,
): ResolvedPermissionMode {
  // The floor only becomes the source when it actually raises the mode; an
  // equal profile value keeps its own resolution source.
  const floorApplied = requiredMode !== undefined
    && PERMISSION_MODE_RANK[requiredMode] > PERMISSION_MODE_RANK[resolvedMode];
  return {
    value: floorApplied ? requiredMode : resolvedMode,
    source: floorApplied ? 'step' : source,
  };
}
