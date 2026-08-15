import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DynamicParallelPoolSubStep,
  DynamicParallelSelectionSnapshot,
} from '../core/models/types.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { buildResumeReportConsumerKey } from '../core/workflow/run/resume-report-consumer.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import {
  buildDynamicSelectorInstruction,
  resolveSelectorReportNames,
} from '../core/workflow/dynamic-parallel/selector-input.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const SELECTION_HISTORY_SENTINEL = 'prior-selection-history-sentinel';

const pool: DynamicParallelPoolSubStep[] = [
  {
    name: 'frontend',
    description: 'Review React and UI changes',
    personaDisplayName: 'frontend',
    instruction: 'Review frontend',
    rules: [{ condition: 'approved' }],
  },
  {
    name: 'backend',
    description: 'Review API and persistence changes',
    personaDisplayName: 'backend',
    instruction: 'Review backend',
    rules: [{ condition: 'approved' }],
  },
];

const previousSnapshot: DynamicParallelSelectionSnapshot = {
  identity: 'workflow:reviewers',
  step_name: 'reviewers',
  round: 1,
  selected_pool_ids: [SELECTION_HISTORY_SENTINEL],
  effective_selection_ids: ['architecture', 'frontend'],
};

describe('buildDynamicSelectorInstruction', () => {
  it('should include references and only pool candidates', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Implement checkout UI',
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: ['architecture-review.md'],
      changedPaths: ['ui.tsx'],
      pool,
      selection: { mode: 'replace' },
    });

    expect(instruction).toContain('Implement checkout UI');
    expect(instruction).toContain('Report Directory:\n/project/.takt/runs/run/reports');
    expect(instruction).toContain('- architecture-review.md');
    expect(instruction).toContain('Changed file paths:\n- ui.tsx');
    expect(instruction).not.toContain('architecture report');
    expect(instruction).not.toContain('diff --git');
    expect(instruction).toContain('frontend: Review React and UI changes');
    expect(instruction).toContain('backend: Review API and persistence changes');
  });

  it('should include fresh required values without selection history on replace re-entry', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Fix API validation',
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: ['latest-backend.md'],
      changedPaths: ['api.ts'],
      pool,
      selection: { mode: 'replace' },
      previousSnapshot,
    });

    expect(instruction).toContain('Fix API validation');
    expect(instruction).toContain('- latest-backend.md');
    expect(instruction).toContain('Changed file paths:\n- api.ts');
    expect(instruction).not.toContain(SELECTION_HISTORY_SENTINEL);
  });

  it('should include previous pool IDs and every required value on cumulative re-entry', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Re-review checkout',
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: ['frontend-review.md'],
      changedPaths: ['server.ts'],
      pool,
      selection: { mode: 'cumulative' },
      previousSnapshot,
    });

    expect(instruction).toContain('Re-review checkout');
    expect(instruction).toContain('- frontend-review.md');
    expect(instruction).toContain('Changed file paths:\n- server.ts');
    expect(instruction).toContain(SELECTION_HISTORY_SENTINEL);
    expect(instruction).toContain('backend: Review API and persistence changes');
  });
});

describe('resolveSelectorReportNames', () => {
  it('should resolve a missing child report from the parent workflow scope', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-parent-report-'));
    temporaryDirectories.push(cwd);
    const reportsRootDirectory = buildRunPaths(cwd, 'run-1').reportsRootAbs;
    const reportDirectory = join(reportsRootDirectory, 'subworkflows', 'child');
    mkdirSync(reportDirectory, { recursive: true });
    const parentReport = join(reportsRootDirectory, 'review-resolution.md');
    writeFileSync(parentReport, 'parent report');

    expect(resolveSelectorReportNames({
      reportDirectory,
      reportsRootDirectory,
      reportNames: ['review-resolution.md'],
      stepName: 'child-review',
      workflowReference: 'child-workflow',
      workflowCallPath: [],
    })).toEqual([parentReport]);
  });

  it('should resolve a resumed report through the exact consumer snapshot mapping', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-resume-report-'));
    temporaryDirectories.push(cwd);
    const sourceReportsRoot = buildRunPaths(cwd, 'source-run').reportsRootAbs;
    const snapshotReport = join(
      sourceReportsRoot,
      'subworkflows',
      'old-peer',
      'review-resolution.md',
    );
    mkdirSync(join(sourceReportsRoot, 'subworkflows', 'old-peer'), { recursive: true });
    writeFileSync(snapshotReport, 'resumed report');
    const consumerKey = buildResumeReportConsumerKey('review-gate', 'final-gate', []);
    inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
      resumeReportConsumers: [{
        consumerKey,
        reportDirectories: ['subworkflows/old-peer'],
        references: [{
          reference: 'review-resolution.md',
          path: 'subworkflows/old-peer/review-resolution.md',
        }],
      }],
    });
    const reportsRootDirectory = buildRunPaths(cwd, 'target-run').reportsRootAbs;
    const reportDirectory = join(reportsRootDirectory, 'subworkflows', 'new-peer');
    mkdirSync(reportDirectory, { recursive: true });

    expect(resolveSelectorReportNames({
      reportDirectory,
      reportsRootDirectory,
      reportNames: ['review-resolution.md'],
      stepName: 'final-gate',
      workflowReference: 'review-gate',
      workflowCallPath: [],
    })).toEqual([join(
      reportsRootDirectory,
      'subworkflows',
      'old-peer',
      'review-resolution.md',
    )]);
  });
});
