/**
 * 権限プロファイル解決の回帰テスト。
 *
 * 実障害: ユーザーが一部プロバイダだけ provider_profiles を書くと、
 * デフォルト表が丸ごと置き換わり、未記載プロバイダ（opencode 等）が
 * readonly に落ちて edit: true のステップが書き込みツールなしで走った。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_PERMISSION_PROFILES,
  mergeGlobalPermissionProfiles,
  resolveStepPermissionMode,
} from '../core/workflow/permission-profile-resolution.js';

describe('resolveStepPermissionMode with partial user profiles', () => {
  it('should keep the default mode for providers the user did not configure when profiles are merged', () => {
    // runner が実際に使うマージ関数を通す（再現コードではなく実装をテストする）
    const merged = mergeGlobalPermissionProfiles({
      claude: { defaultPermissionMode: 'full' },
    });

    const mode = resolveStepPermissionMode({
      stepName: 'implement',
      requiredPermissionMode: undefined,
      provider: 'opencode',
      projectProviderProfiles: undefined,
      globalProviderProfiles: merged,
    });

    expect(mode).toBe(DEFAULT_PROVIDER_PERMISSION_PROFILES.opencode!.defaultPermissionMode);
    expect(mode).not.toBe('readonly');
  });

  it('should fall back to readonly when a provider is missing from an unmerged map (the failure shape)', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'implement',
      requiredPermissionMode: undefined,
      provider: 'opencode',
      projectProviderProfiles: undefined,
      globalProviderProfiles: { claude: { defaultPermissionMode: 'full' } },
    });

    expect(mode).toBe('readonly');
  });

  it('should honor the edit floor when the step requires edit', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'implement',
      requiredPermissionMode: 'edit',
      provider: 'opencode',
      projectProviderProfiles: undefined,
      globalProviderProfiles: { claude: { defaultPermissionMode: 'full' } },
    });

    expect(mode).toBe('edit');
  });
});
