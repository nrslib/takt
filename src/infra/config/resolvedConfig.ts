import type { PersistedGlobalConfig } from '../../core/models/persisted-global-config.js';

export interface LoadedConfig extends Omit<PersistedGlobalConfig, 'provider' | 'verbose'> {
  piece: string;
  provider: NonNullable<PersistedGlobalConfig['provider']>;
  verbose: boolean;
}

export type ConfigParameterKey = keyof LoadedConfig;
