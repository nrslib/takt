import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';

/** Subtask definition produced by movement team leader agent */
export interface SubtaskDefinition {
  /** Unique ID inside the parent movement */
  id: string;
  /** Human-readable title */
  title: string;
  /** Instruction passed to the subtask agent */
  instruction: string;
  /** Optional per-subtask timeout in milliseconds */
  timeoutMs?: number;
}

/** Result of a single subtask execution */
export interface SubtaskResult {
  subtask: SubtaskDefinition;
  response: AgentResponse;
}

/** team_leader config on a movement */
export interface TeamLeaderConfig {
  /** Persona reference for the team leader agent */
  persona?: string;
  /** Resolved absolute path for team leader persona */
  personaPath?: string;
  /** Maximum number of subtasks to run in parallel */
  maxSubtasks: number;
  /** Default timeout for subtasks in milliseconds */
  timeoutMs: number;
  /** Persona reference for subtask agents */
  subtaskPersona?: string;
  /** Resolved absolute path for subtask persona */
  subtaskPersonaPath?: string;
  /** Allowed tools for subtask agents */
  subtaskAllowedTools?: string[];
  /** Whether subtask agents can edit files */
  subtaskEdit?: boolean;
  /** Permission mode for subtask agents */
  subtaskPermissionMode?: PermissionMode;
}
