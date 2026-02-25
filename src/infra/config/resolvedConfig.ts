import type { PersistedGlobalConfig } from '../../core/models/persisted-global-config.js';

export interface LoadedConfig extends Omit<PersistedGlobalConfig, 'verbose'> {
  piece: string;
  verbose: boolean;
}

export type ConfigParameterKey = keyof LoadedConfig;
