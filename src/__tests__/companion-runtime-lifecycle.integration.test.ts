import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function step(fixed: string[]): NormalAgentWorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'implement',
    edit: true,
    passPreviousResponse: true,
    companion: { fixed, pool: [] },
    rules: [],
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
        intervalMs: 60_000,
      },
    },
    providers: { reviewer: { provider: 'mock' as const } },
    ...(selectorProvider === undefined ? {} : { selectorProvider }),
    diffReader,
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
  it('rereads the latest diff for each completion review without embedding it in the prompt', async () => {
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

      expect(diffReader.readDiff).toHaveBeenCalledTimes(3);
      expect(reviewPrompts).toHaveLength(2);
      for (const prompt of reviewPrompts) {
        expect(prompt).toContain('"label":"baseline_sha","value":"baseline"');
        expect(prompt).not.toContain('PART_ONE_CHANGE');
        expect(prompt).not.toContain('PART_TWO_CHANGE');
        expect(prompt).not.toContain('part-one-digest');
        expect(prompt).not.toContain('cumulative-digest');
        expect(prompt).not.toContain('src/part-one.ts');
        expect(prompt).not.toContain('src/part-two.ts');
      }
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
      dependencies(cwd, workflowStep, diffReader, { provider: 'mock' }),
    );
    firstRuntime.stop();
    const secondRuntime = await CompanionStepRuntime.create(
      dependencies(cwd, workflowStep, diffReader, { provider: 'mock' }),
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
      dependencies(cwd, workflowStep, diffReader, { provider: 'mock' }),
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
