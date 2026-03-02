import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';

/** Part definition produced by movement team leader agent */
export interface PartDefinition {
  /** Unique ID inside the parent movement */
  id: string;
  /** Human-readable title */
  title: string;
  /** Instruction passed to the part agent */
  instruction: string;
  /** Optional per-part timeout in milliseconds */
  timeoutMs?: number;
}

/** Result of a single part execution */
export interface PartResult {
  part: PartDefinition;
  response: AgentResponse;
}

/** team_leader config on a movement */
export interface TeamLeaderConfig {
  /** Persona reference for the team leader agent */
  persona?: string;
  /** Resolved absolute path for team leader persona */
  personaPath?: string;
  /** Maximum number of parts to run in parallel */
  maxParts: number;
  /** Trigger additional planning when queued parts drop to this threshold or below */
  refillThreshold: number;
  /** Default timeout for parts in milliseconds */
  timeoutMs: number;
  /** Persona reference for part agents */
  partPersona?: string;
  /** Resolved absolute path for part persona */
  partPersonaPath?: string;
  /** Allowed tools for part agents */
  partAllowedTools?: string[];
  /** Whether part agents can edit files */
  partEdit?: boolean;
  /** Permission mode for part agents */
  partPermissionMode?: PermissionMode;
}
