import type { PersistedGlobalConfig } from '../../core/models/persisted-global-config.js';
import type { ProjectLocalConfig } from './types.js';
import type { MigratedProjectLocalConfigKey } from './migratedProjectLocalKeys.js';

export interface LoadedConfig
  extends PersistedGlobalConfig,
    Pick<ProjectLocalConfig, MigratedProjectLocalConfigKey> {
  logLevel: NonNullable<ProjectLocalConfig['logLevel']>;
  minimalOutput: NonNullable<ProjectLocalConfig['minimalOutput']>;
  verbose: NonNullable<ProjectLocalConfig['verbose']>;
  concurrency: NonNullable<ProjectLocalConfig['concurrency']>;
  taskPollIntervalMs: NonNullable<ProjectLocalConfig['taskPollIntervalMs']>;
  interactivePreviewMovements: NonNullable<ProjectLocalConfig['interactivePreviewMovements']>;
}

export type ConfigParameterKey = keyof LoadedConfig;
