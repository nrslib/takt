import { describe, it, expect, vi } from 'vitest';
import { runTeamLeaderExecution } from '../core/workflow/engine/team-leader-execution.js';
import type { PartDefinition, PartResult } from '../core/models/types.js';
import { createProviderStreamParseError } from '../shared/types/agent-failure.js';

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
      cancelPartIds: [],
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

  it('成功したパートの完了後、running partを含めて追加計画する', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    const part3 = makePart('p3');

    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'need one more',
        cancelPartIds: [],
        parts: [{ id: 'p3', title: 'title-p3', instruction: 'do-p3' }],
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'enough',
        cancelPartIds: [],
        parts: [],
      });

    let releaseSecondPart: (() => void) | undefined;
    const secondPartReady = new Promise<void>((resolve) => {
      releaseSecondPart = resolve;
    });
    const runPart = vi.fn(async (part: PartDefinition) => {
      if (part.id === 'p2') {
        await secondPartReady;
      }
      return makeResult(part);
    });

    const execution = runTeamLeaderExecution({
      initialParts: [part1, part2],
      maxConcurrency: 2,
      runPart,
      requestMoreParts,
    });
    await vi.waitFor(() => expect(requestMoreParts).toHaveBeenCalled());
    releaseSecondPart?.();
    const result = await execution;

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.partResults.map((r) => r.part.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(runPart).toHaveBeenCalledTimes(3);
    expect(requestMoreParts).toHaveBeenNthCalledWith(1, expect.objectContaining({
      partResults: [expect.objectContaining({ part: part1 })],
      cancellablePartIds: ['p2'],
      abortSignal: expect.any(AbortSignal),
    }));
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
    expect(result.partResults.some((r) => r.part.id === part3.id)).toBe(true);
  });

  it('一つのpartの完了レビュー待ちでも別の並行partを実行して公開する', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    let releasePart1Review: (() => void) | undefined;
    const part1ReviewGate = new Promise<void>((resolve) => {
      releasePart1Review = resolve;
    });
    let markPart2Completed: (() => void) | undefined;
    const part2Completed = new Promise<void>((resolve) => {
      markPart2Completed = resolve;
    });
    const publishedPartIds: string[] = [];
    const runPart = vi.fn(async (part: PartDefinition) => {
      if (part.id === part1.id) {
        await part1ReviewGate;
      } else {
        markPart2Completed?.();
      }
      return makeResult(part);
    });
    const execution = runTeamLeaderExecution({
      initialParts: [part1, part2],
      maxConcurrency: 2,
      runPart,
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'both parts are complete',
        cancelPartIds: [],
        parts: [],
      }),
      onPartCompleted: (result) => {
        publishedPartIds.push(result.part.id);
      },
    });

    await part2Completed;
    expect(runPart).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(publishedPartIds).toEqual(['p2']);
    releasePart1Review?.();

    await expect(execution).resolves.toMatchObject({
      partResults: expect.arrayContaining([
        expect.objectContaining({ part: part1 }),
        expect.objectContaining({ part: part2 }),
      ]),
    });
    expect(publishedPartIds).toEqual(['p2', 'p1']);
  });

  it('未完了パートがある間の空の追加計画ではリーダー評価を終了しない', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    const part3 = makePart('p3');
    let releaseSecondPart: (() => void) | undefined;
    const secondPartReady = new Promise<void>((resolve) => {
      releaseSecondPart = resolve;
    });
    const runPart = vi.fn(async (part: PartDefinition) => {
      if (part.id === part2.id) {
        await secondPartReady;
      }
      return makeResult(part);
    });
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'wait for the remaining part',
        cancelPartIds: [],
        parts: [],
      })
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'add follow-up work',
        cancelPartIds: [],
        parts: [part3],
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'all work completed',
        cancelPartIds: [],
        parts: [],
      });

    const execution = runTeamLeaderExecution({
      initialParts: [part1, part2],
      maxConcurrency: 2,
      runPart,
      requestMoreParts,
    });
    await vi.waitFor(() => expect(requestMoreParts).toHaveBeenCalledTimes(1));
    releaseSecondPart?.();
    const result = await execution;

    expect(requestMoreParts).toHaveBeenCalledTimes(3);
    expect(requestMoreParts).toHaveBeenNthCalledWith(2, expect.objectContaining({
      partResults: [
        expect.objectContaining({ part: part1 }),
        expect.objectContaining({ part: part2 }),
      ],
    }));
    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.partResults.map((result) => result.part.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('追加パートの総数を制限せずリーダーの完了判断まで実行する', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'more work remains',
        cancelPartIds: [],
        parts: [makePart('p3'), makePart('p4')],
      })
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'all work completed',
        cancelPartIds: [],
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
      partResults: [expect.objectContaining({ part: parts[0] })],
      latestBatchResults: [expect.objectContaining({ part: parts[0] })],
      completedPartResults: [],
      plannedParts: parts,
      scheduledIds: ['p1', 'p2'],
      cancellablePartIds: ['p2'],
      abortSignal: expect.any(AbortSignal),
    });
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
  });

  it('全ての並行partを公開するまでTeam完了レビューを開始しない', async () => {
    const part1 = makePart('p1');
    const part2 = makePart('p2');
    let releaseSecondPart: (() => void) | undefined;
    const secondPartGate = new Promise<void>((resolve) => {
      releaseSecondPart = resolve;
    });
    const publishedPartIds: string[] = [];
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: true,
      reasoning: 'all work completed',
      cancelPartIds: [],
      parts: [],
    });
    const reviewCompletion = vi.fn(async () => {
      expect(publishedPartIds).toEqual(['p1', 'p2']);
      return [];
    });

    const execution = runTeamLeaderExecution({
      initialParts: [part1, part2],
      maxConcurrency: 2,
      runPart: async (part) => {
        if (part.id === part2.id) {
          await secondPartGate;
        }
        return makeResult(part);
      },
      requestMoreParts,
      reviewCompletion,
      onPartCompleted: (result) => {
        publishedPartIds.push(result.part.id);
      },
    });

    await vi.waitFor(() => expect(requestMoreParts).toHaveBeenCalledOnce());
    expect(publishedPartIds).toEqual(['p1']);
    expect(reviewCompletion).not.toHaveBeenCalled();

    releaseSecondPart?.();
    const result = await execution;

    expect(result.partResults.map((partResult) => partResult.part.id)).toEqual(['p1', 'p2']);
    expect(publishedPartIds).toEqual(['p1', 'p2']);
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(reviewCompletion).toHaveBeenCalledWith(expect.objectContaining({
      partResults: [
        expect.objectContaining({ part: part1 }),
        expect.objectContaining({ part: part2 }),
      ],
    }));
    expect(requestMoreParts).toHaveBeenCalledOnce();
  });

  it('追加計画が失敗した場合は既存パートの結果で終了する', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockRejectedValue(new Error('feedback failed'));
    const onPlanningError = vi.fn();
    const onCompletionPlanningFailure = vi.fn();
    const reviewCompletion = vi.fn().mockResolvedValue([]);

    const result = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
      onPlanningError,
      onCompletionPlanningFailure,
      reviewCompletion,
    });

    expect(result.partResults).toHaveLength(2);
    expect(onPlanningError).toHaveBeenCalledWith(expect.objectContaining({ message: 'feedback failed' }));
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(onCompletionPlanningFailure).not.toHaveBeenCalled();
  });

  it('Team 完了レビューの失敗を計画失敗後の再レビューとして扱わない', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const reviewError = new Error('completion review failed');
    const reviewCompletion = vi.fn().mockRejectedValue(reviewError);
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: true,
      reasoning: 'all work completed',
      cancelPartIds: [],
      parts: [],
    });
    const onPlanningError = vi.fn();
    const onCompletionPlanningFailure = vi.fn();

    const execution = runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      runPart: vi.fn(async (part: PartDefinition) => makeResult(part)),
      requestMoreParts,
      reviewCompletion,
      onPlanningError,
      onCompletionPlanningFailure,
    });

    await expect(execution).rejects.toBe(reviewError);
    expect(requestMoreParts).toHaveBeenCalledOnce();
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(onPlanningError).not.toHaveBeenCalled();
    expect(onCompletionPlanningFailure).not.toHaveBeenCalled();
  });

  it('追加計画の失敗後に Team 指摘を検出した場合は completion failure を確定する', async () => {
    const part = makePart('p1');
    const planningError = new Error('feedback failed');
    const requestMoreParts = vi.fn().mockRejectedValue(planningError);
    const reviewCompletion = vi.fn().mockResolvedValue([{
      companion: 'reviewer',
      reviewedAt: '2026-08-23T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'must_fix',
      file: 'src/a.ts',
      line: 1,
      finding: 'Fix the value.',
    }]);
    const onCompletionPlanningFailure = vi.fn();

    const result = await runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      runPart: vi.fn(async () => makeResult(part)),
      requestMoreParts,
      reviewCompletion,
      onCompletionPlanningFailure,
    });

    expect(result.partResults).toHaveLength(1);
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(onCompletionPlanningFailure).toHaveBeenCalledWith(planningError);
  });

  it('Team 指摘の correction planning が失敗した場合は再レビューせず completion failure を確定する', async () => {
    const part = makePart('p1');
    const planningError = new Error('correction planning failed');
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'initially complete',
        cancelPartIds: [],
        parts: [],
      })
      .mockRejectedValueOnce(planningError);
    const reviewCompletion = vi.fn().mockResolvedValue([{
      companion: 'reviewer',
      reviewedAt: '2026-08-23T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'must_fix',
      file: 'src/a.ts',
      line: 1,
      finding: 'Fix the value.',
    }]);
    const onCompletionPlanningFailure = vi.fn();

    const result = await runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      runPart: vi.fn(async () => makeResult(part)),
      requestMoreParts,
      reviewCompletion,
      onCompletionPlanningFailure,
    });

    expect(result.partResults).toHaveLength(1);
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(onCompletionPlanningFailure).toHaveBeenCalledWith(planningError);
  });

  it.each([
    {
      name: 'done を返す',
      correctionFeedback: {
        done: true,
        reasoning: 'no correction required',
        cancelPartIds: [],
        parts: [],
      },
    },
    {
      name: '既存 part ID だけを返す',
      correctionFeedback: {
        done: false,
        reasoning: 'repeat the completed part',
        cancelPartIds: [],
        parts: [{ id: 'p1', title: 'part p1', instruction: 'run p1' }],
      },
    },
  ])('Team 指摘後の correction planning が $name 場合は completion failure を確定する', async ({
    correctionFeedback,
  }) => {
    const part = makePart('p1');
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: true,
        reasoning: 'initially complete',
        cancelPartIds: [],
        parts: [],
      })
      .mockResolvedValueOnce(correctionFeedback);
    const reviewCompletion = vi.fn().mockResolvedValue([{
      companion: 'reviewer',
      reviewedAt: '2026-08-23T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'must_fix',
      file: 'src/a.ts',
      line: 1,
      finding: 'Fix the value.',
    }]);
    const onCompletionPlanningFailure = vi.fn();
    const onPlanningDone = vi.fn();
    const onPlanningNoNewParts = vi.fn();

    const result = await runTeamLeaderExecution({
      initialParts: [part],
      maxConcurrency: 1,
      runPart: vi.fn(async () => makeResult(part)),
      requestMoreParts,
      reviewCompletion,
      onCompletionPlanningFailure,
      onPlanningDone,
      onPlanningNoNewParts,
    });

    expect(result.partResults).toHaveLength(1);
    expect(requestMoreParts).toHaveBeenCalledTimes(2);
    expect(reviewCompletion).toHaveBeenCalledOnce();
    expect(onCompletionPlanningFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Team Companion correction planning did not schedule a correction part',
    }));
    expect(onPlanningDone).not.toHaveBeenCalled();
    expect(onPlanningNoNewParts).not.toHaveBeenCalled();
  });

  it('追加計画の provider stream parse failure は fallback と成功集約へ進まない', async () => {
    const parts = ['p1', 'p2'].map(makePart);
    const parseError = createProviderStreamParseError('Failed to parse item: feedback response');
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockRejectedValue(parseError);
    const onPlanningError = vi.fn();
    const onPlanningDone = vi.fn();

    await expect(runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
      onPlanningError,
      onPlanningDone,
    })).rejects.toBe(parseError);

    expect(requestMoreParts).toHaveBeenCalledOnce();
    expect(onPlanningError).not.toHaveBeenCalled();
    expect(onPlanningDone).not.toHaveBeenCalled();
  });

  it('重複IDだけ返された場合は追加せず終了する', async () => {
    const part1 = makePart('p1');

    const completionEvents: string[] = [];
    const onPlanningNoNewParts = vi.fn();
    const runPart = vi.fn(async (part: PartDefinition) => makeResult(part));
    const requestMoreParts = vi.fn().mockResolvedValue({
      done: false,
      reasoning: 'duplicate only',
      cancelPartIds: [],
      parts: [{ id: 'p1', title: 'dup', instruction: 'dup' }],
    });

    const result = await runTeamLeaderExecution({
      initialParts: [part1],
      maxConcurrency: 1,
      runPart,
      requestMoreParts,
      reviewCompletion: vi.fn(async () => {
        completionEvents.push('review');
        return [];
      }),
      onPlanningNoNewParts: () => {
        completionEvents.push('planning-complete');
        onPlanningNoNewParts();
      },
    });

    expect(result.plannedParts.map((p) => p.id)).toEqual(['p1']);
    expect(result.partResults).toHaveLength(1);
    expect(onPlanningNoNewParts).toHaveBeenCalledTimes(1);
    expect(completionEvents).toEqual(['review', 'planning-complete']);
  });

  it('latches a terminal part failure, aborts siblings, and waits for their settlement', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const settled: string[] = [];
    const terminal = new Error('terminal contract violation');
    const runPart = vi.fn(async (part: PartDefinition) => {
      started.push(part.id);
      if (part.id === 'p1') throw terminal;
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      settled.push(part.id);
      return makeResult(part);
    });

    await expect(runTeamLeaderExecution({
      initialParts: ['p1', 'p2', 'p3'].map(makePart),
      maxConcurrency: 2,
      abortSignal: controller.signal,
      onTerminalError: (error) => controller.abort(error),
      runPart,
      requestMoreParts: vi.fn(),
    })).rejects.toBe(terminal);

    expect(started).toEqual(['p1', 'p2']);
    expect(settled).toEqual(['p2']);
    expect(controller.signal.reason).toBe(terminal);
  });

  it('fences sibling publication at settlement before terminal allSettled completes', async () => {
    const controller = new AbortController();
    const terminal = new Error('terminal contract violation');
    const publicationAttempts: string[] = [];
    const onPartCompleted = vi.fn();

    await expect(runTeamLeaderExecution({
      initialParts: ['p1', 'p2'].map(makePart),
      maxConcurrency: 2,
      abortSignal: controller.signal,
      onTerminalError: (error) => controller.abort(error),
      runPart: async (part, _partIndex, publicationFence) => {
        if (part.id === 'p1') throw terminal;
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        publicationAttempts.push('provider_settled');
        publicationFence.assertRunning('journal.accepted');
        publicationAttempts.push('journal.accepted');
        return makeResult(part);
      },
      requestMoreParts: vi.fn(),
      onPartCompleted,
    })).rejects.toBe(terminal);

    expect(publicationAttempts).toEqual(['provider_settled']);
    expect(onPartCompleted).not.toHaveBeenCalled();
  });

  it('keeps the parent terminating until a late sibling journals raw usage, without publishing session', async () => {
    const controller = new AbortController();
    const terminal = new Error('terminal contract violation');
    const events: string[] = [];
    let parentStage: 'running' | 'terminating' | 'terminated' = 'running';

    try {
      await runTeamLeaderExecution({
        initialParts: ['p1', 'p2'].map(makePart),
        maxConcurrency: 2,
        abortSignal: controller.signal,
        onTerminalError: (error) => {
          parentStage = 'terminating';
          events.push('parent.terminating');
          controller.abort(error);
        },
        runPart: async (part, _partIndex, publicationFence) => {
          if (part.id === 'p1') throw terminal;
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          expect(parentStage).toBe('terminating');
          events.push('child.applied');
          events.push('usage');
          publicationFence.assertRunning('part.session');
          events.push('session');
          return makeResult(part);
        },
        requestMoreParts: vi.fn(),
      });
    } catch (error) {
      parentStage = 'terminated';
      events.push('parent.terminated');
      expect(error).toBe(terminal);
    }

    expect(events).toEqual([
      'parent.terminating',
      'child.applied',
      'usage',
      'parent.terminated',
    ]);
    expect(parentStage).toBe('terminated');
  });

  it('queued partを取消し、取消済みIDを再利用させない', async () => {
    const startedPartIds: string[] = [];
    const requestMoreParts = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        reasoning: 'replace obsolete verification',
        cancelPartIds: ['p2'],
        parts: [makePart('p2'), makePart('p4')],
      })
      .mockResolvedValue({
        done: true,
        reasoning: 'complete',
        cancelPartIds: [],
        parts: [],
      });

    const result = await runTeamLeaderExecution({
      initialParts: ['p1', 'p2', 'p3'].map(makePart),
      maxConcurrency: 1,
      runPart: async (part) => {
        startedPartIds.push(part.id);
        return makeResult(part);
      },
      requestMoreParts,
    });

    expect(startedPartIds).toEqual(['p1', 'p3', 'p4']);
    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1', 'p3', 'p4']);
    expect(requestMoreParts).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cancellablePartIds: ['p2', 'p3'],
      scheduledIds: ['p1', 'p2', 'p3'],
    }));
  });

  it('doneと同時にrunning partを個別中断し、完了結果として公開しない', async () => {
    const receivedSignals = new Map<string, AbortSignal>();
    const result = await runTeamLeaderExecution({
      initialParts: ['p1', 'p2'].map(makePart),
      maxConcurrency: 2,
      runPart: async (part, _partIndex, _publicationFence, signal) => {
        receivedSignals.set(part.id, signal);
        if (part.id === 'p1') {
          return makeResult(part);
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw signal.reason;
      },
      requestMoreParts: async () => ({
        done: true,
        reasoning: 'p1 already completed verification',
        cancelPartIds: ['p2'],
        parts: [],
      }),
    });

    expect(receivedSignals.get('p2')?.aborted).toBe(true);
    expect(result.plannedParts.map((part) => part.id)).toEqual(['p1']);
    expect(result.partResults.map((partResult) => partResult.part.id)).toEqual(['p1']);
  });

  it('doneでrunning partを取消さない場合はsettlementまで待つ', async () => {
    let releasePart: (() => void) | undefined;
    let markFeedbackRequested: (() => void) | undefined;
    const runningPart = new Promise<void>((resolve) => {
      releasePart = resolve;
    });
    const feedbackRequested = new Promise<void>((resolve) => {
      markFeedbackRequested = resolve;
    });
    const execution = runTeamLeaderExecution({
      initialParts: ['p1', 'p2'].map(makePart),
      maxConcurrency: 2,
      runPart: async (part) => {
        if (part.id === 'p2') {
          await runningPart;
        }
        return makeResult(part);
      },
      requestMoreParts: async () => {
        markFeedbackRequested?.();
        return {
          done: true,
          reasoning: 'no more planning',
          cancelPartIds: [],
          parts: [],
        };
      },
    });

    await feedbackRequested;
    let settled = false;
    void execution.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releasePart?.();
    await expect(execution).resolves.toMatchObject({
      partResults: expect.arrayContaining([
        expect.objectContaining({ part: expect.objectContaining({ id: 'p2' }) }),
      ]),
    });
  });

  it('親abortと個別取消が競合した場合は親abort理由を送出する', async () => {
    const parentController = new AbortController();
    const parentReason = new Error('parent-stop');
    let cancellationObserved: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancellationObserved = resolve;
    });

    const execution = runTeamLeaderExecution({
      initialParts: ['p1', 'p2'].map(makePart),
      maxConcurrency: 2,
      abortSignal: parentController.signal,
      runPart: async (part, _partIndex, _publicationFence, signal) => {
        if (part.id === 'p1') return makeResult(part);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        cancellationObserved?.();
        await Promise.resolve();
        throw signal.reason;
      },
      requestMoreParts: async () => ({
        done: true,
        reasoning: 'cancel p2',
        cancelPartIds: ['p2'],
        parts: [],
      }),
    });

    await cancelled;
    parentController.abort(parentReason);
    await expect(execution).rejects.toBe(parentReason);
  });

  it('feedback待機中のterminal part失敗でfeedbackを中断する', async () => {
    const terminal = new Error('terminal failure');
    let failSecondPart: (() => void) | undefined;
    let feedbackStarted: (() => void) | undefined;
    const feedbackReady = new Promise<void>((resolve) => {
      feedbackStarted = resolve;
    });

    const execution = runTeamLeaderExecution({
      initialParts: ['p1', 'p2'].map(makePart),
      maxConcurrency: 2,
      runPart: async (part) => {
        if (part.id === 'p1') return makeResult(part);
        await new Promise<void>((resolve) => {
          failSecondPart = resolve;
        });
        throw terminal;
      },
      requestMoreParts: async ({ abortSignal }) => {
        feedbackStarted?.();
        await new Promise<void>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        });
        return { done: true, reasoning: 'unreachable', cancelPartIds: [], parts: [] };
      },
    });

    await feedbackReady;
    failSecondPart?.();
    await expect(execution).rejects.toBe(terminal);
  });
});
