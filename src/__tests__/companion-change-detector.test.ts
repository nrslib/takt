import { describe, expect, it, vi } from 'vitest';
import { CompanionChangeDetector } from '../core/workflow/companion/change-detector.js';
import type { CompanionDiff } from '../core/workflow/companion/diff-reader.js';
import { isGitCommitCommand } from '../core/workflow/companion/git-command.js';
import { CompanionTriggerScheduler } from '../core/workflow/companion/trigger-scheduler.js';
import type { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';
import { createAbortError } from '../core/workflow/companion/abort.js';

function tool(toolName: string) {
  return { type: 'tool_use' as const, data: { tool: toolName, input: {}, id: `tool-${toolName}` } };
}

function diff(digest: string, changedLines: number) {
  return {
    digest,
    changedLines,
    content: digest,
    changedFiles: ['src/a.ts'],
    fileFingerprints: { 'src/a.ts': digest },
    hunkFingerprints: { 'src/a.ts:1-1': digest },
    omittedBytes: 0,
    truncated: false,
  };
}

async function evaluateLive(
  detector: CompanionChangeDetector,
  snapshot?: CompanionDiff,
) {
  const candidate = detector.getTriggerCandidate(100);
  return candidate === undefined ? undefined : detector.evaluateCandidate(candidate, snapshot);
}

async function evaluateCompletion(
  detector: CompanionChangeDetector,
  snapshot?: CompanionDiff,
) {
  return detector.evaluateCandidate(detector.getCompletionCandidate(false), snapshot);
}

describe('CT-COMP-05 event-driven companion change detection', () => {
  it('should mark explicit write tools dirty without reading Git synchronously', () => {
    const readDiff = vi.fn();
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff,
    });

    detector.observe(tool('Write'));
    detector.observe(tool('Edit'));
    detector.observe({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'git add src/a.ts' }, id: 'tool-bash' },
    });

    expect(detector.isDirty()).toBe(true);
    expect(readDiff).not.toHaveBeenCalled();
  });

  it.each(['edit', 'write'])('should recognize a stream event as mutating when the OpenCode tool name is %s', (toolName) => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });

    detector.observe({
      type: 'tool_use',
      data: {
        tool: toolName,
        input: { filePath: 'src/a.ts', content: 'changed' },
        id: `opencode-${toolName}`,
      },
    });

    expect(detector.isDirty()).toBe(true);
  });

  it('should ignore OpenCode Bash events even when they carry a command', () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });

    detector.observe({
      type: 'tool_use',
      data: { tool: 'bash', input: {}, id: 'opencode-bash-without-command' },
    });
    expect(detector.isDirty()).toBe(false);

    detector.observe({
      type: 'tool_use',
      data: {
        tool: 'bash',
        input: { command: 'git add src/a.ts' },
        id: 'opencode-bash-command',
      },
    });
    expect(detector.isDirty()).toBe(false);
  });

  it('should ignore read-only tool events', () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });

    detector.observe(tool('Read'));

    expect(detector.isDirty()).toBe(false);
  });

  it('should trigger at the minimum diff boundary after the quiet interval', async () => {
    let now = 1_000;
    const readDiff = vi.fn().mockResolvedValue(diff('diff-a', 10));
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff,
    });
    detector.observe(tool('Edit'));
    now = 1_250;

    const trigger = await evaluateLive(detector);

    expect(trigger).toMatchObject({ reason: 'quiet', snapshot: { digest: 'diff-a' } });
    expect(readDiff).toHaveBeenCalledOnce();
  });

  it('should not trigger one line below the minimum during live execution', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff: vi.fn().mockResolvedValue(diff('diff-a', 9)),
    });
    detector.observe(tool('Edit'));
    now = 1_250;

    expect(await evaluateLive(detector)).toBeUndefined();
  });

  it('should force a trigger after four intervals even when edits never become quiet', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff: vi.fn().mockResolvedValue(diff('diff-a', 10)),
    });
    detector.observe(tool('Edit'));
    now = 1_300;
    detector.observe(tool('Edit'));
    now = 1_400;

    expect(await evaluateLive(detector)).toMatchObject({ reason: 'forced' });
  });

  it('should completion-trigger an unreviewed change below the minimum threshold', async () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn().mockResolvedValue(diff('diff-a', 1)),
    });
    detector.observe(tool('Edit'));

    expect(await evaluateCompletion(detector)).toMatchObject({
      reason: 'completion',
      snapshot: { digest: 'diff-a' },
    });
  });

  it('should completion-trigger an unreviewed snapshot without a tool event or another diff read', async () => {
    const readDiff = vi.fn();
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff,
    });

    const trigger = await evaluateCompletion(detector, diff('completion-snapshot', 1));

    expect(trigger).toMatchObject({
      reason: 'completion',
      snapshot: { digest: 'completion-snapshot' },
    });
    expect(readDiff).not.toHaveBeenCalled();
  });

  it('should not completion-trigger an unchanged empty snapshot', async () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });

    expect(await evaluateCompletion(detector, {
      ...diff('empty', 0),
      content: '',
      changedFiles: [],
      fileFingerprints: {},
      hunkFingerprints: {},
    })).toBeUndefined();
  });

  it('should suppress a review when the diff digest has not changed since the prior review', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff: vi.fn().mockResolvedValue(diff('same-diff', 10)),
    });
    detector.observe(tool('Edit'));
    now = 1_100;
    expect(await evaluateLive(detector)).toBeDefined();
    detector.markReviewed(diff('same-diff', 10), 1);
    now = 1_200;
    detector.observe(tool('Edit'));
    now = 1_300;

    expect(await evaluateLive(detector)).toBeUndefined();
  });

  it('should allow an explicitly authorized unchanged-digest completion review without changing normal dedupe', async () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });
    detector.markReviewed(diff('same-diff', 10), 0);

    expect(await evaluateCompletion(detector, diff('same-diff', 1))).toBeUndefined();
    expect(await detector.evaluateCandidate(
      detector.getCompletionCandidate(true),
      diff('same-diff', 1),
    )).toMatchObject({
      reason: 'completion',
      snapshot: { digest: 'same-diff' },
    });
    expect(await evaluateCompletion(detector, diff('same-diff', 1))).toBeUndefined();
  });

  it('should keep completion authorization explicit after a live review consumes its generation', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 1,
      now: () => now,
      readDiff: vi.fn().mockResolvedValue(diff('live-diff', 1)),
    });
    detector.markReviewed(diff('initial-diff', 1), 0);
    detector.observe(tool('Edit'));
    now = 1_100;
    const live = await evaluateLive(detector, diff('live-diff', 1));
    expect(live).toBeDefined();
    detector.markReviewed(diff('live-diff', 1), live!.observedGeneration);

    expect(await evaluateCompletion(detector, diff('live-diff', 1))).toBeUndefined();
    expect(await detector.evaluateCandidate(
      detector.getCompletionCandidate(true),
      diff('live-diff', 1),
    )).toBeDefined();
  });

  it('should retain an edit observed after the reviewed snapshot generation', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff: vi.fn(),
    });
    detector.observe(tool('Edit'));
    now = 1_100;
    const candidate = detector.getTriggerCandidate(100);
    expect(candidate).toBeDefined();
    const trigger = await detector.evaluateCandidate(candidate!, diff('first', 10));
    now = 1_101;
    detector.observe(tool('Edit'));

    detector.markReviewed(trigger!.snapshot, trigger!.observedGeneration);
    now = 1_201;

    expect(detector.isDirty()).toBe(true);
    expect(detector.getTriggerCandidate(100)).toMatchObject({ reason: 'quiet' });
  });

  it('should leave read-only Bash events available for completion snapshots', async () => {
    let now = 1_000;
    const empty = { ...diff('empty', 0), changedFiles: [], content: '' };
    const readDiff = vi.fn().mockResolvedValue(empty);
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff,
    });
    detector.observe({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'git status' }, id: 'status' },
    });
    now = 1_100;

    expect(await evaluateLive(detector)).toBeUndefined();
    expect(await evaluateLive(detector)).toBeUndefined();
    expect(readDiff).not.toHaveBeenCalled();
    expect(detector.isDirty()).toBe(false);
    expect(await evaluateCompletion(detector, diff('completion-change', 1))).toMatchObject({
      reason: 'completion',
    });
  });

  it('should let a commit candidate bypass the live minimum line threshold', async () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn().mockResolvedValue(diff('commit', 1)),
    });

    detector.observeCommit();

    expect(await evaluateLive(detector)).toMatchObject({ reason: 'commit' });
  });

  it('should report only hunk regions changed since the previous review', () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });
    detector.markReviewed({
      ...diff('first', 10),
      changedFiles: ['src/a.ts'],
      fileFingerprints: { 'src/a.ts': 'a-1' },
      hunkFingerprints: { 'src/a.ts:1-2': 'hunk-a-1' },
    }, 0);

    expect(detector.changedRegionsSinceLastReview({
      ...diff('second', 11),
      changedFiles: ['src/a.ts', 'src/b.ts'],
      fileFingerprints: { 'src/a.ts': 'a-2', 'src/b.ts': 'b-1' },
      hunkFingerprints: {
        'src/a.ts:1-2': 'hunk-a-1',
        'src/a.ts:8-9': 'hunk-a-2',
        'src/b.ts:1-1': 'hunk-b-1',
      },
    })).toEqual(['src/a.ts:8-9', 'src/b.ts:1-1']);
  });

  it('should report a file removed from the cumulative diff after the previous review', () => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });
    detector.markReviewed({
      ...diff('first', 10),
      changedFiles: ['src/a.ts', 'src/b.ts'],
      fileFingerprints: { 'src/a.ts': 'a-1', 'src/b.ts': 'b-1' },
      hunkFingerprints: {
        'src/a.ts:1-1': 'a-1',
        'src/b.ts:3-3': 'b-1',
      },
    }, 0);

    expect(detector.changedRegionsSinceLastReview({
      ...diff('second', 1),
      changedFiles: ['src/a.ts'],
      fileFingerprints: { 'src/a.ts': 'a-1' },
      hunkFingerprints: { 'src/a.ts:1-1': 'a-1' },
    })).toEqual(['src/b.ts:3-3']);
  });

  it.each([
    'git commit -m change',
    'git -C . commit -m change',
    'git -c user.name=Test commit -m change',
    'command git --no-pager -C . commit -m change',
    'env TAKT_TEST=1 git commit -m change',
    'env -i TAKT_TEST=1 -- git --git-dir=.git commit -m change',
    'git --git-dir=.git commit -m change',
  ])('should recognize valid Git global options before commit: %s', (command) => {
    expect(isGitCommitCommand(command)).toBe(true);
  });

  it.each([
    'git diff -- src/a.ts',
    'git -C . status',
    'echo git commit',
  ])('should not classify a non-commit command as a commit: %s', (command) => {
    expect(isGitCommitCommand(command)).toBe(false);
  });

  it.each([
    'echo value > src/a.ts',
    'touch src/a.ts',
    'npm run format',
    'git apply change.patch',
    'node scripts/write-file.js',
    'git diff -- src/a.ts',
  ])('should not extend the debounce for Bash commands: %s', (command) => {
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => 1_000,
      readDiff: vi.fn(),
    });

    detector.observe({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command }, id: 'tool-bash' },
    });

    expect(detector.isDirty()).toBe(false);
  });

  it('should not postpone an edit review when a read-only Bash command follows it', async () => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 15_000,
      minimumChangedLines: 1,
      now: () => now,
      readDiff: vi.fn().mockResolvedValue(diff('edited', 1)),
    });

    detector.observe(tool('Edit'));
    now = 1_100;
    detector.observe({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'npm test' }, id: 'test-command' },
    });
    now = 1_250;

    await expect(evaluateLive(detector, diff('edited', 1))).resolves.toMatchObject({
      reason: 'quiet',
    });
  });

  it('should review shortly after an explicit edit without waiting for the poll interval', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 10,
        now: () => now,
        readDiff: vi.fn(),
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: diff('initial', 0),
        readSnapshot: vi.fn().mockResolvedValue(diff('edited', 10)),
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.start();
      scheduler.observe(tool('Edit'));
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);

      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'quiet',
        snapshot: expect.objectContaining({ digest: 'edited' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should re-evaluate an edit that arrives while a prior evaluation is in flight', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      let resolveFirst!: (snapshot: CompanionDiff) => void;
      let resolveSecond!: (snapshot: CompanionDiff) => void;
      const readSnapshot = vi.fn()
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveFirst = resolve;
        }))
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveSecond = resolve;
        }));
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: diff('initial', 0),
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe(tool('Edit'));
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);
      expect(readSnapshot).toHaveBeenCalledOnce();

      now = 1_260;
      scheduler.observe(tool('Edit'));
      now = 1_510;
      await vi.advanceTimersByTimeAsync(250);
      resolveFirst(diff('first', 10));
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueue).toHaveBeenCalledTimes(1);

      now = 1_760;
      await vi.advanceTimersByTimeAsync(250);
      expect(readSnapshot).toHaveBeenCalledTimes(2);
      resolveSecond(diff('second', 10));
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue.mock.calls.map(([request]) => request.snapshot.digest)).toEqual([
        'first',
        'second',
      ]);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should detect a Bash mutation from before/after diff snapshots without parsing the command', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const before = diff('before', 0);
      const after = diff('after', 10);
      let resolveAfter!: (snapshot: CompanionDiff) => void;
      const readSnapshot = vi.fn()
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveAfter = resolve;
        }))
        .mockResolvedValueOnce(after);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: before,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'bash', input: { command: 'node scripts/write-file.js' }, id: 'bash-1' },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(readSnapshot).not.toHaveBeenCalled();
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-1', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(readSnapshot).toHaveBeenCalledOnce();
      resolveAfter(after);
      await vi.advanceTimersByTimeAsync(0);
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);

      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'quiet',
        snapshot: expect.objectContaining({ digest: 'after' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not postpone an explicit Edit review after a read-only Bash result', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const unchanged = diff('edited', 1);
      const readSnapshot = vi.fn()
        .mockResolvedValueOnce(unchanged)
        .mockResolvedValueOnce(unchanged);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe(tool('Edit'));
      now = 1_100;
      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm test' }, id: 'bash-read' },
      });
      await vi.advanceTimersByTimeAsync(0);
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-read', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);

      expect(enqueue).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not attribute an Edit after a clean Bash start to that Bash result', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const afterEdit = diff('edited', 10);
      const readSnapshot = vi.fn().mockResolvedValue(afterEdit);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm test' }, id: 'bash-read' },
      });
      now = 1_100;
      scheduler.observe(tool('Edit'));
      await vi.advanceTimersByTimeAsync(100);
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-read', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);

      now = 1_350;
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getObservedGeneration()).toBe(1);
      expect(enqueue).toHaveBeenCalledOnce();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should probe an ID-less Bash result when a preceding Read result is missing', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const after = diff('bash-change', 10);
      const readSnapshot = vi.fn().mockResolvedValueOnce(after).mockResolvedValueOnce(after);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Read', input: { path: 'src/a.ts' }, id: 'read-1' },
      });
      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm run format' }, id: 'bash-1' },
      });
      scheduler.observe({
        type: 'tool_result',
        data: { content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);

      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        snapshot: expect.objectContaining({ digest: 'bash-change' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should match an identified tool result only to its Bash request', async () => {
    vi.useFakeTimers();
    try {
      const initial = diff('baseline', 0);
      const after = diff('bash-change', 10);
      const readSnapshot = vi.fn().mockResolvedValue(after);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => 1_000,
        readDiff: readSnapshot,
      });
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm run format' }, id: 'bash-1' },
      });
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'read-1', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(readSnapshot).not.toHaveBeenCalled();

      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-1', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(readSnapshot).toHaveBeenCalledOnce();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should retain a Bash change observed while its Edit review is still evaluating', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const edited = diff('edited', 10);
      const bashChanged = diff('bash-changed', 12);
      const readSnapshot = vi.fn()
        .mockResolvedValueOnce(edited)
        .mockResolvedValueOnce(bashChanged)
        .mockResolvedValue(bashChanged);
      let resolveQueue!: () => void;
      const queuePromise = new Promise<void>((resolve) => {
        resolveQueue = resolve;
      });
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockReturnValue(queuePromise);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe(tool('Edit'));
      now = 1_250;
      await vi.advanceTimersByTimeAsync(250);
      expect(enqueue).toHaveBeenCalledOnce();

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm run format' }, id: 'bash-in-flight' },
      });
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-in-flight', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getObservedGeneration()).toBe(2);
      resolveQueue();
      await vi.advanceTimersByTimeAsync(0);
      now = 1_500;
      await vi.advanceTimersByTimeAsync(250);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
        snapshot: expect.objectContaining({ digest: 'bash-changed' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should retain a Bash change after an Edit snapshot crosses the evaluation boundary', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const edited = diff('edited', 10);
      const bashChanged = diff('bash-changed', 12);
      let resolveEvaluationSnapshot!: (snapshot: CompanionDiff) => void;
      const readSnapshot = vi.fn()
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveEvaluationSnapshot = resolve;
        }))
        .mockResolvedValueOnce(bashChanged)
        .mockResolvedValue(bashChanged);
      let resolveQueue!: () => void;
      const queuePromise = new Promise<void>((resolve) => {
        resolveQueue = resolve;
      });
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockReturnValue(queuePromise);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm test' }, id: 'bash-before-edit' },
      });
      now = 1_100;
      scheduler.observe(tool('Edit'));
      now = 1_350;
      await vi.advanceTimersByTimeAsync(250);
      expect(readSnapshot).toHaveBeenCalledOnce();

      resolveEvaluationSnapshot(edited);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueue).toHaveBeenCalledOnce();

      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-before-edit', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getObservedGeneration()).toBe(2);
      resolveQueue();
      await vi.advanceTimersByTimeAsync(0);
      now = 1_600;
      await vi.advanceTimersByTimeAsync(250);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
        snapshot: expect.objectContaining({ digest: 'bash-changed' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should serialize overlapping Bash snapshot probes', async () => {
    vi.useFakeTimers();
    try {
      const initial = diff('baseline', 0);
      const changed = diff('bash-changed', 12);
      let resolveFirstProbe!: (snapshot: CompanionDiff) => void;
      const readSnapshot = vi.fn()
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveFirstProbe = resolve;
        }))
        .mockResolvedValueOnce(changed);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => 1_000,
        readDiff: readSnapshot,
      });
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      for (const id of ['bash-1', 'bash-2']) {
        scheduler.observe({
          type: 'tool_use',
          data: { tool: 'Bash', input: { command: 'npm run format' }, id },
        });
      }
      for (const id of ['bash-1', 'bash-2']) {
        scheduler.observe({
          type: 'tool_result',
          data: { id, content: '', isError: false },
        });
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(readSnapshot).toHaveBeenCalledOnce();
      resolveFirstProbe(changed);
      await vi.advanceTimersByTimeAsync(0);

      expect(readSnapshot).toHaveBeenCalledTimes(2);
      expect(detector.getObservedGeneration()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should serialize a Bash snapshot probe with a scheduled evaluation snapshot', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const initial = diff('baseline', 0);
      const bashChanged = diff('bash-changed', 8);
      const edited = diff('edited-after-bash', 12);
      let resolveProbe!: (snapshot: CompanionDiff) => void;
      const readSnapshot = vi.fn()
        .mockImplementationOnce(() => new Promise<CompanionDiff>((resolve) => {
          resolveProbe = resolve;
        }))
        .mockResolvedValueOnce(edited);
      const detector = new CompanionChangeDetector({
        intervalMs: 15_000,
        minimumChangedLines: 1,
        now: () => now,
        readDiff: readSnapshot,
      });
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CompanionTriggerScheduler({
        detectors: new Map([['security-reviewer', detector]]),
        intervals: [15_000],
        allowGitCommit: false,
        queue: { enqueue } as unknown as CompanionReviewQueue,
        initialSnapshot: initial,
        readSnapshot,
        isAborted: () => false,
        onError: vi.fn(),
      });

      scheduler.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm run format' }, id: 'bash-1' },
      });
      scheduler.observe({
        type: 'tool_result',
        data: { id: 'bash-1', content: '', isError: false },
      });
      await vi.advanceTimersByTimeAsync(0);

      now = 1_100;
      scheduler.observe(tool('Edit'));
      now = 1_350;
      await vi.advanceTimersByTimeAsync(250);
      expect(readSnapshot).toHaveBeenCalledOnce();

      resolveProbe(bashChanged);
      await vi.advanceTimersByTimeAsync(0);

      expect(readSnapshot).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        snapshot: expect.objectContaining({ digest: 'edited-after-bash' }),
      }));
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { error: createAbortError(), reports: false },
    { error: new Error('review failed'), reports: true },
  ])('should report scheduler failures except completion-derived AbortError', async ({ error, reports }) => {
    let now = 1_000;
    const detector = new CompanionChangeDetector({
      intervalMs: 100,
      minimumChangedLines: 10,
      now: () => now,
      readDiff: vi.fn(),
    });
    detector.observe(tool('Edit'));
    now = 1_250;
    const onError = vi.fn();
    const scheduler = new CompanionTriggerScheduler({
      detectors: new Map([['security-reviewer', detector]]),
      intervals: [100],
      allowGitCommit: false,
      queue: { enqueue: vi.fn().mockRejectedValue(error) } as unknown as CompanionReviewQueue,
      initialSnapshot: diff('initial', 0),
      readSnapshot: vi.fn().mockResolvedValue(diff('current', 10)),
      isAborted: () => false,
      onError,
    });

    await scheduler.evaluateNow();

    expect(onError).toHaveBeenCalledTimes(reports ? 1 : 0);
  });
});
