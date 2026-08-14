import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalAgentWorkflowStep, WorkflowState } from '../core/models/index.js';
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

function dependencies(cwd: string, workflowStep: NormalAgentWorkflowStep, diffReader: CompanionDiffReader) {
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
    diffReader,
    buildProviderCallCallbacks: () => ({ finish: vi.fn() }),
    emitEvent: vi.fn(),
    recordUsage: vi.fn(),
  };
}

describe('companion runtime lifecycle', () => {
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
