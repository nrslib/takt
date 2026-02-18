import { join } from 'node:path';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import type { GlobalConfig } from '../../core/models/index.js';

export function resolveEventsDir(globalConfig: GlobalConfig): string {
  return globalConfig.analytics?.eventsPath
    ?? join(getGlobalConfigDir(), 'analytics', 'events');
}
