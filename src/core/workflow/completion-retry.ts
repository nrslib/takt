import type { AgentResponse, Language, CompletionRetryConfig } from '../models/types.js';
import type { CompletionRetryEvidence } from './completion-retry-evidence.js';

export const COMPLETION_RETRY_JUDGE_NAME = 'review-completion-judge';
export const COMPLETION_RETRY_SCHEMA_REF = 'takt.review-completion.decision';

export const COMPLETION_RETRY_GAP_KINDS = [
  'changed_target_gap',
  'family_lifecycle_gap',
  'accepted_family_unvisited_consumer',
  'remediation_regression',
  'direct_acceptance_criterion_violation',
  'required_consumer_migration',
] as const;

export type CompletionRetryGapKind = typeof COMPLETION_RETRY_GAP_KINDS[number];

export function buildCompletionRetryOutputSchema(): Record<string, unknown> {
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
            kind: { type: 'string', enum: [...COMPLETION_RETRY_GAP_KINDS] },
            contract_family: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };
}

export interface CompletionRetryGap {
  readonly kind: CompletionRetryGapKind;
  readonly contractFamily: string;
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
  if (typeof raw.complete !== 'boolean' || !Array.isArray(raw.missing_obligations)) {
    throw new Error('Completion retry judge returned an invalid structured decision');
  }
  const missingObligations = raw.missing_obligations.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Completion retry judge returned invalid missing_obligations[${index}]`);
    }
    const gap = entry as Record<string, unknown>;
    if (!COMPLETION_RETRY_GAP_KINDS.includes(gap.kind as CompletionRetryGapKind)) {
      throw new Error(`Completion retry judge returned invalid missing_obligations[${index}].kind`);
    }
    return {
      kind: gap.kind as CompletionRetryGapKind,
      contractFamily: requiredString(gap.contract_family, `missing_obligations[${index}].contract_family`),
      path: requiredString(gap.path, `missing_obligations[${index}].path`),
      reason: requiredString(gap.reason, `missing_obligations[${index}].reason`),
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
    task: input.task,
    reviewer_instruction: input.reviewerInstruction,
    changed_targets: input.reviewScope,
    repository_evidence: input.evidence,
    reviewer_report: input.reviewResponse,
  }, null, 2);
  if (input.language === 'ja') {
    return {
      systemPrompt: 'あなたは読み取り専用のレビュー網羅性判定者です。reviewer instructionを唯一のスコープと権限の正本とし、そこで要求された調査経路が実コードと報告根拠により閉じたかだけを判定します。',
      instruction: [
        'reviewer_instructionの明示的な要求だけをrepository_evidenceとreviewer_reportに照合してください。同instructionが要求するcontract familyに限りdefinition、producer、normalizer/validator、consumer、retry/fallback/parallel、persistence/restoration、terminal/APIの実接続を確認します。instructionが禁止する横方向探索や新規familyの発見を不足として返してはいけません。referencesはpath/line/relationKind/seedのmetadataでありsource本文の証拠ではありません。claimedPathsとpriorGapPathsは本文未確認の補助path、omissionsは未確認範囲です。証拠や要求を補作してはいけません。',
        'completeならmissing_obligationsは空、不足なら具体的な未確認pathを返してください。',
        payload,
      ].join('\n\n'),
    };
  }
  return {
    systemPrompt: 'You are a read-only review-completeness judge. Treat the reviewer instruction as the sole source of scope and authority. Decide only whether its required investigation paths are closed by repository evidence and the report.',
    instruction: [
      'Compare only the explicit requirements in reviewer_instruction with repository_evidence and reviewer_report. Within contract families required by that instruction, verify the applicable real connections through definition, producer, normalizer/validator, consumers, retry/fallback/parallel, persistence/restoration, and terminal/API. Never return general horizontal exploration or discovery of a new family as a gap when the instruction forbids it. references are path/line/relationKind/seed metadata, not source-body proof. claimedPaths and priorGapPaths are auxiliary unverified paths; omissions are unverified coverage. Do not invent evidence or requirements.',
      'When complete, missing_obligations must be empty. Otherwise return concrete unverified paths.',
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
    `- [${gap.kind}] ${gap.contractFamily}: ${gap.path} — ${gap.reason}`,
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
