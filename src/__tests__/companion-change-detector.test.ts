import { describe, expect, it, vi } from 'vitest';
import { CompanionChangeDetector } from '../core/workflow/companion/change-detector.js';
import type { CompanionDiff } from '../core/workflow/companion/diff-reader.js';
import { isGitCommitCommand } from '../core/workflow/companion/git-command.js';

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
  const candidate = detector.getTriggerCandidate();
  return candidate === undefined ? undefined : detector.evaluateCandidate(candidate, snapshot);
}

async function evaluateCompletion(
  detector: CompanionChangeDetector,
  snapshot?: CompanionDiff,
) {
  return detector.evaluateCandidate(detector.getCompletionCandidate(), snapshot);
}

describe('CT-COMP-05 event-driven companion change detection', () => {
  it('should mark Write, Edit, and mutating Bash events dirty without reading Git synchronously', () => {
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
    now = 1_100;

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
    now = 1_100;

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
    const candidate = detector.getTriggerCandidate();
    expect(candidate).toBeDefined();
    const trigger = await detector.evaluateCandidate(candidate!, diff('first', 10));
    now = 1_101;
    detector.observe(tool('Edit'));

    detector.markReviewed(trigger!.snapshot, trigger!.observedGeneration);
    now = 1_201;

    expect(detector.isDirty()).toBe(true);
    expect(detector.getTriggerCandidate()).toMatchObject({ reason: 'quiet' });
  });

  it('should consume an empty Bash candidate once and still inspect completion snapshots', async () => {
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
    expect(readDiff).toHaveBeenCalledOnce();
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
  ])('should treat Bash as a dirty candidate and defer read-only filtering to the diff digest: %s', (command) => {
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

    expect(detector.isDirty()).toBe(true);
  });
});
