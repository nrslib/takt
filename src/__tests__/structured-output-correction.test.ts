import { describe, expect, it, vi } from 'vitest';
import {
  correctStructuredOutputOnce,
  type StructuredOutputNormalizationResult,
} from '../core/workflow/engine/structured-output-correction.js';
import type { AgentResponse } from '../core/models/types.js';
import {
  assertFindingReviewPublicationSourceBindings,
  FindingReviewPublicationSourceBindingError,
} from '../core/workflow/findings/review-publication.js';

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: '',
    structuredOutput,
    timestamp: new Date('2026-07-30T00:00:00.000Z'),
  };
}

function rawFinding(rawExcerpt: string, description = 'The cleanup path is incorrect.') {
  return {
    rawExcerpt,
    candidate: {
      rawFindingId: 'raw-1',
      relation: 'new',
      targetFindingIds: [],
      familyTag: 'bug',
      severity: 'high',
      title: 'Cleanup path is incorrect',
      description,
      suggestion: null,
      target: { kind: 'code', paths: ['src/example.ts'] },
      evidenceRequests: [],
    },
  };
}

function normalizePublication(candidate: AgentResponse): StructuredOutputNormalizationResult {
  const reportContent = candidate.structuredOutput?.reportContent;
  const rawFindings = candidate.structuredOutput?.rawFindings;
  if (typeof reportContent !== 'string' || !Array.isArray(rawFindings)) {
    return {
      response: candidate,
      invalidDetail: 'publication shape is invalid',
      invalidKind: 'model_output',
    };
  }
  try {
    assertFindingReviewPublicationSourceBindings(reportContent, rawFindings);
    return { response: candidate };
  } catch (error) {
    return {
      response: candidate,
      invalidDetail: error instanceof Error ? error.message : String(error),
      invalidKind: 'model_output',
      ...(error instanceof FindingReviewPublicationSourceBindingError
        ? { correctionScope: 'raw_excerpt_single_edit' as const }
        : {}),
    };
  }
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

  it('single-edit bounded recoveryは1文字だけ誤ったrawExcerptを1回訂正して採用する', async () => {
    const reportContent = 'Use finally to close the resource.';
    const initialResponse = response({
      reportContent,
      rawFindings: [rawFinding('finally`')],
    });
    const correctedResponse = response({
      reportContent,
      rawFindings: [rawFinding('finally')],
    });
    const executeCorrection = vi.fn().mockResolvedValue(correctedResponse);

    const result = await correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection,
      normalize: normalizePublication,
      publicationInput: {
        reportContent,
        rawFindings: initialResponse.structuredOutput?.rawFindings,
      },
    });

    expect(executeCorrection).toHaveBeenCalledOnce();
    expect(executeCorrection.mock.calls[0]?.[0]).toContain('bounded source-binding recovery');
    expect(executeCorrection.mock.calls[0]?.[0]).toContain('canonical reviewer projection');
    expect(executeCorrection.mock.calls[0]?.[0]).toContain('exactly one Unicode code point');
    expect(result.response.structuredOutput).toEqual(correctedResponse.structuredOutput);
  });

  it('single-edit訂正のcandidate不変条件はcanonical projection同値で判定する', async () => {
    const reportContent = 'Use finally to close the resource.';
    const originalRaw = rawFinding('finally`');
    const correctedRaw = rawFinding('finally');
    originalRaw.candidate.targetFindingIds = ['F-0002', 'F-0001'];
    originalRaw.candidate.target = {
      kind: 'code',
      paths: ['src/z.ts', 'src/a.ts'],
    };
    correctedRaw.candidate.targetFindingIds = ['F-0001', 'F-0002'];
    correctedRaw.candidate.target = {
      kind: 'code',
      paths: ['src/a.ts', 'src/z.ts'],
    };
    const initialResponse = response({ reportContent, rawFindings: [originalRaw] });
    const correctedResponse = response({ reportContent, rawFindings: [correctedRaw] });

    const result = await correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection: vi.fn().mockResolvedValue(correctedResponse),
      normalize: normalizePublication,
      publicationInput: { reportContent, rawFindings: [originalRaw] },
    });

    expect(result.response.structuredOutput).toEqual(correctedResponse.structuredOutput);
  });

  it.each([
    ['zero', 'not present after correction', 'Use finally to close the resource.'],
    ['multiple', 'finally', 'finally is required; finally must remain unique.'],
  ])('訂正後もrawExcerptが%s matchなら1回で有限に失敗する', async (_kind, correctedExcerpt, reportContent) => {
    const initialResponse = response({
      reportContent,
      rawFindings: [rawFinding('finally`')],
    });
    const correctedResponse = response({
      reportContent,
      rawFindings: [rawFinding(correctedExcerpt)],
    });
    const executeCorrection = vi.fn().mockResolvedValue(correctedResponse);

    const result = await correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection,
      normalize: normalizePublication,
      publicationInput: {
        reportContent,
        rawFindings: initialResponse.structuredOutput?.rawFindings,
      },
    });

    expect(executeCorrection).toHaveBeenCalledOnce();
    expect(result.response).toMatchObject({
      status: 'error',
      error: expect.stringContaining('remained invalid after one correction'),
    });
  });

  it('正しいsource bindingなら訂正を呼ばない', async () => {
    const reportContent = 'Use finally to close the resource.';
    const initialResponse = response({
      reportContent,
      rawFindings: [rawFinding('finally')],
    });
    const executeCorrection = vi.fn();

    const result = await correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection,
      normalize: normalizePublication,
      publicationInput: {
        reportContent,
        rawFindings: initialResponse.structuredOutput?.rawFindings,
      },
    });

    expect(executeCorrection).not.toHaveBeenCalled();
    expect(result.response).toBe(initialResponse);
  });

  it.each([
    {
      name: 'raw findingを削除',
      correctedRawFindings: [] as unknown[],
    },
    {
      name: 'candidateを変更',
      correctedRawFindings: [rawFinding('finally', 'A rewritten claim.')],
    },
    {
      name: '別の一意なexcerptへ差し替え',
      correctedRawFindings: [rawFinding('close the resource')],
    },
    {
      name: '複数文字を修正',
      correctedRawFindings: [rawFinding('finally')],
      initialExcerpt: 'finally```',
    },
    {
      name: '複数の余分な空白を削除',
      correctedRawFindings: [rawFinding('finally')],
      initialExcerpt: '  finally',
    },
  ])('source-binding訂正で$nameした出力を拒否する', async ({
    correctedRawFindings,
    initialExcerpt = 'finally`',
  }) => {
    const reportContent = 'Use finally to close the resource.';
    const initialResponse = response({
      reportContent,
      rawFindings: [rawFinding(initialExcerpt)],
    });
    const correctedResponse = response({ reportContent, rawFindings: correctedRawFindings });

    await expect(correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection: vi.fn().mockResolvedValue(correctedResponse),
      normalize: normalizePublication,
      publicationInput: {
        reportContent,
        rawFindings: initialResponse.structuredOutput?.rawFindings,
      },
    })).rejects.toThrow(/publication source-binding correction/u);
  });

  it('source-binding訂正によるreportContent改変を拒否する', async () => {
    const reportContent = 'Use finally to close the resource.';
    const initialResponse = response({
      reportContent,
      rawFindings: [rawFinding('finally`')],
    });
    const correctedResponse = response({
      reportContent: `${reportContent} Changed.`,
      rawFindings: [rawFinding('finally')],
    });

    await expect(correctStructuredOutputOnce({
      stepName: 'review',
      initial: normalizePublication(initialResponse),
      executeCorrection: vi.fn().mockResolvedValue(correctedResponse),
      normalize: normalizePublication,
      publicationInput: {
        reportContent,
        rawFindings: initialResponse.structuredOutput?.rawFindings,
      },
    })).rejects.toThrow('changed reportContent');
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
