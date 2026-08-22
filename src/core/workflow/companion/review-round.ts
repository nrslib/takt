import type { AgentResponse } from '../../models/index.js';
import type { CompanionFinding } from '../../models/companion-types.js';
import {
  MODERATOR_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_JSON_SCHEMA,
  parseCompanionReviewOutput,
  parseModeratorOutput,
  type CompanionReviewOutput,
} from './contracts.js';
import type { CompanionDiff } from './diff-reader.js';
import { appendCompanionMailboxFindings } from './mailbox.js';
import {
  moderateCompanionResult,
  validateModeratorDecisions,
  type ModeratorResult,
} from './moderator.js';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from './prompt.js';
import type {
  CompanionAgentPurpose,
  CompanionStructuredResponseValidator,
} from './review-runner.js';
import type { CompanionReviewRequest } from './review-queue.js';

interface CompanionReviewRoundInput {
  readonly companionName: string;
  readonly diff: CompanionDiff;
  readonly baselineSha: string;
  readonly trigger: CompanionReviewRequest['reason'];
  readonly observedGeneration: number;
  readonly implementerExplanation?: string;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly stepName: string;
  readonly moderatorName?: string;
  readonly mailboxPath: string;
  readonly systemPrompt: (name: string) => string;
  readonly callStructured: (
    purpose: CompanionAgentPurpose,
    agentName: string,
    systemPrompt: string,
    prompt: string,
    outputSchema: Record<string, unknown>,
    signal: AbortSignal,
    validateResponse?: CompanionStructuredResponseValidator,
  ) => Promise<AgentResponse>;
  readonly emitFinding: (finding: CompanionFinding) => void;
  readonly markReviewed: (snapshot: CompanionDiff, observedGeneration: number) => void;
  readonly onRoundCompleted: (round: CompanionReviewRoundAudit) => void;
}

export interface CompanionReviewRoundAudit {
  readonly snapshot: CompanionDiff;
  readonly trigger: CompanionReviewRequest['reason'];
  readonly reviewerResult: CompanionReviewOutput;
  readonly moderator: CompanionModeratorRoundAudit;
  readonly accepted: CompanionReviewOutput;
  readonly acceptedRows: readonly CompanionFinding[];
}

export interface CompanionModeratorRoundAudit {
  readonly name: string;
  readonly invoked: boolean;
  readonly reason?: 'reviewer_result_empty' | 'not_configured';
  readonly result?: ModeratorResult;
}

export interface CompanionReviewRoundResult {
  readonly acceptedRows: readonly CompanionFinding[];
}

export async function executeCompanionReviewRound(
  input: CompanionReviewRoundInput,
): Promise<CompanionReviewRoundResult> {
  input.signal.throwIfAborted();
  const reviewerResponse = await input.callStructured(
    'reviewer',
    input.companionName,
    input.systemPrompt(input.companionName),
    buildCompanionReviewPrompt({
      companionName: input.companionName,
      task: input.task,
      stepName: input.stepName,
      baselineSha: input.baselineSha,
      implementerExplanation: input.implementerExplanation,
    }),
    REVIEW_OUTPUT_JSON_SCHEMA,
    input.signal,
    (candidate) => {
      parseCompanionReviewOutput(candidate.structuredOutput);
    },
  );
  input.signal.throwIfAborted();
  const reviewerResult = parseCompanionReviewOutput(reviewerResponse.structuredOutput);
  const moderated = await moderateReviewerResult(input, reviewerResult);
  input.signal.throwIfAborted();

  const acceptedRows = appendCompanionMailboxFindings({
    path: input.mailboxPath,
    companionName: input.companionName,
    reviewedAt: new Date().toISOString(),
    reviewedDigest: input.diff.digest,
    findings: moderated.accepted.findings,
  });
  input.markReviewed(input.diff, input.observedGeneration);
  for (const finding of acceptedRows) input.emitFinding(finding);
  input.onRoundCompleted({
    snapshot: input.diff,
    trigger: input.trigger,
    reviewerResult,
    moderator: moderated.audit,
    accepted: moderated.accepted,
    acceptedRows,
  });
  return { acceptedRows };
}

async function moderateReviewerResult(
  input: CompanionReviewRoundInput,
  reviewerResult: CompanionReviewOutput,
): Promise<{
  readonly accepted: CompanionReviewOutput;
  readonly audit: CompanionModeratorRoundAudit;
}> {
  const moderatorName = input.moderatorName;
  if (moderatorName === undefined) {
    return {
      accepted: reviewerResult,
      audit: { name: 'not-configured', invoked: false, reason: 'not_configured' },
    };
  }

  const moderated = await moderateCompanionResult({
    reviewerResult,
    task: input.task,
    baselineSha: input.baselineSha,
    implementerExplanation: input.implementerExplanation,
    runModerator: async (request) => {
      const response = await input.callStructured(
        'moderator',
        moderatorName,
        input.systemPrompt(moderatorName),
        buildCompanionModeratorPrompt(request),
        MODERATOR_OUTPUT_JSON_SCHEMA,
        input.signal,
        (candidate) => {
          validateModeratorDecisions(
            parseModeratorOutput(candidate.structuredOutput),
            reviewerResult,
          );
        },
      );
      input.signal.throwIfAborted();
      return parseModeratorOutput(response.structuredOutput);
    },
  });
  if (moderated === undefined) {
    return {
      accepted: reviewerResult,
      audit: { name: moderatorName, invoked: false, reason: 'reviewer_result_empty' },
    };
  }
  return {
    accepted: moderated.accepted,
    audit: { name: moderatorName, invoked: true, result: moderated.moderator },
  };
}
