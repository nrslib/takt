export type ContractFamilyToolClass = 'edit-tools' | 'read-tools' | 'tool-less';

export interface ContractFamilyRoleExpectation {
  readonly requiredTag: string;
  readonly phase: 'plan' | 'edit' | 'review' | 'companion';
  readonly edit: boolean;
  readonly requiredPermissionModes: readonly string[];
  readonly toolClasses: readonly ContractFamilyToolClass[];
}

export const CONTRACT_FAMILY_ROLE_MANIFEST = {
  'plan-replan': { requiredTag: 'plan', phase: 'plan', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  implement: { requiredTag: 'coding', phase: 'edit', edit: true, requiredPermissionModes: ['edit', 'unspecified'], toolClasses: ['edit-tools'] },
  'test-authoring': { requiredTag: 'coding', phase: 'edit', edit: true, requiredPermissionModes: ['edit'], toolClasses: ['edit-tools'] },
  'fix-plan': { requiredTag: 'plan', phase: 'plan', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  fix: { requiredTag: 'coding', phase: 'edit', edit: true, requiredPermissionModes: ['edit', 'unspecified'], toolClasses: ['edit-tools'] },
  'fix-retry': { requiredTag: 'coding', phase: 'edit', edit: true, requiredPermissionModes: ['edit'], toolClasses: ['edit-tools'] },
  'fix-verifier': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'initial-review': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'follow-up-review': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'review-by-mode': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'review-adjudication': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'final-preservation': { requiredTag: 'review', phase: 'review', edit: false, requiredPermissionModes: ['unspecified'], toolClasses: ['read-tools'] },
  'companion-early-scan': { requiredTag: 'companion', phase: 'companion', edit: false, requiredPermissionModes: ['tool-less'], toolClasses: ['tool-less'] },
  'companion-evidence-boundary': { requiredTag: 'companion', phase: 'companion', edit: false, requiredPermissionModes: ['tool-less'], toolClasses: ['tool-less'] },
} as const satisfies Record<string, ContractFamilyRoleExpectation>;

interface OutsideRule {
  readonly matches: RegExp;
  readonly reason: string;
}

const OUTSIDE_RULES: readonly OutsideRule[] = [
  { matches: /^audit-[^/]+\//u, reason: 'Repository-wide audit inventory is not a changed contract family workflow.' },
  { matches: /^auto-improvement-loop\//u, reason: 'Improvement routing selects a task; it does not close a presented contract family.' },
  { matches: /^compound-eye\//u, reason: 'Generic multi-answer deliberation has no changed-family contract.' },
  { matches: /^(?:deep-research|research)\//u, reason: 'Research planning and synthesis do not edit or verify a code contract family.' },
  { matches: /^magi\//u, reason: 'Generic deliberation has no code-family authority.' },
  { matches: /^review-[^/]+\/[^/]+:gather$/u, reason: 'Review target gathering supplies evidence but does not inspect or decide a family.' },
  { matches: /^review-(?:default|takt-default)\/[^/]+:(?:review-synthesis|supervise)$/u, reason: 'This legacy inline step only consolidates existing reports outside the peer-review remediation contract.' },
];

export function outsideContractFamilyReason(path: string): string | undefined {
  return OUTSIDE_RULES.find((rule) => rule.matches.test(path))?.reason;
}
