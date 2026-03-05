/**
 * Config module type definitions
 *
 * ProjectConfig is now defined in core/models/config-types.ts.
 * This file re-exports it for backward compatibility within the config module.
 */

export type { ProjectConfig, ProjectConfig as ProjectLocalConfig } from '../../core/models/config-types.js';

/** Persona session data for persistence */
export interface PersonaSessionData {
  personaSessions: Record<string, string>;
  updatedAt: string;
  /** Provider that created these sessions (claude, codex, etc.) */
  provider?: string;
}
