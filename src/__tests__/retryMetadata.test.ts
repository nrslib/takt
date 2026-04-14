import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMeta } from '../core/workflow/run/run-meta.js';
import { readRetryMetadataByRunSlug, resolveRetryMetadataFromRunMeta } from '../core/workflow/run/retry-metadata.js';

describe('resolveRetryMetadataFromRunMeta', () => {
  it('resume_point の root step と iteration を retry metadata の基準にする', () => {
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const runMeta: RunMeta = {
      task: 'Task A',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'aborted',
      startTime: '2026-04-13T00:00:00.000Z',
      currentStep: 'final-review',
      currentIteration: 9,
      resumePoint,
    };

    expect(resolveRetryMetadataFromRunMeta(runMeta)).toEqual({
      startStep: 'delegate',
      resumePoint,
      currentIteration: 7,
    });
  });

  it('deep child stack を含む resume_point でも root step と iteration を retry metadata の基準にする', () => {
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'fix', kind: 'agent' as const },
      ],
      iteration: 11,
      elapsed_ms: 183245,
    };
    const runMeta: RunMeta = {
      task: 'Task A',
      workflow: 'default',
      runSlug: 'run-1b',
      runRoot: '.takt/runs/run-1b',
      reportDirectory: '.takt/runs/run-1b/reports',
      contextDirectory: '.takt/runs/run-1b/context',
      logsDirectory: '.takt/runs/run-1b/logs',
      status: 'aborted',
      startTime: '2026-04-13T00:00:00.000Z',
      currentStep: 'final-review',
      currentIteration: 12,
      resumePoint,
    };

    expect(resolveRetryMetadataFromRunMeta(runMeta)).toEqual({
      startStep: 'delegate',
      resumePoint,
      currentIteration: 11,
    });
  });

  it('resume_point がなければ currentStep と currentIteration にフォールバックする', () => {
    const runMeta: RunMeta = {
      task: 'Task A',
      workflow: 'default',
      runSlug: 'run-2',
      runRoot: '.takt/runs/run-2',
      reportDirectory: '.takt/runs/run-2/reports',
      contextDirectory: '.takt/runs/run-2/context',
      logsDirectory: '.takt/runs/run-2/logs',
      status: 'aborted',
      startTime: '2026-04-13T00:00:00.000Z',
      currentStep: 'final-review',
      currentIteration: 9,
    };

    expect(resolveRetryMetadataFromRunMeta(runMeta)).toEqual({
      startStep: 'final-review',
      currentIteration: 9,
    });
  });
});

describe('readRetryMetadataByRunSlug', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-retry-metadata-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('meta.json が壊れていると preserveExisting と warning を返す', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260413-task-a', 'meta.json');
    const warnings: string[] = [];
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json', 'utf-8');

    expect(readRetryMetadataByRunSlug(projectDir, '20260413-task-a', (warning) => {
      warnings.push(warning);
    })).toEqual({
      preserveExisting: true,
    });
    expect(warnings).toEqual([
      expect.stringContaining(`Failed to parse run metadata at ${metaPath}`),
    ]);
  });
});
