import { describe, expect, it, vi } from 'vitest';
import {
  correctStructuredOutputOnce,
  type StructuredOutputNormalizationResult,
} from '../core/workflow/engine/structured-output-correction.js';
import type { AgentResponse } from '../core/models/types.js';

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: '',
    structuredOutput,
    timestamp: new Date('2026-07-30T00:00:00.000Z'),
  };
}

describe('correctStructuredOutputOnce publication input', () => {
  it('sessionIdがなくても完全なpublication入力からschema correctionできる', async () => {
    const reportContent = `Review report.${'x'.repeat(9_000)}`;
    const correctedResponse = response({ reportContent, rawFindings: [] });
    const executeCorrection = vi.fn().mockResolvedValue(correctedResponse);
    const normalize = vi.fn().mockReturnValue({
      response: correctedResponse,
    } satisfies StructuredOutputNormalizationResult);

    const result = await correctStructuredOutputOnce({
      stepName: 'review',
      initial: {
        response: response({ reportContent, rawFindings: 'invalid' }),
        invalidDetail: 'rawFindings must be an array',
        invalidKind: 'model_output',
      },
      executeCorrection,
      normalize,
      publicationInput: { reportContent, rawFindings: 'invalid' },
    });

    expect(executeCorrection).toHaveBeenCalledOnce();
    expect(executeCorrection.mock.calls[0]?.[1]).toBeUndefined();
    expect(executeCorrection.mock.calls[0]?.[0]).toContain(`"reportContent": "${reportContent}"`);
    expect(result.response.structuredOutput).toEqual({
      reportContent,
      rawFindings: [],
    });
  });

  it('訂正入力が既存のreviewer上限を超える場合はagentを呼ばずfail-loudにする', async () => {
    const reportContent = 'Review report.';
    const oversizedRawFindings = Array.from({ length: 65 }, () => ({}));
    const executeCorrection = vi.fn();

    await expect(correctStructuredOutputOnce({
      stepName: 'review',
      initial: {
        response: response({ reportContent, rawFindings: oversizedRawFindings }),
        invalidDetail: 'rawFindings has too many items',
        invalidKind: 'model_output',
      },
      executeCorrection,
      normalize: (candidate) => ({ response: candidate }),
      publicationInput: { reportContent, rawFindings: oversizedRawFindings },
    })).rejects.toThrow('exceeded limits');

    expect(executeCorrection).not.toHaveBeenCalled();
  });
});
