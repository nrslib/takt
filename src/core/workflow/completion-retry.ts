import type { AgentResponse, Language, CompletionRetryConfig } from '../models/types.js';
import type { CompletionRetryEvidence } from './completion-retry-evidence.js';

export const COMPLETION_RETRY_JUDGE_NAME = 'review-completion-judge';
export const COMPLETION_RETRY_SCHEMA_REF = 'takt.review-completion.decision';

export function buildCompletionRetryOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['complete', 'reason', 'missing_paths'],
    properties: {
      complete: { type: 'boolean' },
      reason: { type: 'string', minLength: 1 },
      missing_paths: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'reason'],
          properties: {
            path: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };
}

export interface CompletionRetryGap {
  readonly path: string;
  readonly reason: string;
}

export interface CompletionRetryDecision {
  readonly complete: boolean;
  readonly reason: string;
  readonly missingObligations: readonly CompletionRetryGap[];
}

export interface CompletionRetryDiagnostic {
  readonly kind: 'max_retry_reached' | 'judge_unavailable' | 'reviewer_retry_failed';
  readonly attempts: number;
  readonly retriesUsed: number;
  readonly reason: string;
  readonly missingObligations: readonly CompletionRetryGap[];
}

export interface CompletionRetryEpisodeResult {
  readonly response: AgentResponse;
  readonly reviewerSessionId: string | undefined;
  readonly attempts: number;
  readonly diagnostic?: CompletionRetryDiagnostic;
}

export interface CompletionRetryAttemptInput {
  readonly attemptIndex: number;
  readonly instruction: string;
  readonly sessionId: string | undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Completion retry judge returned invalid ${field}`);
  }
  return value.trim();
}

export function parseCompletionRetryDecision(
  value: unknown,
): CompletionRetryDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Completion retry judge returned no structured decision');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== 'boolean' || !Array.isArray(raw.missing_paths)) {
    throw new Error('Completion retry judge returned an invalid structured decision');
  }
  const missingObligations = raw.missing_paths.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Completion retry judge returned invalid missing_paths[${index}]`);
    }
    const gap = entry as Record<string, unknown>;
    return {
      path: requiredString(gap.path, `missing_paths[${index}].path`),
      reason: requiredString(gap.reason, `missing_paths[${index}].reason`),
    };
  });
  if (raw.complete === (missingObligations.length > 0)) {
    throw new Error('Completion retry decision and missing obligations disagree');
  }
  return {
    complete: raw.complete,
    reason: requiredString(raw.reason, 'reason'),
    missingObligations,
  };
}

export function buildCompletionRetryJudgePrompt(input: {
  readonly language: Language | undefined;
  readonly task: string;
  readonly reviewerInstruction: string;
  readonly reviewScope: unknown;
  readonly evidence: CompletionRetryEvidence;
  readonly reviewResponse: string;
}): { systemPrompt: string; instruction: string } {
  const payload = JSON.stringify({
    change_request: input.task,
    review_requirements: input.reviewerInstruction,
    changed_targets: input.reviewScope,
    code_evidence: input.evidence,
    review_result: input.reviewResponse,
  }, null, 2);
  if (input.language === 'ja') {
    return {
      systemPrompt: 'あなたはレビューの確認範囲を判定する読み取り専用の判定者です。変更要求とレビューで求められた確認を、コード上の証拠とレビュー結果が満たしているかだけを判定します。',
      instruction: [
        'change_request と review_requirements で確認を求められた対象だけを、code_evidence と review_result に照合してください。同じ原因と観測可能な条件に関係する定義、生成、変換、検証、利用、再試行、永続化、復元、最終出力のうち、実在する経路を確認します。要求されていない別問題の探索を不足として返してはいけません。code_evidence.references は関連する場所を示す情報であり、ファイル本文の証拠ではありません。priorGapPaths は本文未確認の補助経路、omissions は収集できなかった範囲です。証拠や要求を補作してはいけません。',
        'complete が true なら missing_paths は空にしてください。不足がある場合は、未確認の実在経路と理由を missing_paths に返してください。',
        payload,
      ].join('\n\n'),
    };
  }
  return {
    systemPrompt: 'You are a read-only judge of review coverage. Decide only whether the code evidence and review result satisfy the checks required by the change request and review requirements.',
    instruction: [
      'Compare only the checks requested by change_request and review_requirements with code_evidence and review_result. Inspect actual paths related to the same cause and observable condition through definition, production, transformation, validation, consumption, retries, persistence, restoration, and final output. Do not return exploration of an unrelated problem as missing work. code_evidence.references identify related locations but are not evidence of file contents. priorGapPaths are auxiliary paths whose contents were not checked, and omissions describe ranges that could not be collected. Do not invent evidence or requirements.',
      'When complete is true, missing_paths must be empty. Otherwise return each unverified actual path and its reason in missing_paths.',
      payload,
    ].join('\n\n'),
  };
}

export function buildCompletionRetryInstruction(input: {
  readonly originalInstruction: string;
  readonly retryInstruction: string;
  readonly missingObligations: readonly CompletionRetryGap[];
}): string {
  const typedGaps = input.missingObligations.map((gap) =>
    `- ${gap.path} — ${gap.reason}`,
  );
  return [
    input.originalInstruction,
    '',
    input.retryInstruction,
    ...(typedGaps.length > 0 ? ['', ...typedGaps] : []),
  ].join('\n');
}

export function formatCompletionRetryDiagnostic(
  diagnostic: CompletionRetryDiagnostic,
  language: Language | undefined,
): string {
  const heading = language === 'ja'
    ? 'レビュー確認範囲の未完了診断'
    : 'Incomplete review-coverage diagnostic';
  return [
    `## ${heading}`,
    `- kind: ${diagnostic.kind}`,
    `- attempts: ${diagnostic.attempts}`,
    `- retries_used: ${diagnostic.retriesUsed}`,
    `- reason: ${diagnostic.reason}`,
    ...diagnostic.missingObligations.map((gap) => `- ${gap.path} — ${gap.reason}`),
  ].join('\n');
}

export async function runCompletionRetryEpisode(input: {
  readonly config: CompletionRetryConfig;
  readonly originalInstruction: string;
  readonly initialResponse: AgentResponse;
  readonly initialSessionId: string | undefined;
  readonly executeRetry: (attempt: CompletionRetryAttemptInput) => Promise<AgentResponse>;
  readonly judge: (
    response: AgentResponse,
    attemptIndex: number,
  ) => Promise<CompletionRetryDecision>;
  readonly isAbort: (error: unknown) => boolean;
}): Promise<CompletionRetryEpisodeResult> {
  let response = input.initialResponse;
  let reviewerSessionId = input.initialSessionId;
  let lastDecision: CompletionRetryDecision | undefined;
  let lastJudgeFailure: string | undefined;

  for (let attemptIndex = 0; attemptIndex <= input.config.maxRetry; attemptIndex++) {
    if (attemptIndex > 0) {
      try {
        const retryResponse = await input.executeRetry({
          attemptIndex,
          instruction: buildCompletionRetryInstruction({
            originalInstruction: input.originalInstruction,
            retryInstruction: input.config.retryInstruction,
            missingObligations: lastDecision?.missingObligations ?? [],
          }),
          sessionId: reviewerSessionId,
        });
        if (retryResponse.status === 'done') {
          response = retryResponse;
          reviewerSessionId = retryResponse.sessionId;
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
      lastDecision = await input.judge(response, attemptIndex);
      lastJudgeFailure = undefined;
    } catch (error) {
      if (input.isAbort(error)) throw error;
      lastDecision = undefined;
      lastJudgeFailure = error instanceof Error ? error.message : String(error);
    }

    const retriesUsed = attemptIndex;
    const requiresMinimumRetry = retriesUsed < input.config.minRetry;
    if (lastDecision === undefined) {
      return {
        response,
        reviewerSessionId,
        attempts: attemptIndex + 1,
        diagnostic: {
          kind: 'judge_unavailable',
          attempts: attemptIndex + 1,
          retriesUsed,
          reason: lastJudgeFailure ?? 'Completion retry judge was unavailable',
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
  throw new Error('Completion retry episode exhausted without a terminal result');
}
