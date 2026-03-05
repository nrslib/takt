import type { GlobalConfig } from '../../core/models/config-types.js';
import type { ProjectConfig } from './types.js';

export interface LoadedConfig
  extends GlobalConfig,
    ProjectConfig {
  minimalOutput: NonNullable<ProjectConfig['minimalOutput']>;
  concurrency: NonNullable<ProjectConfig['concurrency']>;
  taskPollIntervalMs: NonNullable<ProjectConfig['taskPollIntervalMs']>;
  interactivePreviewMovements: NonNullable<ProjectConfig['interactivePreviewMovements']>;
}

export type ConfigParameterKey = keyof LoadedConfig;
