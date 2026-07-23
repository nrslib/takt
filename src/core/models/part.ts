import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { ProviderType } from '../../shared/types/provider.js';

/** Part definition produced by step team leader agent */
export interface PartDefinition {
  /** Unique ID inside the parent step */
  id: string;
  /** Human-readable title */
  title: string;
  /** Instruction passed to the part agent */
  instruction: string;
  /** Finding Contract assignment for finding_contract_fix Team Leader parts. */
  findingContract?: FindingContractPartAssignment;
}

export type TeamLeaderMode = 'finding_contract_fix';

export interface FindingContractPartAssignment {
  findingIds: string[];
  role: 'diagnose' | 'repair' | 'verify';
  writePaths: string[];
  readPaths: string[];
}

export interface FindingContractFindingOutcome {
  findingId: string;
  outcome: 'addressed' | 'disputed' | 'blocked';
  evidence: string[];
}

export interface FindingContractPartCompletionClaim {
  /** Untrusted worker claim; it does not update the finding ledger. */
  findingOutcomes: FindingContractFindingOutcome[];
  changedPaths: string[];
  checks: Array<{
    command: string;
    status: 'passed' | 'failed' | 'not_run';
  }>;
  summary: string;
}

export interface FindingContractFixCoverage {
  findingId: string;
  disposition: 'addressed' | 'disputed';
  supportingPartIds: string[];
  verificationPartIds: string[];
}

export type FindingContractTeamLeaderDecision =
  | {
      decision: 'continue';
      reasoning: string;
      parts: PartDefinition[];
    }
  | {
      decision: 'complete';
      reasoning: string;
      parts: [];
      fixCoverage: FindingContractFixCoverage[];
    }
  | {
      decision: 'replan';
      reasoning: string;
      parts: [];
      blockers: string[];
    };

/** Result of a single part execution */
export interface PartResult {
  part: PartDefinition;
  response: AgentResponse;
  providerInfo?: {
    provider: ProviderType | undefined;
    model: string | undefined;
  };
  durationMs?: number;
}

/** team_leader config on a step */
export interface TeamLeaderConfig {
  /** Specialized execution contract. Omitted for the generic Team Leader flow. */
  mode?: TeamLeaderMode;
  /** Persona reference for the team leader agent */
  persona?: string;
  /** Resolved absolute path for team leader persona */
  personaPath?: string;
  /** Display name used for team leader persona provider resolution */
  personaDisplayName?: string;
  /** Raw persona key used for team leader provider_routing.personas lookup */
  providerRoutingPersonaKey?: string;
  /** Maximum number of parts to run in parallel */
  maxConcurrency: number;
  /** Maximum number of parts the initial decomposition may create */
  initialMaxParts?: number;
  /** Fail the parent step when any member part fails. */
  failOnPartError?: boolean;
  /** Default timeout for parts in milliseconds */
  timeoutMs: number;
  /** Read-only inspection tools for the parent decomposition call */
  inspectTools?: string[];
  /** Persona reference for part agents */
  partPersona?: string;
  /** Resolved absolute path for part persona */
  partPersonaPath?: string;
  partTags?: string[];
  /** Allowed tools for part agents */
  partAllowedTools?: string[];
  /** Whether part agents can edit files */
  partEdit?: boolean;
  /** Permission mode for part agents */
  partPermissionMode?: PermissionMode;
}
