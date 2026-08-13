export const MAX_COMPANION_INTERVAL_MS = 2_147_483_647;

export interface CompanionSelection {
  readonly fixed: readonly string[];
  readonly pool: readonly string[];
  readonly moderator?: string;
}

export interface ResolvedCompanionDefinition {
  readonly name: string;
  readonly description: string;
  readonly persona?: string;
  readonly personaContent?: string;
  readonly policy?: readonly string[];
  readonly policyContents?: readonly string[];
  readonly knowledge?: readonly string[];
  readonly knowledgeContents?: readonly string[];
  readonly instruction: string;
  readonly instructionRef: string;
  readonly intervalMs: number;
  readonly sourcePath?: string;
}

export type CompanionFindingSeverity = 'must_fix' | 'should_fix' | 'nit';
export type CompanionFindingStatus = 'open' | 'resolved' | 'unresolved' | 'wontfix_accepted';
export type CompanionFindingUpdateStatus = Exclude<CompanionFindingStatus, 'open'>;

export interface CompanionFinding {
  readonly id: string;
  readonly severity: CompanionFindingSeverity;
  readonly file: string;
  readonly line: number;
  readonly finding: string;
  readonly status: CompanionFindingStatus;
}

export type CompanionFindingEvidence = Pick<
  CompanionFinding,
  'id' | 'severity' | 'file' | 'line' | 'finding'
>;

export interface CompanionWorkflowState {
  escalated: boolean;
  completionVerified: boolean;
  completionFailure?: boolean;
  openMustFixCount: number;
  openMustFix: CompanionFindingEvidence[];
  reason?: string;
}
