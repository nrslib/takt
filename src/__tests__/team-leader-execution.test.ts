import { describe, it, expect, vi } from 'vitest';
import { runTeamLeaderExecution } from '../core/piece/engine/team-leader-execution.js';
import type { PartDefinition, PartResult } from '../core/models/types.js';

function makePart(id: string): PartDefinition {
  return {
    id,
    title: `title-${id}`,
    instruction: `do-${id}`,
    timeoutMs: undefined,
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
  it('refill threshold 到達時に追加パートを取り込んで完了する', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    const part3 = makePart('p3');

    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'need one more',
        parts: [{ id: 'p3', title: 'title-p3', instruction: 'do-p3', timeoutMs: undefined }],
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

  it('重複IDだけ返された場合は追加せず終了する', async () => {
    const part1 = makePart('p1');

    const onPlanningNoNewParts = vi.fn();
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: false,
      reasoning: 'duplicate only',
      parts: [{ id: 'p1', title: 'dup', instruction: 'dup', timeoutMs: undefined }],
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
