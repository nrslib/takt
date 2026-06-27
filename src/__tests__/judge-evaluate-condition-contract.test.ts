import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { evaluateCondition } from '../agents/judge-status-usecase.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadEvaluationSchema: vi.fn(() => ({ type: 'evaluation' })),
}));

function doneResponse(content: string, structuredOutput?: Record<string, unknown>) {
  return {
    persona: 'tester',
    status: 'done' as const,
    content,
    timestamp: new Date('2026-02-12T00:00:00Z'),
    structuredOutput,
  };
}

describe('evaluateCondition judge instruction contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass agent output and judge conditions to runAgent', async () => {
    vi.mocked(runAgent).mockResolvedValue(doneResponse('ignored', { matched_index: 1 }));

    await evaluateCondition(
      'worker result with a unique regression summary',
      [
        { index: 0, text: 'needs_fix when verification shows a regression' },
        { index: 1, text: 'approved when verification passes' },
      ],
      { cwd: '/repo' },
    );

    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1];
    expect(instruction).toEqual(expect.any(String));
    expect(instruction).toContain('worker result with a unique regression summary');
    expect(instruction).toContain('needs_fix when verification shows a regression');
    expect(instruction).toContain('approved when verification passes');
    expect(runAgent).toHaveBeenCalledWith(undefined, instruction, expect.objectContaining({
      cwd: '/repo',
      outputSchema: { type: 'evaluation' },
    }));
  });
});
