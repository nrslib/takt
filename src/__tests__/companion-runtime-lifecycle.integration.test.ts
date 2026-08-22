import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CompanionReviewMode,
  NormalAgentWorkflowStep,
  TeamLeaderWorkflowStep,
  WorkflowState,
} from '../core/models/index.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { buildCompanionMailboxPath } from '../core/workflow/companion/mailbox.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
import { CompanionStructuredCaller } from '../core/workflow/companion/structured-call.js';

const roots: string[] = [];
const snapshot = {
  digest: 'digest-1',
  changedLines: 1,
  content: '+change\n',
  changedFiles: ['src/a.ts'],
  fileFingerprints: { 'src/a.ts': 'file-1' },
  hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
  omittedBytes: 0,
  truncated: false,
};

const reviewableSnapshot = {
  ...snapshot,
  changedLines: 20,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function step(fixed: string[], allowGitCommit = false): NormalAgentWorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'implement',
    edit: true,
    passPreviousResponse: true,
    companion: { fixed, pool: [] },
    rules: [],
    ...(allowGitCommit ? { allowGitCommit: true } : {}),
  };
}

function state(): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'implement',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    dynamicFacetSelections: new Map(),
    status: 'running',
  };
}

function dependencies(
  cwd: string,
  workflowStep: NormalAgentWorkflowStep | TeamLeaderWorkflowStep,
  diffReader: CompanionDiffReader,
  reviewMode: CompanionReviewMode = 'completion',
  intervalMs = 60_000,
  selectorProvider?: { provider: 'mock' },
) {
  return {
    cwd,
    projectCwd: cwd,
    failureDir: join(cwd, '.takt/runs/run/failures'),
    runSlug: 'run',
    runPathNamespace: [],
    language: 'en' as const,
    task: 'task',
    step: workflowStep,
    definitions: {
      reviewer: {
        name: 'reviewer',
        description: 'review',
        instruction: 'review',
        intervalMs,
      },
    },
    providers: { reviewer: { provider: 'mock' as const } },
    ...(selectorProvider === undefined ? {} : { selectorProvider }),
    diffReader,
    reviewMode,
    buildProviderCallCallbacks: () => ({ finish: vi.fn() }),
    emitEvent: vi.fn(),
    recordUsage: vi.fn(),
  };
}

function teamLeaderStep(): TeamLeaderWorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'implement',
    edit: true,
    passPreviousResponse: true,
    teamLeader: { maxConcurrency: 1, timeoutMs: 900000 },
    companion: { fixed: [], pool: ['reviewer'] },
    rules: [],
  };
}

describe('companion runtime lifecycle', () => {
  it('passes the latest cumulative diff to each completion review', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-cumulative-diff-'));
    roots.push(cwd);
    let currentSnapshot = {
      ...snapshot,
      digest: 'part-one-digest',
      changedLines: 12,
      content: '+PART_ONE_CHANGE\n',
      changedFiles: ['src/part-one.ts'],
      fileFingerprints: { 'src/part-one.ts': 'part-one-file' },
      hunkFingerprints: { 'src/part-one.ts:1-12': 'part-one-hunk' },
    };
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockImplementation(async () => ({
        status: 'ok' as const,
        snapshot: currentSnapshot,
      })),
    } satisfies CompanionDiffReader;
    const reviewPrompts: string[] = [];
    vi.spyOn(CompanionStructuredCaller.prototype, 'call')
      .mockImplementation(async (request) => {
        if (request.purpose === 'reviewer') reviewPrompts.push(request.prompt);
        const finding = reviewPrompts.length === 1
          ? {
              severity: 'must_fix',
              file: 'src/part-one.ts',
              line: 1,
              finding: 'PART_ONE_FINDING',
            }
          : undefined;
        return {
          persona: request.agentName,
          status: 'done',
          content: 'reviewed',
          structuredOutput: {
            findings: finding === undefined ? [] : [finding],
            notes: null,
          },
          timestamp: new Date(),
        };
      });
    const workflowStep = step(['reviewer']);
    const runtime = await CompanionStepRuntime.create(
      dependencies(cwd, workflowStep, diffReader),
    );
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      const firstReview = await runtime.complete(workflowState, 'part one complete', { followUpRound: 0 });
      currentSnapshot = {
        ...currentSnapshot,
        digest: 'cumulative-digest',
        content: '+PART_ONE_CHANGE\n+PART_TWO_CHANGE\n',
        changedFiles: ['src/part-one.ts', 'src/part-two.ts'],
        fileFingerprints: {
          'src/part-one.ts': 'part-one-file',
          'src/part-two.ts': 'part-two-file',
        },
        hunkFingerprints: {
          'src/part-one.ts:1-12': 'part-one-hunk',
          'src/part-two.ts:1-12': 'part-two-hunk',
        },
      };
      runtime.beginFollowUpRound(2, firstReview.findings.length);
      await expect(runtime.complete(workflowState, 'part two complete', { followUpRound: 1 }))
        .resolves.toEqual({ findings: [] });

      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts[0]).toContain('PART_ONE_CHANGE');
      expect(reviewPrompts[0]).toContain('part-one-digest');
      expect(reviewPrompts[0]).toContain('src/part-one.ts');
      expect(reviewPrompts[1]).toContain('PART_ONE_CHANGE');
      expect(reviewPrompts[1]).toContain('PART_TWO_CHANGE');
      expect(reviewPrompts[1]).toContain('cumulative-digest');
      expect(reviewPrompts[1]).toContain('src/part-one.ts');
      expect(reviewPrompts[1]).toContain('src/part-two.ts');
    } finally {
      runtime.stop();
    }
  });

  it('runs the Team Leader companion pool selector again for the next runtime', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-companion-reentry-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
    } satisfies CompanionDiffReader;
    const selectorResponse = {
      persona: 'selector',
      status: 'done' as const,
      content: 'selected',
      structuredOutput: { selected_ids: ['reviewer'], rationale: 'reviewer applies' },
      timestamp: new Date(),
    };
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call')
      .mockResolvedValueOnce(selectorResponse)
      .mockResolvedValueOnce({ ...selectorResponse, content: 'selected again' });
    const workflowStep = teamLeaderStep();

    const firstRuntime = await CompanionStepRuntime.create(
      dependencies(cwd, workflowStep, diffReader, 'completion', 60_000, { provider: 'mock' }),
    );
    firstRuntime.stop();
    const secondRuntime = await CompanionStepRuntime.create(
      dependencies(cwd, workflowStep, diffReader, 'completion', 60_000, { provider: 'mock' }),
    );
    secondRuntime.stop();

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ purpose: 'selector' }),
      expect.objectContaining({ purpose: 'selector' }),
    ]);
  });

  it('selects a Team Leader companion pool once for the lifetime of one runtime', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-companion-runtime-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
    } satisfies CompanionDiffReader;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call')
      .mockResolvedValueOnce({
        persona: 'selector',
        status: 'done',
        content: 'selected',
        structuredOutput: { selected_ids: ['reviewer'], rationale: 'reviewer applies' },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: { findings: [], notes: null },
        timestamp: new Date(),
      });
    const workflowStep = teamLeaderStep();
    const runtime = await CompanionStepRuntime.create(
      dependencies(cwd, workflowStep, diffReader, 'completion', 60_000, { provider: 'mock' }),
    );
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      await expect(runtime.complete(workflowState, 'done', { followUpRound: 0 }))
        .resolves.toEqual({ findings: [] });

      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[0]?.[0]).toMatchObject({ purpose: 'selector' });
      expect(call.mock.calls[1]?.[0]).toMatchObject({ purpose: 'reviewer' });
    } finally {
      runtime.stop();
    }
  });

  it('delivers appended rows once and clears the in-memory buffer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
    } satisfies CompanionDiffReader;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call')
      .mockResolvedValueOnce({
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'unsafe' }],
          notes: null,
        },
        timestamp: new Date('2026-08-14T00:00:00.000Z'),
      });
    const runtime = await CompanionStepRuntime.create(dependencies(cwd, step(['reviewer']), diffReader));
    expect(diffReader.readDiff).not.toHaveBeenCalled();
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      const first = await runtime.complete(workflowState, 'done', { followUpRound: 0 });
      expect(workflowState.companion).toEqual({
        completionSettled: false,
        followUpRounds: 0,
      });
      const second = await runtime.complete(workflowState, 'unchanged', { followUpRound: 1 });

      expect(first.findings).toHaveLength(1);
      expect(first.findings[0]).toMatchObject({
        companion: 'reviewer',
        reviewedDigest: 'digest-1',
        finding: 'unsafe',
      });
      expect(second.findings).toEqual([]);
      expect(call).toHaveBeenCalledOnce();
      expect(workflowState.companion).toEqual({
        completionSettled: true,
        followUpRounds: 1,
      });
      const mailboxPath = buildCompanionMailboxPath({
        cwd,
        runSlug: 'run',
        runPathNamespace: [],
        stepName: 'implement',
        companionName: 'reviewer',
      });
      expect(readFileSync(mailboxPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it('defers quiet, forced, commit, and changed-tool triggers until completion mode reaches the response boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-completion-mode-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: reviewableSnapshot }),
    } satisfies CompanionDiffReader;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockResolvedValue({
      persona: 'reviewer',
      status: 'done',
      content: 'reviewed',
      structuredOutput: { findings: [], notes: null },
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
    });
    const emitEvent = vi.fn();
    const runtime = await CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer'], true), diffReader, 'completion', 1),
      emitEvent,
    });
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Write', input: { file_path: 'src/a.ts' }, id: 'write-1' },
      });
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'git commit -am "change"' }, id: 'commit-1' },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(call).not.toHaveBeenCalled();

      await runtime.complete(workflowState, 'done', { followUpRound: 0 });

      expect(call).toHaveBeenCalledOnce();
      expect(emitEvent).toHaveBeenCalledWith('companion:start', {
        step: 'implement',
        companion: 'reviewer',
        reviewMode: 'completion',
      });
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:review_round'))
        .toEqual([
          ['companion:review_round', expect.objectContaining({ trigger: 'completion' })],
        ]);
    } finally {
      runtime.stop();
    }
  });

  it('keeps quiet-triggered review active in live mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-live-mode-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: reviewableSnapshot }),
    } satisfies CompanionDiffReader;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockResolvedValue({
      persona: 'reviewer',
      status: 'done',
      content: 'reviewed',
      structuredOutput: { findings: [], notes: null },
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
    });
    const emitEvent = vi.fn();
    const runtime = await CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer']), diffReader, 'live'),
      emitEvent,
    });

    try {
      runtime.beginReviewAttempt();
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Write', input: { file_path: 'src/a.ts' }, id: 'write-1' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(call).toHaveBeenCalledOnce();
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:review_round'))
        .toEqual([
          ['companion:review_round', expect.objectContaining({ trigger: 'quiet' })],
        ]);
    } finally {
      runtime.stop();
    }
  });

  it('does not emit companion:start when the live initial snapshot fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-live-init-failure-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'error',
        failure: { code: 'git_failure', message: 'git diff failed' },
      }),
    } satisfies CompanionDiffReader;
    const emitEvent = vi.fn();

    await expect(CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer']), diffReader, 'live'),
      emitEvent,
    })).rejects.toThrow();

    expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:start'))
      .toEqual([]);
  });

  it('waits for a running live review before completing and skips its reviewed digest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-live-drain-reviewed-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: reviewableSnapshot }),
    } satisfies CompanionDiffReader;
    let releaseReview!: () => void;
    let reviewStarted!: () => void;
    const reviewStartedPromise = new Promise<void>((resolve) => { reviewStarted = resolve; });
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(async () => {
      reviewStarted();
      await reviewGate;
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: { findings: [], notes: null },
        timestamp: new Date('2026-08-14T00:00:00.000Z'),
      };
    });
    const emitEvent = vi.fn();
    const runtime = await CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer']), diffReader, 'live'),
      emitEvent,
    });
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Write', input: { file_path: 'src/a.ts' }, id: 'write-1' },
      });
      await vi.advanceTimersByTimeAsync(300);
      await reviewStartedPromise;

      let settled = false;
      const completion = runtime.complete(workflowState, 'done', { followUpRound: 0 })
        .then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseReview();
      await completion;

      expect(call).toHaveBeenCalledOnce();
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:review_round'))
        .toEqual([
          ['companion:review_round', expect.objectContaining({ trigger: 'quiet', digest: 'digest-1' })],
        ]);
    } finally {
      releaseReview();
      runtime.stop();
    }
  });

  it('reviews a new digest after draining the running live review at completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-live-drain-new-'));
    roots.push(cwd);
    const changedSnapshot = {
      ...reviewableSnapshot,
      digest: 'digest-2',
      content: '+changed after quiet review\n',
      fileFingerprints: { 'src/a.ts': 'file-2' },
      hunkFingerprints: { 'src/a.ts:1-1': 'hunk-2' },
    };
    let latestSnapshot = reviewableSnapshot;
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockImplementation(async () => ({ status: 'ok', snapshot: latestSnapshot })),
    } satisfies CompanionDiffReader;
    let releaseReview!: () => void;
    let reviewStarted!: () => void;
    const reviewStartedPromise = new Promise<void>((resolve) => { reviewStarted = resolve; });
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    let firstCall = true;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        reviewStarted();
        await reviewGate;
      }
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: { findings: [], notes: null },
        timestamp: new Date('2026-08-14T00:00:00.000Z'),
      };
    });
    const emitEvent = vi.fn();
    const runtime = await CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer']), diffReader, 'live'),
      emitEvent,
    });
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Write', input: { file_path: 'src/a.ts' }, id: 'write-1' },
      });
      await vi.advanceTimersByTimeAsync(300);
      await reviewStartedPromise;
      latestSnapshot = changedSnapshot;

      const completion = runtime.complete(workflowState, 'done', { followUpRound: 0 });
      releaseReview();
      await completion;

      expect(call).toHaveBeenCalledTimes(2);
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:review_round'))
        .toEqual([
          ['companion:review_round', expect.objectContaining({ trigger: 'quiet', digest: 'digest-1' })],
          ['companion:review_round', expect.objectContaining({ trigger: 'completion', digest: 'digest-2' })],
        ]);
    } finally {
      releaseReview();
      runtime.stop();
    }
  });

  it('reviews a changed follow-up digest after delivering an accepted finding', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-digest-'));
    roots.push(cwd);
    const changedSnapshot = {
      ...reviewableSnapshot,
      digest: 'digest-2',
      content: '+changed again\n',
      fileFingerprints: { 'src/a.ts': 'file-2' },
      hunkFingerprints: { 'src/a.ts:1-1': 'hunk-2' },
    };
    const diffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn()
        .mockResolvedValueOnce({ status: 'ok', snapshot: reviewableSnapshot })
        .mockResolvedValueOnce({ status: 'ok', snapshot: changedSnapshot }),
    } satisfies CompanionDiffReader;
    const call = vi.spyOn(CompanionStructuredCaller.prototype, 'call')
      .mockResolvedValueOnce({
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'unsafe' }],
          notes: null,
        },
        timestamp: new Date('2026-08-14T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed again',
        structuredOutput: { findings: [], notes: null },
        timestamp: new Date('2026-08-14T00:00:01.000Z'),
      });
    const emitEvent = vi.fn();
    const runtime = await CompanionStepRuntime.create({
      ...dependencies(cwd, step(['reviewer']), diffReader, 'completion'),
      emitEvent,
    });
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      const first = await runtime.complete(workflowState, 'initial', { followUpRound: 0 });
      runtime.beginFollowUpRound(1, first.findings.length);
      await runtime.complete(workflowState, 'fixed', { followUpRound: 1 });

      expect(first.findings).toHaveLength(1);
      expect(call).toHaveBeenCalledTimes(2);
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:review_round'))
        .toEqual([
          ['companion:review_round', expect.objectContaining({ trigger: 'completion', digest: 'digest-1' })],
          ['companion:review_round', expect.objectContaining({ trigger: 'completion', digest: 'digest-2' })],
        ]);
    } finally {
      runtime.stop();
    }
  });

  it('skips baseline, diff, scheduler, and completion waiting when selection is empty', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-companion-empty-'));
    roots.push(cwd);
    const diffReader = {
      readBaselineSha: vi.fn(),
      readDiff: vi.fn(),
    } satisfies CompanionDiffReader;
    const runtime = await CompanionStepRuntime.create(dependencies(cwd, step([]), diffReader));
    const workflowState = state();

    try {
      runtime.beginReviewAttempt();
      await expect(runtime.complete(workflowState, 'done', { followUpRound: 0 }))
        .resolves.toEqual({ findings: [] });
      expect(diffReader.readBaselineSha).not.toHaveBeenCalled();
      expect(diffReader.readDiff).not.toHaveBeenCalled();
      expect(workflowState.companion).toEqual({
        completionSettled: true,
        followUpRounds: 0,
      });
    } finally {
      runtime.stop();
    }
  });
});
