import type { GlobalConfig } from '../../core/models/config-types.js';

export function resolveDirectorConfig(config: GlobalConfig) {
  return { patrolInterval: config.director?.patrolInterval ?? 900, slack: config.director?.slack };
}
