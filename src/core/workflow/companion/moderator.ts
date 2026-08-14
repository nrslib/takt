import type { CompanionReviewOutput } from './contracts.js';

export interface ModeratorResult {
  readonly findings: readonly {
    readonly action: 'accept' | 'reject';
    readonly sourceIndex: number;
  }[];
}

export interface ModeratedCompanionResult {
  readonly moderator: ModeratorResult;
  readonly accepted: CompanionReviewOutput;
}

export async function moderateCompanionResult(input: {
  readonly reviewerResult: CompanionReviewOutput;
  readonly task: string;
  readonly cumulativeDiff: string;
  readonly diffSummary: string;
  readonly implementerExplanation?: string;
  readonly runModerator: (request: {
    readonly reviewerResult: CompanionReviewOutput;
    readonly task: string;
    readonly cumulativeDiff: string;
    readonly diffSummary: string;
    readonly implementerExplanation?: string;
  }) => Promise<ModeratorResult>;
}): Promise<ModeratedCompanionResult | undefined> {
  if (input.reviewerResult.findings.length === 0) return undefined;

  const moderated = await input.runModerator({
    reviewerResult: input.reviewerResult,
    task: input.task,
    cumulativeDiff: input.cumulativeDiff,
    diffSummary: input.diffSummary,
    ...(input.implementerExplanation === undefined
      ? {}
      : { implementerExplanation: input.implementerExplanation }),
  });
  validateModeratorDecisions(moderated, input.reviewerResult);
  return {
    moderator: moderated,
    accepted: {
      findings: moderated.findings.flatMap((decision) => (
        decision.action === 'accept'
          ? [input.reviewerResult.findings[decision.sourceIndex]!]
          : []
      )),
      ...(input.reviewerResult.notes === undefined
        ? {}
        : { notes: input.reviewerResult.notes }),
    },
  };
}

export function validateModeratorDecisions(
  moderated: ModeratorResult,
  reviewerResult: CompanionReviewOutput,
): void {
  const sourceIndexes = new Set<number>();
  for (const decision of moderated.findings) {
    if (reviewerResult.findings[decision.sourceIndex] === undefined) {
      throw new Error(`Moderator references unknown finding index ${decision.sourceIndex}`);
    }
    if (sourceIndexes.has(decision.sourceIndex)) {
      throw new Error(`Moderator decided finding index ${decision.sourceIndex} more than once`);
    }
    sourceIndexes.add(decision.sourceIndex);
  }
  if (sourceIndexes.size !== reviewerResult.findings.length) {
    throw new Error('Moderator must decide every reviewer finding exactly once');
  }
}
