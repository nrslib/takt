/**
 * Contract strings for the runtime.yaml provider configuration (issue #1136).
 *
 * These are the fixed file name / version literal / reserved profile name that the
 * loader, schema, mode detection and first-run generation all agree on. Defined once
 * here so the contract is not duplicated across modules.
 */

/** Fixed file name looked up under both `~/.takt/` and `<project>/.takt/`. */
export const RUNTIME_PROVIDER_FILENAME = 'runtime.yaml';

/** Only supported schema version for runtime.yaml. */
export const RUNTIME_PROVIDER_VERSION = 1 as const;

/** Profile/target name generated for a fresh environment's first run. */
export const DEFAULT_PROFILE_NAME = 'default';
