/**
 * Shared constants for repertoire package manifest handling.
 */

// REPERTOIRE_DIR_NAME is defined in infra/config/constants to avoid an
// upward infra → features dependency from paths.ts.
export { REPERTOIRE_DIR_NAME } from '../../infra/config/constants.js';

/** Manifest filename inside a package repository and installed package directory. */
export const TAKT_REPERTOIRE_MANIFEST_FILENAME = 'takt-repertoire.yaml';

/** Lock file filename inside an installed package directory. */
export const TAKT_REPERTOIRE_LOCK_FILENAME = '.takt-repertoire-lock.yaml';
