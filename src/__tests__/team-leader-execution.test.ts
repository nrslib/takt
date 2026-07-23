import { describe, it, expect, vi } from 'vitest';
import { runTeamLeaderExecution } from '../core/workflow/engine/team-leader-execution.js';
import type { PartDefinition, PartResult } from '../core/models/types.js';

function makePart(id: string): PartDefinition {
  return {
    id,
    title: `title-${id}`,
    instruction: `do-${id}`,
  };
}

function makeResult(part: PartDefinition): PartResult {
  return {
    part,
    response: {
      persona: `execute.${part.id}`,
      status: 'done',
      content: `done ${part.id}`,
      timestamp: new Date(),
    },
  };
}

describe('runTeamLeaderExecution', () => {
  it('初回5パートを最大2並列で順次実行する', async () => {
    const parts = ['p1', 'p2', 'p3', 'p4', 'p5'].map(makePart);
    let activeParts = 0;
    let maxActiveParts = 0;

    const runPart = vi.fn(async (part: PartDefinition) => {
      activeParts += 1;
      maxActiveParts = Math.max(maxActiveParts, activeParts);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeParts -= 1;
      return makeResult(part);
    });
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: true,
      reasoning: 'initial parts cover all work',
      parts: [],
    });

    const result = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 2,
      runPart,
      requestMoreParts,
    });

    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(result.partResults.map((result) => result.part.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(runPart).toHaveBeenCalledTimes(5);
    expect(maxActiveParts).toBe(2);
  });

  it('予定済みパートがすべて完了してから追加パートを取り込む', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    const part3 = makePart('p3');

    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'need one more',
        parts: [{ id: 'p3', title: 'title-p3', instruction: 'do-p3' }],
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'enough',
        parts: [],
      });

    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));

    const result = await runTeamLeaderExecution({
      initialParts: [part1, part2],
      maxConcurrency: 2,
      runPart,
      requestMoreParts,
    });

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.partResults.map((r) => r.part.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(runPart).toHaveBeenCalledTimes(3);
    expect(requestMoreParts).toHaveBeenNthCalledWith(1, expect.objectContaining({
      partResults: expect.arrayContaining([
        expect.objectContaining({ part: part1 }),
        expect.objectContaining({ part: part2 }),
      ]),
    }));
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
    expect(result.partResults.some((r) => r.part.id === part3.id)).toBe(true);
  });

  it('追加パートの総数を制限せずリーダーの完了判断まで実行する', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'more work remains',
        parts: [makePart('p3'), makePart('p4')],
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'all work completed',
        parts: [],
      });

    const result = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
    });

    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(runPart).toHaveBeenCalledTimes(4);
    expect(requestMoreParts).toHaveBeenNthCalledWith(1, {
      partResults: expect.arrayContaining([
        expect.objectContaining({ part: parts[0] }),
        expect.objectContaining({ part: parts[1] }),
      ]),
      latestBatchResults: expect.arrayContaining([
        expect.objectContaining({ part: parts[0] }),
        expect.objectContaining({ part: parts[1] }),
      ]),
      completedPartResults: [],
      plannedParts: parts,
      scheduledIds: ['p1', 'p2'],
    });
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
  });

  it('追加計画が失敗した場合は既存パートの結果で終了する', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockRejectedValue(new Error('feedback failed'));
    const onPlanningError = vi.fn();

    const result = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
      onPlanningError,
    });

    expect(result.partResults).toHaveLength(2);
    expect(onPlanningError).toHaveBeenCalledWith(expect.objectContaining({ message: 'feedback failed' }));
  });

  it('重複IDだけ返された場合は追加せず終了する', async () => {
    const part1 = makePart('p1');

    const onPlanningNoNewParts = vi.fn();
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: false,
      reasoning: 'duplicate only',
      parts: [{ id: 'p1', title: 'dup', instruction: 'dup' }],
    });

    const result = await runTeamLeaderExecution({
      initialParts: [part1],
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
      onPlanningNoNewParts,
    });

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1']);
    expect(result.partResults).toHaveLength(1);
    expect(onPlanningNoNewParts).toHaveBeenCalledTimes(1);
  });

  it('Finding Contract mode separates latest raw results from the prior compactable batch', async () => {
    const p1 = makePart('p1');
    const p2 = makePart('p2');
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'continue',
        parts: [p2],
        findingContractDecision: { decision: 'continue', reasoning: 'continue', parts: [p2] },
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'complete',
        parts: [],
        findingContractDecision: {
          decision: 'complete',
          reasoning: 'complete',
          parts: [],
          fixCoverage: [],
        },
      });

    const result = await runTeamLeaderExecution({
      initialParts: [p1],
      maxConcurrency: 1,
      findingContractMode: true,
      runPart: async (part) => makeResult(part),
      requestMoreParts,
    });

    expect(requestMoreParts).toHaveBeenNthCalledWith(2, expect.objectContaining({
      latestBatchResults: [expect.objectContaining({ part: p2 })],
      completedPartResults: [expect.objectContaining({ part: p1 })],
    }));
    expect(result.findingContractDecision?.decision).toBe('complete');
  });

  it('Finding Contract mode does not convert duplicate parts or feedback errors into completion', async () => {
    const part = makePart('p1');
    await expect(runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      findingContractMode: true,
      runPart: async (current) => makeResult(current),
      requestMoreParts: async () => ({
        done: false,
        reasoning: 'duplicate',
        parts: [part],
        findingContractDecision: { decision: 'continue', reasoning: 'duplicate', parts: [part] },
      }),
    })).rejects.toThrow(/no new unique parts/);

    await expect(runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      findingContractMode: true,
      runPart: async (current) => makeResult(current),
      requestMoreParts: async () => { throw new Error('feedback failed'); },
    })).rejects.toThrow('feedback failed');
  });

  it('Finding Contract mode propagates an explicit replan decision', async () => {
    const part = makePart('p1');
    const result = await runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      findingContractMode: true,
      runPart: async (current) => makeResult(current),
      requestMoreParts: async () => ({
        done: true,
        reasoning: 'architecture must change',
        parts: [],
        findingContractDecision: {
          decision: 'replan',
          reasoning: 'architecture must change',
          parts: [],
          blockers: ['shared contract is inconsistent'],
        },
      }),
    });

    expect(result.findingContractDecision).toEqual(expect.objectContaining({
      decision: 'replan',
      blockers: ['shared contract is inconsistent'],
    }));
  });

  it('rate limited part bypasses Finding Contract feedback and returns the part result', async () => {
    const part = makePart('p1');
    const requestMoreParts = vi.fn(async () => {
      throw new Error('feedback must not run after rate limit');
    });

    const result = await runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      findingContractMode: true,
      runPart: async (current) => ({
        ...makeResult(current),
        response: {
          ...makeResult(current).response,
          status: 'rate_limited',
        },
      }),
      requestMoreParts,
    });

    expect(requestMoreParts).not.toHaveBeenCalled();
    expect(result.partResults).toHaveLength(1);
    expect(result.partResults[0]?.response.status).toBe('rate_limited');
    expect(result.findingContractDecision).toBeUndefined();
  });
});
