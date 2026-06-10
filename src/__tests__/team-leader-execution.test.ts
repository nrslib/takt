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
      refillThreshold: 0,
      maxTotalParts: 5,
      runPart,
      requestMoreParts,
    });

    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(result.partResults.map((result) => result.part.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(runPart).toHaveBeenCalledTimes(5);
    expect(maxActiveParts).toBe(2);
  });

  it('初回パート数が maxTotalParts を超える場合は実行前にエラーにする', async () => {
    const parts = ['p1', 'p2', 'p3'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn();

    await expect(runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 2,
      refillThreshold: 0,
      maxTotalParts: 2,
      runPart,
      requestMoreParts,
    })).rejects.toThrow('Initial team leader parts exceed max_total_parts: 3 > 2');

    expect(runPart).not.toHaveBeenCalled();
    expect(requestMoreParts).not.toHaveBeenCalled();
  });

  it('refill threshold 到達時に追加パートを取り込んで完了する', async () => {
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
      refillThreshold: 1,
      runPart,
      requestMoreParts,
    });

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.partResults.map((r) => r.part.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(runPart).toHaveBeenCalledTimes(3);
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
    expect(result.partResults.some((r) => r.part.id === part3.id)).toBe(true);
  });

  it('追加パートが残り maxTotalParts 予算を超える場合はエラーにする', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: false,
      reasoning: 'too many new parts',
      parts: [makePart('p3'), makePart('p4')],
    });

    await expect(runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      refillThreshold: 1,
      maxTotalParts: 3,
      runPart,
      requestMoreParts,
    })).rejects.toThrow('Team leader planned parts exceed max_total_parts: 4 > 3');

    expect(requestMoreParts).toHaveBeenCalledWith({
      partResults: [expect.objectContaining({ part: parts[0] })],
      scheduledIds: ['p1', 'p2'],
      remainingPartBudget: 1,
      unfinishedScheduledPartCount: 1,
    });
  });

  it('追加パート数超過の planning error は握りつぶさず伝播する', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockRejectedValue(
      new Error('Structured output produced too many parts: 2 > 1'),
    );
    const onPlanningError = vi.fn();

    await expect(runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      refillThreshold: 1,
      maxTotalParts: 3,
      runPart,
      requestMoreParts,
      onPlanningError,
    })).rejects.toThrow('Structured output produced too many parts: 2 > 1');

    expect(onPlanningError).not.toHaveBeenCalled();
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
      refillThreshold: 0,
      runPart,
      requestMoreParts,
      onPlanningNoNewParts,
    });

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1']);
    expect(result.partResults).toHaveLength(1);
    expect(onPlanningNoNewParts).toHaveBeenCalledTimes(1);
  });
});
