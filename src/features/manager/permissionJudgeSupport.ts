import type { ProviderType } from '../../shared/types/provider.js';

export function supportsManagerPermissionJudge(providerType: ProviderType): boolean {
  return providerType === 'claude' || providerType === 'claude-sdk' || providerType === 'codex';
}
