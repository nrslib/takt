import type { PersistedGlobalConfig } from '../../core/models/persisted-global-config.js';

export type LoadedConfig = PersistedGlobalConfig;

export type ConfigParameterKey = keyof LoadedConfig;
