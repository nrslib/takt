import type { AgentResponse, Language, ReviewCompletionConfig } from '../models/types.js';
import type { ReviewCompletionEvidence } from './review-completion-evidence.js';

export const REVIEW_COMPLETION_JUDGE_NAME = 'review-completion-judge';
export const REVIEW_COMPLETION_SCHEMA_REF = 'takt.review-completion.decision';

export type ReviewCompletionMode = 'initial' | 'follow_up';

export const REVIEW_COMPLETION_GAP_KINDS = [
  'initial_changed_target_gap',
  'family_lifecycle_gap',
  'accepted_family_unvisited_consumer',
  'remediation_regression',
  'direct_acceptance_criterion_violation',
  'required_consumer_migration',
] as const;

export type ReviewCompletionGapKind = typeof REVIEW_COMPLETION_GAP_KINDS[number];

const INITIAL_REVIEW_COMPLETION_GAP_KINDS = [
  'initial_changed_target_gap',
  'family_lifecycle_gap',
] as const satisfies readonly ReviewCompletionGapKind[];

const FOLLOW_UP_REVIEW_COMPLETION_GAP_KINDS = [
  'accepted_family_unvisited_consumer',
  'remediation_regression',
  'direct_acceptance_criterion_violation',
  'required_consumer_migration',
] as const satisfies readonly ReviewCompletionGapKind[];

function allowedGapKinds(mode: ReviewCompletionMode): readonly ReviewCompletionGapKind[] {
  return mode === 'initial'
    ? INITIAL_REVIEW_COMPLETION_GAP_KINDS
    : FOLLOW_UP_REVIEW_COMPLETION_GAP_KINDS;
}

export function buildReviewCompletionOutputSchema(
  mode: ReviewCompletionMode,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['complete', 'reason', 'missing_obligations'],
    properties: {
      complete: { type: 'boolean' },
      reason: { type: 'string', minLength: 1 },
      missing_obligations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'contract_family', 'path', 'reason'],
          properties: {
            kind: { type: 'string', enum: [...allowedGapKinds(mode)] },
            contract_family: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };
}

export interface ReviewCompletionGap {
  readonly kind: ReviewCompletionGapKind;
  readonly contractFamily: string;
  readonly path: string;
  readonly reason: string;
}

export interface ReviewCompletionDecision {
  readonly complete: boolean;
  readonly reason: string;
  readonly missingObligations: readonly ReviewCompletionGap[];
}

export interface ReviewCompletionDiagnostic {
  readonly kind: 'max_retry_reached' | 'judge_unavailable' | 'reviewer_retry_failed';
  readonly attempts: number;
  readonly retriesUsed: number;
  readonly reason: string;
  readonly missingObligations: readonly ReviewCompletionGap[];
}

export interface ReviewCompletionEpisodeResult {
  readonly response: AgentResponse;
  readonly reviewerSessionId: string | undefined;
  readonly attempts: number;
  readonly diagnostic?: ReviewCompletionDiagnostic;
}

export interface ReviewCompletionAttemptInput {
  readonly attemptIndex: number;
  readonly mode: ReviewCompletionMode;
  readonly instruction: string;
  readonly sessionId: string | undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Review completion judge returned invalid ${field}`);
  }
  return value.trim();
}

export function parseReviewCompletionDecision(
  value: unknown,
  mode: ReviewCompletionMode,
): ReviewCompletionDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Review completion judge returned no structured decision');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== 'boolean' || !Array.isArray(raw.missing_obligations)) {
    throw new Error('Review completion judge returned an invalid structured decision');
  }
  const missingObligations = raw.missing_obligations.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Review completion judge returned invalid missing_obligations[${index}]`);
    }
    const gap = entry as Record<string, unknown>;
    if (!allowedGapKinds(mode).includes(gap.kind as ReviewCompletionGapKind)) {
      throw new Error(`Review completion judge returned invalid missing_obligations[${index}].kind`);
    }
    return {
      kind: gap.kind as ReviewCompletionGapKind,
      contractFamily: requiredString(gap.contract_family, `missing_obligations[${index}].contract_family`),
      path: requiredString(gap.path, `missing_obligations[${index}].path`),
      reason: requiredString(gap.reason, `missing_obligations[${index}].reason`),
    };
  });
  if (raw.complete === (missingObligations.length > 0)) {
    throw new Error('Review completion decision and missing obligations disagree');
  }
  return {
    complete: raw.complete,
    reason: requiredString(raw.reason, 'reason'),
    missingObligations,
  };
}

export function buildReviewCompletionJudgePrompt(input: {
  readonly language: Language | undefined;
  readonly task: string;
  readonly reviewScope: unknown;
  readonly evidence: ReviewCompletionEvidence;
  readonly reviewResponse: string;
  readonly mode: ReviewCompletionMode;
}): { systemPrompt: string; instruction: string } {
  const payload = JSON.stringify({
    task: input.task,
    changed_targets: input.reviewScope,
    repository_evidence: input.evidence,
    reviewer_report: input.reviewResponse,
    review_mode: input.mode,
  }, null, 2);
  if (input.language === 'ja') {
    return {
      systemPrompt: 'あなたは読み取り専用のレビュー網羅性判定者です。指摘の正否やworkflow状態ではなく、対象review modeで要求された調査経路が実コードと報告根拠により閉じたかだけを判定します。',
      instruction: [
        'repository_evidenceとして提示された実コードと差分を報告に照合し、changedまたはaccepted contract familyについて definition、producer、normalizer/validator、全consumer、retry/fallback/parallel、persistence/restoration、terminal/API の実接続と根拠を検査してください。omissionsは未確認範囲であり、不足を補作してはいけません。',
        input.mode === 'initial'
          ? 'changed targetsとacceptance criteriaの未走査はinitial_changed_target_gap、発見済みfamily内の縦経路不足はfamily_lifecycle_gapです。'
          : '一般的な横方向探索は禁止です。不足をretry対象にできるのはaccepted_family_unvisited_consumer、remediation_regression、direct_acceptance_criterion_violation、required_consumer_migrationの4種だけです。縦経路の不足も、この4種のauthorization basisへ分類できない場合は返してはいけません。',
        'completeならmissing_obligationsは空、不足なら具体的な未確認pathを返してください。',
        payload,
      ].join('\n\n'),
    };
  }
  return {
    systemPrompt: 'You are a read-only review-completeness judge. Decide only whether the required investigation paths for the review mode are closed by repository evidence and the report; do not produce workflow semantic status.',
    instruction: [
      'Compare the report with the actual code and diff supplied as repository_evidence. For every changed or accepted contract family, verify evidence and real connections through definition, producer, normalizer/validator, every consumer, retry/fallback/parallel, persistence/restoration, and terminal/API. Treat omissions as unverified coverage and do not invent missing evidence.',
      input.mode === 'initial'
        ? 'Classify an unvisited changed target or acceptance criterion as initial_changed_target_gap, and a vertical omission inside a discovered family as family_lifecycle_gap.'
        : 'General horizontal exploration is forbidden. Only accepted_family_unvisited_consumer, remediation_regression, direct_acceptance_criterion_violation, and required_consumer_migration may authorize a retry. Do not return a vertical gap that cannot be classified under one of these four bases.',
      'When complete, missing_obligations must be empty. Otherwise return concrete unverified paths.',
      payload,
    ].join('\n\n'),
  };
}

export function buildReviewCompletionRetryInstruction(input: {
  readonly originalInstruction: string;
  readonly retryInstruction: string;
  readonly mode: ReviewCompletionMode;
  readonly missingObligations: readonly ReviewCompletionGap[];
}): string {
  const typedGaps = input.missingObligations.map((gap) =>
    `- [${gap.kind}] ${gap.contractFamily}: ${gap.path} — ${gap.reason}`,
  );
  return [
    input.originalInstruction,
    '',
    input.retryInstruction.replace(/\{review_mode\}/g, input.mode),
    ...(typedGaps.length > 0 ? ['', ...typedGaps] : []),
  ].join('\n');
}

export function formatReviewCompletionDiagnostic(
  diagnostic: ReviewCompletionDiagnostic,
  language: Language | undefined,
): string {
  const heading = language === 'ja'
    ? 'レビュー網羅性の未完了診断（Phase 2限定）'
    : 'Incomplete review-completeness diagnostic (Phase 2 only)';
  return [
    `## ${heading}`,
    `- kind: ${diagnostic.kind}`,
    `- attempts: ${diagnostic.attempts}`,
    `- retries_used: ${diagnostic.retriesUsed}`,
    `- reason: ${diagnostic.reason}`,
    ...diagnostic.missingObligations.map((gap) =>
      `- [${gap.kind}] ${gap.contractFamily}: ${gap.path} — ${gap.reason}`,
    ),
  ].join('\n');
}

export async function runReviewCompletionEpisode(input: {
  readonly config: ReviewCompletionConfig;
  readonly originalInstruction: string;
  readonly initialMode: ReviewCompletionMode;
  readonly initialResponse: AgentResponse;
  readonly initialSessionId: string | undefined;
  readonly executeRetry: (attempt: ReviewCompletionAttemptInput) => Promise<AgentResponse>;
  readonly judge: (
    response: AgentResponse,
    attemptIndex: number,
    mode: ReviewCompletionMode,
  ) => Promise<ReviewCompletionDecision>;
  readonly isAbort: (error: unknown) => boolean;
}): Promise<ReviewCompletionEpisodeResult> {
  let response = input.initialResponse;
  let reviewerSessionId = input.initialSessionId;
  let lastDecision: ReviewCompletionDecision | undefined;
  let lastJudgeFailure: string | undefined;

  for (let attemptIndex = 0; attemptIndex <= input.config.maxRetry; attemptIndex++) {
    const mode = input.initialMode;
    if (attemptIndex > 0) {
      try {
        const retryResponse = await input.executeRetry({
          attemptIndex,
          mode,
          instruction: buildReviewCompletionRetryInstruction({
            originalInstruction: input.originalInstruction,
            retryInstruction: input.config.retryInstruction,
            mode,
            missingObligations: lastDecision?.missingObligations ?? [],
          }),
          sessionId: reviewerSessionId,
        });
        if (retryResponse.status === 'done') {
          response = retryResponse;
          reviewerSessionId = retryResponse.sessionId ?? reviewerSessionId;
          lastJudgeFailure = undefined;
        } else {
          lastJudgeFailure = retryResponse.error
            ?? `Reviewer retry returned ${retryResponse.status}`;
          if (attemptIndex === input.config.maxRetry) {
            return {
              response,
              reviewerSessionId,
              attempts: attemptIndex + 1,
              diagnostic: {
                kind: 'reviewer_retry_failed',
                attempts: attemptIndex + 1,
                retriesUsed: attemptIndex,
                reason: lastJudgeFailure,
                missingObligations: lastDecision?.missingObligations ?? [],
              },
            };
          }
          continue;
        }
      } catch (error) {
        if (input.isAbort(error)) throw error;
        lastJudgeFailure = error instanceof Error ? error.message : String(error);
        if (attemptIndex === input.config.maxRetry) {
          return {
            response,
            reviewerSessionId,
            attempts: attemptIndex + 1,
            diagnostic: {
              kind: 'reviewer_retry_failed',
              attempts: attemptIndex + 1,
              retriesUsed: attemptIndex,
              reason: lastJudgeFailure,
              missingObligations: lastDecision?.missingObligations ?? [],
            },
          };
        }
        continue;
      }
    }

    try {
      lastDecision = await input.judge(response, attemptIndex, mode);
      lastJudgeFailure = undefined;
    } catch (error) {
      if (input.isAbort(error)) throw error;
      lastDecision = undefined;
      lastJudgeFailure = error instanceof Error ? error.message : String(error);
    }

    const retriesUsed = attemptIndex;
    const requiresMinimumRetry = retriesUsed < input.config.minRetry;
    if (lastDecision === undefined && !requiresMinimumRetry) {
      return {
        response,
        reviewerSessionId,
        attempts: attemptIndex + 1,
        diagnostic: {
          kind: 'judge_unavailable',
          attempts: attemptIndex + 1,
          retriesUsed,
          reason: lastJudgeFailure ?? 'Review completion judge was unavailable',
          missingObligations: [],
        },
      };
    }
    const incomplete = lastDecision?.complete !== true;
    if ((requiresMinimumRetry || incomplete) && retriesUsed < input.config.maxRetry) {
      continue;
    }
    if (incomplete) {
      return {
        response,
        reviewerSessionId,
        attempts: attemptIndex + 1,
        diagnostic: {
          kind: lastJudgeFailure === undefined ? 'max_retry_reached' : 'judge_unavailable',
          attempts: attemptIndex + 1,
          retriesUsed,
          reason: lastJudgeFailure ?? lastDecision?.reason ?? 'Review completeness was not confirmed',
          missingObligations: lastDecision?.missingObligations ?? [],
        },
      };
    }
    return { response, reviewerSessionId, attempts: attemptIndex + 1 };
  }
  throw new Error('Review completion episode exhausted without a terminal result');
}
