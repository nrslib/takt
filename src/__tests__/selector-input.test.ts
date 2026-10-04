import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { buildResumeReportConsumerKey } from '../core/workflow/run/resume-report-consumer.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { resolveSelectorReportNames } from '../core/workflow/dynamic-parallel/selector-input.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

  it('should exclude unresolved report references', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-unresolved-report-'));
    temporaryDirectories.push(cwd);
    const reportsRootDirectory = buildRunPaths(cwd, 'run-1').reportsRootAbs;
    const reportDirectory = join(reportsRootDirectory, 'subworkflows', 'child');
    mkdirSync(reportDirectory, { recursive: true });

    expect(resolveSelectorReportNames({
      reportDirectory,
      reportsRootDirectory,
      reportNames: ['review-resolution.md'],
      stepName: 'child-review',
      workflowReference: 'child-workflow',
      workflowCallPath: [],
    })).toEqual([]);
  });
});
