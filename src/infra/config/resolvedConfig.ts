import type { PersistedGlobalConfig } from '../../core/models/persisted-global-config.js';

export interface LoadedConfig extends PersistedGlobalConfig {
  piece: string;
}

export type ConfigParameterKey = keyof LoadedConfig;
