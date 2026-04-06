import type { Language } from '../../../core/models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { loadGlobalConfig, saveGlobalConfig } from './globalConfigCore.js';

export function getDisabledBuiltins(): string[] {
  const config = loadGlobalConfig();
  return config.disabledBuiltins ?? [];
}

export function getBuiltinPiecesEnabled(): boolean {
  const config = loadGlobalConfig();
  return config.enableBuiltinPieces !== false;
}

export function getLanguage(): Language {
  const config = loadGlobalConfig();
  return config.language ?? DEFAULT_LANGUAGE;
}

export function setLanguage(language: Language): void {
  const config = loadGlobalConfig();
  config.language = language;
  saveGlobalConfig(config);
}

export function setProvider(provider: ProviderType): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}
