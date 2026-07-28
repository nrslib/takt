import type { AgentResponse } from '../../models/types.js';
import type { ReviewerRawResourceEnvelope } from '../findings/raw-canonicalization.js';

export interface StructuredOutputNormalizationResult {
  readonly response: AgentResponse;
  readonly reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
  readonly invalidDetail?: string;
  readonly invalidKind?: 'model_output' | 'schema_config';
  readonly invalidIssues?: readonly {
    readonly path: string;
    readonly keyword: string;
    readonly message: string;
  }[];
}

interface CorrectStructuredOutputOnceOptions {
  readonly stepName: string;
  readonly initial: StructuredOutputNormalizationResult;
  readonly executeCorrection: (
    instruction: string,
    sessionId: string | undefined,
  ) => Promise<AgentResponse>;
  readonly normalize: (response: AgentResponse) => StructuredOutputNormalizationResult;
}

function buildCorrectionInstruction(detail: string): string {
  return [
    'Your structured output failed schema validation:',
    detail,
    '',
    'Re-emit ONLY the corrected structured output matching the schema.',
    'Do not repeat the report text. Do not add commentary.',
  ].join('\n');
}

function mergeTerminalCorrectionResponse(
  originalResponse: AgentResponse,
  correctionResponse: AgentResponse,
): AgentResponse {
  const baseResponse = { ...originalResponse };
  delete baseResponse.error;
  delete baseResponse.errorKind;
  delete baseResponse.rateLimitInfo;
  return {
    ...baseResponse,
    status: correctionResponse.status,
    timestamp: correctionResponse.timestamp,
    ...(correctionResponse.error !== undefined ? { error: correctionResponse.error } : {}),
    ...(correctionResponse.errorKind !== undefined ? { errorKind: correctionResponse.errorKind } : {}),
    ...(correctionResponse.rateLimitInfo !== undefined ? { rateLimitInfo: correctionResponse.rateLimitInfo } : {}),
    ...(correctionResponse.sessionId !== undefined ? { sessionId: correctionResponse.sessionId } : {}),
    ...(correctionResponse.providerUsage !== undefined ? { providerUsage: correctionResponse.providerUsage } : {}),
  };
}

/**
 * Finding Contract の model-output validation failure を同一セッションで1回だけ
 * 訂正する。schema configuration failure は呼び出し側の fail-fast 経路へ残す。
 */
export async function correctStructuredOutputOnce(
  options: CorrectStructuredOutputOnceOptions,
): Promise<StructuredOutputNormalizationResult> {
  const { initial } = options;
  if (initial.invalidDetail === undefined || initial.invalidKind !== 'model_output') {
    return initial;
  }

  const correctionResponse = await options.executeCorrection(
    buildCorrectionInstruction(initial.invalidDetail),
    initial.response.sessionId,
  );
  const corrected = options.normalize(correctionResponse);

  if (correctionResponse.status === 'rate_limited' || correctionResponse.status === 'blocked') {
    return {
      response: mergeTerminalCorrectionResponse(initial.response, correctionResponse),
      reviewerRawResourceEnvelope: corrected.reviewerRawResourceEnvelope,
    };
  }

  if (corrected.invalidDetail !== undefined || corrected.response.status !== 'done') {
    return {
      response: {
        ...initial.response,
        status: 'error',
        error: `Step "${options.stepName}" structured output remained invalid after one correction: ${corrected.invalidDetail ?? corrected.response.error ?? 'correction failed'}`,
      },
      reviewerRawResourceEnvelope: corrected.reviewerRawResourceEnvelope,
    };
  }

  return {
    response: {
      ...initial.response,
      structuredOutput: corrected.response.structuredOutput,
      ...(correctionResponse.sessionId !== undefined ? { sessionId: correctionResponse.sessionId } : {}),
    },
    reviewerRawResourceEnvelope: corrected.reviewerRawResourceEnvelope,
  };
}
