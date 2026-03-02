/**
 * Shared infrastructure-level constants.
 *
 * Defined here (infra/config) rather than features/repertoire so that
 * infra/config/paths.ts can reference the directory name without creating
 * an upward infra → features dependency.
 */

/** Directory name for the repertoire packages dir (~/.takt/repertoire). */
export const REPERTOIRE_DIR_NAME = 'repertoire';
