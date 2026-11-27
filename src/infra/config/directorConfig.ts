import type { GlobalConfig } from '../../core/models/config-types.js';

export function resolveDirectorConfig(config: GlobalConfig) {
  return { slack: config.director?.slack };
}
