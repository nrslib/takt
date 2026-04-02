import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEvaluateCondition } = vi.hoisted(() => ({
  mockEvaluateCondition: vi.fn(),
}));

vi.mock('../agents/judge-status-usecase.js', () => ({
  judgeStatus: vi.fn(),
  evaluateCondition: mockEvaluateCondition,
}));

vi.mock('../agents/decompose-task-usecase.js', () => ({
  decomposeTask: vi.fn(),
  requestMoreParts: vi.fn(),
}));

import { DefaultStructuredCaller } from '../agents/structured-caller.js';

describe('DefaultStructuredCaller.evaluateCondition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should map non-contiguous original index back when position matches', async () => {
    // conditions[0] = { index: 2, text: 'A' }, conditions[1] = { index: 5, text: 'B' }
    // underlying evaluateCondition receives normalized positions (0, 1) and returns position 1 → original index 5
    mockEvaluateCondition.mockResolvedValueOnce(1);

    const caller = new DefaultStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'A' },
        { index: 5, text: 'B' },
      ],
      { cwd: '/tmp/project', provider: 'mock' },
    );

    expect(result).toBe(5);
    expect(mockEvaluateCondition).toHaveBeenCalledWith(
      'agent output',
      [
        { index: 0, text: 'A' },
        { index: 1, text: 'B' },
      ],
      expect.objectContaining({ cwd: '/tmp/project', provider: 'mock' }),
    );
  });

  it('should return -1 when matchedPosition is negative', async () => {
    mockEvaluateCondition.mockResolvedValueOnce(-1);

    const caller = new DefaultStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 0, text: 'approved' },
        { index: 1, text: 'rejected' },
      ],
      { cwd: '/tmp/project', provider: 'mock' },
    );

    expect(result).toBe(-1);
  });

  it('should return the original index when first condition matches', async () => {
    // conditions[0] = { index: 10, text: 'first' }
    // underlying returns position 0 → original index 10
    mockEvaluateCondition.mockResolvedValueOnce(0);

    const caller = new DefaultStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [{ index: 10, text: 'first' }],
      { cwd: '/tmp/project', provider: 'mock' },
    );

    expect(result).toBe(10);
  });

  it('should return -1 when matchedPosition is out of bounds', async () => {
    // underlying returns a position that is >= conditions.length
    mockEvaluateCondition.mockResolvedValueOnce(5);

    const caller = new DefaultStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 0, text: 'A' },
        { index: 1, text: 'B' },
      ],
      { cwd: '/tmp/project', provider: 'mock' },
    );

    // conditions[5] is undefined → falls back to -1 via ?? -1
    expect(result).toBe(-1);
  });
});
