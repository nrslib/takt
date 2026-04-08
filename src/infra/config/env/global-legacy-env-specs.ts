import type { LegacyEnvSpec } from './config-env-shared.js';
import { COMMON_LEGACY_ENV_SPECS } from './common-legacy-env-specs.js';

const GLOBAL_ONLY_LEGACY_ENV_SPECS: readonly LegacyEnvSpec[] = [
  {
    env: 'TAKT_ENABLE_BUILTIN_PIECES',
    path: 'enable_builtin_pieces',
    canonicalPath: 'enable_builtin_workflows',
  },
  {
    env: 'TAKT_PIECE_CATEGORIES_FILE',
    path: 'piece_categories_file',
    canonicalPath: 'workflow_categories_file',
  },
  {
    env: 'TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_COMPLETE',
    path: 'notification_sound_events.piece_complete',
    canonicalPath: 'notification_sound_events.workflow_complete',
  },
  {
    env: 'TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_ABORT',
    path: 'notification_sound_events.piece_abort',
    canonicalPath: 'notification_sound_events.workflow_abort',
  },
];

export const GLOBAL_LEGACY_ENV_SPECS: readonly LegacyEnvSpec[] = [
  ...COMMON_LEGACY_ENV_SPECS,
  ...GLOBAL_ONLY_LEGACY_ENV_SPECS,
];
