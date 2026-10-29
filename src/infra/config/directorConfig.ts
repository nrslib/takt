import type { GlobalConfig } from '../../core/models/config-types.js';

export function resolveDirectorConfig(config: GlobalConfig): { patrolInterval: number } {
  return { patrolInterval: config.director?.patrolInterval ?? 900 };
}
