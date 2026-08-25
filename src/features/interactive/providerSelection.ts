import type { ProviderType } from '../../shared/types/provider.js';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import { getLabel } from '../../shared/i18n/index.js';
import { selectOptionWithDefault } from '../../shared/prompt/index.js';

/** Select the provider used by subsequent calls in the current TUI conversation. */
export function selectInteractiveProvider(
  lang: 'en' | 'ja',
  currentProvider: ProviderType,
): Promise<ProviderType | null> {
  return selectOptionWithDefault(
    getLabel('interactive.providerSelection.prompt', lang),
    PROVIDER_TYPES.map((provider) => ({ label: provider, value: provider })),
    currentProvider,
  );
}
