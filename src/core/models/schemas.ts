/**
 * Public schema entry point.
 *
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import type { CacciaSettings } from './config-types.js';

export * from './schema-base.js';
export * from './workflow-schemas.js';
export * from './config-schemas.js';

export const DEFAULT_CACCIA_SETTINGS: Readonly<CacciaSettings> = Object.freeze({
  enabled: false,
  waitTimeoutMs: 600_000,
  maxIterations: 3,
  workflow: 'caccia',
});
