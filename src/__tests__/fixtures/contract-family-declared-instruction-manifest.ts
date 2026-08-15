export interface DeclaredInstructionExpectation {
  readonly role: string;
  readonly wrapper: string;
}

const expectation = (role: string, wrapper: string): DeclaredInstructionExpectation => ({ role, wrapper });

export const DECLARED_INSTRUCTION_MANIFEST: Readonly<Record<string, DeclaredInstructionExpectation>> = {
  plan: expectation('plan-replan', 'contract-family-plan-replan'),
  'simple-plan': expectation('plan-replan', 'contract-family-plan-replan'),
  'plan-maintenance': expectation('plan-replan', 'contract-family-plan-replan'),
  'scenario-based-plan': expectation('plan-replan', 'contract-family-plan-replan'),
  'replan-implementation': expectation('plan-replan', 'contract-family-plan-replan'),
  'scenario-based-replan-implementation': expectation('plan-replan', 'contract-family-plan-replan'),
  implement: expectation('implement', 'contract-family-implement'),
  'simple-implement': expectation('implement', 'contract-family-implement'),
  'simple-implement-after-tests': expectation('implement', 'contract-family-implement'),
  'implement-after-tests': expectation('implement', 'contract-family-implement'),
  'implement-maintenance': expectation('implement', 'contract-family-implement'),
  'implement-terraform': expectation('implement', 'contract-family-implement'),
  'write-tests-first': expectation('test-authoring', 'contract-family-test-authoring'),
  'simple-write-tests-first': expectation('test-authoring', 'contract-family-test-authoring'),
  'scenario-based-write-tests-first': expectation('test-authoring', 'contract-family-test-authoring'),
  'implement-test': expectation('test-authoring', 'contract-family-test-authoring'),
  'e2e-coverage-implement': expectation('test-authoring', 'contract-family-test-authoring'),
  'fix-plan': expectation('fix-plan', 'contract-family-fix-plan'),
  'fix-plan-from-review-resolution': expectation('fix-plan', 'contract-family-fix-plan'),
  'scenario-based-fix-plan-from-review-resolution': expectation('fix-plan', 'contract-family-fix-plan'),
  fix: expectation('fix', 'contract-family-fix'),
  'simple-fix': expectation('fix', 'contract-family-fix'),
  'ai-antipattern-fix': expectation('fix', 'contract-family-fix'),
  'fix-maintenance': expectation('fix', 'contract-family-fix'),
  'fix-supervisor': expectation('fix', 'contract-family-fix'),
  'apply-fix-plan': expectation('fix', 'contract-family-fix'),
  'apply-fix-verification': expectation('fix-retry', 'contract-family-fix-retry'),
  'verify-fix': expectation('fix-verifier', 'contract-family-fix-verifier'),
  'architecture-review': expectation('initial-review', 'contract-family-initial-review'),
  'coding-review': expectation('initial-review', 'contract-family-initial-review'),
  'cqrs-es-review': expectation('initial-review', 'contract-family-initial-review'),
  'frontend-review': expectation('initial-review', 'contract-family-initial-review'),
  'security-review': expectation('initial-review', 'contract-family-initial-review'),
  'testing-review': expectation('initial-review', 'contract-family-initial-review'),
  'initial-ai-antipattern-review': expectation('initial-review', 'contract-family-initial-review'),
  'follow-up-architecture-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-coding-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-cqrs-es-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-frontend-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-security-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-testing-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'follow-up-ai-antipattern-review': expectation('follow-up-review', 'contract-family-follow-up-review'),
  'ai-antipattern-review': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'contract-lifecycle-review': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-arch': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-coding': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'simple-review-coding': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-cqrs-es': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-frontend': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-implementation-semantics': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-security': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-terraform': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'review-test': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'robustness-review': expectation('review-by-mode', 'contract-family-review-by-mode'),
  'adjudicate-review-findings': expectation('review-adjudication', 'contract-family-review-adjudication'),
  'supervise-review-resolution': expectation('final-preservation', 'contract-family-final-preservation'),
  'scenario-based-supervise-review-resolution': expectation('final-preservation', 'contract-family-final-preservation'),
  supervise: expectation('final-preservation', 'contract-family-final-preservation'),
  'simple-supervise': expectation('final-preservation', 'contract-family-final-preservation'),
  'companion-watch-review': expectation('companion-early-scan', 'contract-family-companion-early-scan'),
  'companion-watch-testing': expectation('companion-early-scan', 'contract-family-companion-early-scan'),
  'companion-moderate-review': expectation('companion-evidence-boundary', 'contract-family-companion-evidence-boundary'),
  'team-leader-implement': expectation('decomposition-boundary', 'contract-family-decomposition-boundary'),
  'dual-team-leader-implement': expectation('decomposition-boundary', 'contract-family-decomposition-boundary'),
  'team-leader-fix': expectation('decomposition-boundary', 'contract-family-decomposition-boundary'),
  'team-leader-ai-antipattern-fix': expectation('decomposition-boundary', 'contract-family-decomposition-boundary'),
};

export const COMPANION_DECLARATION_MANIFEST = {
  'ai-antipattern-review-companion': 'companion-watch-review',
  'testing-review-companion': 'companion-watch-testing',
  'review-companion-moderator': 'companion-moderate-review',
} as const;

interface CallerPathExpectation extends DeclaredInstructionExpectation {
  readonly matches: RegExp;
}

const caller = (
  matches: RegExp,
  role: string,
  wrapper: string,
): CallerPathExpectation => ({ matches, role, wrapper });

/**
 * Expected role at each active caller position. These rules intentionally do
 * not inspect the declared instruction or the assembled prompt, so changing a
 * caller to another valid instruction cannot redefine its own expectation.
 */
const CALLER_PATH_MANIFEST: readonly CallerPathExpectation[] = [
  caller(/\/steps\[\d+\]:plan$/u, 'plan-replan', 'contract-family-plan-replan'),
  caller(/\/steps\[\d+\]:replan$/u, 'plan-replan', 'contract-family-plan-replan'),
  caller(/\/steps\[\d+\]:write_tests$/u, 'test-authoring', 'contract-family-test-authoring'),
  caller(/\/steps\[\d+\]:implement$/u, 'implement', 'contract-family-implement'),
  caller(/\/steps\[\d+\]:fix-plan$/u, 'fix-plan', 'contract-family-fix-plan'),
  caller(/\/steps\[\d+\]:fix$/u, 'fix', 'contract-family-fix'),
  caller(/\/steps\[\d+\]:fix-retry$/u, 'fix-retry', 'contract-family-fix-retry'),
  caller(/\/steps\[\d+\]:fix-verifier$/u, 'fix-verifier', 'contract-family-fix-verifier'),
  caller(/(?:^|\/call:)mini-core\/steps\[3\]:fix_both\/parallel\[0\]:ai-antipattern-fix-parallel$/u, 'fix', 'contract-family-fix'),
  caller(/(?:^|\/call:)mini-core\/steps\[3\]:fix_both\/parallel\[1\]:supervise_fix_parallel$/u, 'fix', 'contract-family-fix'),
  caller(/(?:^|\/call:)mini-core\/steps\[(?:4|5)\]:(?:ai-antipattern-fix|supervise_fix)$/u, 'fix', 'contract-family-fix'),
  caller(/\/call:peer-review\/steps\[0\]:initial-reviewers\//u, 'initial-review', 'contract-family-initial-review'),
  caller(/\/call:peer-review\/steps\[1\]:reviewers\//u, 'follow-up-review', 'contract-family-follow-up-review'),
  caller(/^peer-review\/(?:peer-review\/)?steps\[0\]:initial-reviewers\//u, 'initial-review', 'contract-family-initial-review'),
  caller(/^peer-review\/(?:peer-review\/)?steps\[1\]:reviewers\//u, 'follow-up-review', 'contract-family-follow-up-review'),
  caller(/^peer-review-suite-[^/]+\/.*\/parallel\[\d+\]:(?!ai-antipattern-review-2nd$)[^/]+$/u, 'initial-review', 'contract-family-initial-review'),
  caller(/^peer-review-suite-[^/]+\/.*\/parallel\[\d+\]:ai-antipattern-review-2nd$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/^(?:takt-)?experimental-review(?:-adapter)?\/.*\/parallel\[\d+\]:(?!ai-antipattern-review$)[^/]+$/u, 'initial-review', 'contract-family-initial-review'),
  caller(/^(?:takt-)?experimental-review(?:-adapter)?\/.*\/parallel\[\d+\]:ai-antipattern-review$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/^(?!.*\/call:peer-review\/)review-[^/]+\/.*\/parallel\[\d+\]:[^/]+$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/^terraform\/steps\[2\]:reviewers\/parallel\[\d+\]:[^/]+$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/^terraform\/steps\[(?:3|4)\]:(?:final-supervise|supervise)$/u, 'final-preservation', 'contract-family-final-preservation'),
  caller(/^terraform\/steps\[5\]:fix_both\/parallel\[\d+\]:(?:ai-antipattern-fix-parallel|supervise_fix_parallel)$/u, 'fix', 'contract-family-fix'),
  caller(/^terraform\/steps\[(?:6|7)\]:(?:ai-antipattern-fix|supervise_fix)$/u, 'fix', 'contract-family-fix'),
  caller(/^simple-mini\/steps\[2\]:review$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/(?:^|\/call:)simple-core\/steps\[3\]:review$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/(?:^|\/call:)mini-core\/steps\[2\]:reviewers\/parallel\[0\]:ai-antipattern-review-2nd$/u, 'review-by-mode', 'contract-family-review-by-mode'),
  caller(/\/steps\[\d+\]:review-adjudication$/u, 'review-adjudication', 'contract-family-review-adjudication'),
  caller(/\/steps\[\d+\]:final-gate$/u, 'final-preservation', 'contract-family-final-preservation'),
  caller(/^review-[^/]+\/steps\[\d+\]:(?:review-synthesis|supervise)$/u, 'final-preservation', 'contract-family-final-preservation'),
  caller(/(?:^|\/call:)final-gate\/steps\[\d+\]:supervise$/u, 'final-preservation', 'contract-family-final-preservation'),
  caller(/(?:^|\/call:)(?:mini-core|simple-core)\/steps\[\d+\]:(?:reviewers\/parallel\[1\]:)?supervise$/u, 'final-preservation', 'contract-family-final-preservation'),
];

export function callerPathExpectation(path: string): DeclaredInstructionExpectation | undefined {
  const matches = CALLER_PATH_MANIFEST.filter((entry) => entry.matches.test(path));
  if (matches.length > 1) throw new Error(`Ambiguous contract-family caller path: ${path}`);
  const match = matches[0];
  return match === undefined ? undefined : { role: match.role, wrapper: match.wrapper };
}
