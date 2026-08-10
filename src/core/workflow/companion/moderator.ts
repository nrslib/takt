import type { CompanionFinding, CompanionFindingSeverity } from '../../models/companion-types.js';
import type { CompanionReviewOutput } from './contracts.js';

interface ModeratorResult {
  readonly findings: readonly {
    action: 'accept' | 'reject' | 'merge' | 'downgrade';
    sourceIndex: number;
    severity?: CompanionFindingSeverity;
    finding?: string;
    targetId?: string;
  }[];
  readonly updates: CompanionReviewOutput['updates'];
}

export async function moderateCompanionResult(input: {
  reviewerResult: CompanionReviewOutput;
  openFindings: readonly CompanionFinding[];
  diffSummary: string;
  implementerExplanation?: string;
  runModerator: (request: {
    reviewerResult: CompanionReviewOutput;
    openFindings: readonly CompanionFinding[];
    diffSummary: string;
    implementerExplanation?: string;
  }) => Promise<ModeratorResult>;
  commit: (result: CompanionReviewOutput) => Promise<void>;
}): Promise<void> {
  if (input.reviewerResult.findings.length === 0 && input.reviewerResult.updates.length === 0) {
    if (input.reviewerResult.notes !== undefined) {
      await input.commit({ findings: [], updates: [], notes: input.reviewerResult.notes });
    }
    return;
  }
  const moderated = await input.runModerator({
    reviewerResult: input.reviewerResult,
    openFindings: input.openFindings,
    diffSummary: input.diffSummary,
    ...(input.implementerExplanation === undefined
      ? {}
      : { implementerExplanation: input.implementerExplanation }),
  });
  validateDecisions(moderated, input.reviewerResult, input.openFindings);
  const findings = moderated.findings.flatMap((decision) => {
    const source = input.reviewerResult.findings[decision.sourceIndex]!;
    if (decision.action === 'reject') return [];
    if (decision.action === 'merge') return [];
    if (decision.action === 'accept') return [source];
    return [{
      ...source,
      ...(decision.severity === undefined ? {} : { severity: decision.severity }),
      ...(decision.finding === undefined ? {} : { finding: decision.finding }),
    }];
  });
  await input.commit({
    findings,
    updates: moderated.updates,
    ...(input.reviewerResult.notes === undefined ? {} : { notes: input.reviewerResult.notes }),
  });
}

function validateDecisions(
  moderated: ModeratorResult,
  reviewerResult: CompanionReviewOutput,
  openFindings: readonly CompanionFinding[],
): void {
  const sourceIndexes = new Set<number>();
  for (const decision of moderated.findings) {
    const source = reviewerResult.findings[decision.sourceIndex];
    if (source === undefined) {
      throw new Error(`Moderator references unknown finding index ${decision.sourceIndex}`);
    }
    if (sourceIndexes.has(decision.sourceIndex)) {
      throw new Error(`Moderator decided finding index ${decision.sourceIndex} more than once`);
    }
    sourceIndexes.add(decision.sourceIndex);
    validateDecisionAction(decision, source, openFindings);
  }
  if (sourceIndexes.size !== reviewerResult.findings.length) {
    throw new Error('Moderator must decide every reviewer finding exactly once');
  }
}

function validateDecisionAction(
  decision: ModeratorResult['findings'][number],
  source: CompanionReviewOutput['findings'][number],
  openFindings: readonly CompanionFinding[],
): void {
  if (decision.action === 'merge') {
    if (
      decision.targetId === undefined
      || !openFindings.some(({ id }) => id === decision.targetId)
    ) {
      throw new Error(`Moderator references unknown merge target "${decision.targetId ?? ''}"`);
    }
    if (decision.severity !== undefined || decision.finding !== undefined) {
      throw new Error('Moderator merge cannot override severity or finding text');
    }
    return;
  }
  if (decision.targetId !== undefined) {
    throw new Error(`Moderator ${decision.action} cannot specify a merge target`);
  }
  if (decision.action === 'reject') {
    if (decision.severity !== undefined || decision.finding !== undefined) {
      throw new Error('Moderator reject cannot override severity or finding text');
    }
    return;
  }
  if (decision.action === 'accept') {
    if (decision.severity !== undefined || decision.finding !== undefined) {
      throw new Error('Moderator accept cannot override severity or finding text');
    }
    return;
  }
  if (
    decision.action === 'downgrade'
    && (decision.severity === undefined || !isLowerSeverity(decision.severity, source.severity))
  ) {
    throw new Error(`Moderator downgrade for finding ${decision.sourceIndex} requires a lower severity`);
  }
}

function isLowerSeverity(next: CompanionFindingSeverity, current: CompanionFindingSeverity): boolean {
  const rank: Record<CompanionFindingSeverity, number> = { must_fix: 3, should_fix: 2, nit: 1 };
  return rank[next] < rank[current];
}
