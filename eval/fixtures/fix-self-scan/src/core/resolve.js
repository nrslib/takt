import { ORIGINS } from './constants.js';

// Maps a config value origin to the label shown in run summaries.
// Origins the mapping does not know are labeled with the caller-supplied
// placeholder.
export function sourceLabel(origin, fallback) {
  if (!ORIGINS.includes(origin)) {
    throw new Error(`unrecognized origin: ${origin}`);
  }
  if (origin === 'env' || origin === 'cli') return 'override';
  if (origin === 'local') return 'project';
  if (origin === 'global') return 'global';
  return fallback;
}
