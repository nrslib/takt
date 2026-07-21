import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { inheritReviewReports } from '../core/workflow/report-inheritance.js';
import { workflowCallNamespaceSegmentsMatch } from '../core/workflow/workflow-call-namespace.js';

const sourceRunSlug = '20260717-source-run';
const currentRunSlug = '20260717-current-run';
const reviewReportNames = ['05-arch-review.md', '06-security-review.md'] as const;
const temporaryDirectories: string[] = [];

function createProjectDirectory(): string {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'takt-report-inheritance-'));
  temporaryDirectories.push(projectDirectory);
  return projectDirectory;
}

function sourceReportPath(projectDirectory: string, namespace: string[], reportName: string): string {
  return join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports', ...namespace, reportName);
}

function targetReportDirectory(projectDirectory: string): string {
  return join(projectDirectory, '.takt', 'runs', currentRunSlug, 'reports', 'subworkflows', 'iteration-2--step-peer-review--workflow-peer-review');
}

function writeSourceReport(
  projectDirectory: string,
  namespace: string[],
  reportName: string,
  content: string,
  modifiedAt: Date,
): string {
  const reportPath = sourceReportPath(projectDirectory, namespace, reportName);
  mkdirSync(join(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, content, 'utf-8');
  utimesSync(reportPath, modifiedAt, modifiedAt);
  return reportPath;
}

function inherit(projectDirectory: string) {
  return inheritReviewReports({
    cwd: projectDirectory,
    sourceRunSlug,
    currentRunSlug,
    targetReportDirectory: targetReportDirectory(projectDirectory),
    reviewReportNames,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('inheritReviewReports', () => {
  it('should normalize iterations only for generated workflow-call namespaces', () => {
    expect(workflowCallNamespaceSegmentsMatch(
      'iteration-1--step-peer-review--workflow-reviewers',
      'iteration-2--step-peer-review--workflow-reviewers',
    )).toBe(true);
    expect(workflowCallNamespaceSegmentsMatch(
      'iteration-1--step-peer-review',
      'iteration-2--step-peer-review',
    )).toBe(false);
  });

  it('should copy the newest review report from a previous nested workflow into the current report directory', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    mkdirSync(join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports'), { recursive: true });
    const olderPath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'older review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    const latestPath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-2--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'latest review',
      new Date('2026-07-17T00:01:00.000Z'),
    );
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-2--step-peer-review--workflow-peer-review'],
      '05-arch-review.md.20260717T000200Z',
      'historical review',
      new Date('2026-07-17T00:02:00.000Z'),
    );
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-2--step-peer-review--workflow-peer-review'],
      'findings-ledger.json',
      '{"findings":[]}',
      new Date('2026-07-17T00:02:00.000Z'),
    );
    const securityPath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-2--step-peer-review--workflow-peer-review'],
      '06-security-review.md',
      'security review',
      new Date('2026-07-17T00:01:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    const copiedPath = join(targetReportDirectory(projectDirectory), '05-arch-review.md');
    expect(result.status).toBe('copied');
    expect(result.sourceRunSlug).toBe(sourceRunSlug);
    expect(result.sourceReportDirectory).toBe(join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports'));
    expect(result.copied).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', sourcePath: latestPath, targetPath: copiedPath }),
      expect.objectContaining({ reportName: '06-security-review.md', sourcePath: securityPath }),
    ]));
    expect(readFileSync(copiedPath, 'utf-8')).toBe('latest review');
    expect(readFileSync(olderPath, 'utf-8')).toBe('older review');
    expect(readFileSync(latestPath, 'utf-8')).toBe('latest review');
    expect(existsSync(join(targetReportDirectory(projectDirectory), 'findings-ledger.json'))).toBe(false);
  });

  it('should record partial status and retain available reports when another review report is missing', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'arch review',
      new Date('2026-07-17T00:00:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('partial');
    expect(result.copied).toEqual([
      expect.objectContaining({ reportName: '05-arch-review.md' }),
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reportName: '06-security-review.md', reason: 'not_found' }),
    ]);
    expect(readFileSync(join(targetReportDirectory(projectDirectory), '05-arch-review.md'), 'utf-8'))
      .toBe('arch review');
  });

  it('should leave the workflow runnable with unavailable diagnostics when the source run has no review reports', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    mkdirSync(join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports'), { recursive: true });

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.fallbackUsed).toBe(true);
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'not_found' }),
      expect.objectContaining({ reportName: '06-security-review.md', reason: 'not_found' }),
    ]));
  });

  it('should leave the workflow runnable with diagnostics when a source review report cannot be read', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const unreadablePath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'unreadable review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    chmodSync(unreadablePath, 0o000);

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.fallbackUsed).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'read_failed' }),
    ]));
  });

  it('should classify invalid UTF-8 source reports as invalid format without copying them', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const invalidReportPath = sourceReportPath(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
    );
    mkdirSync(join(invalidReportPath, '..'), { recursive: true });
    writeFileSync(invalidReportPath, Buffer.from([0xff, 0xfe]));

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.fallbackUsed).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'invalid_format' }),
    ]));
    expect(existsSync(join(targetReportDirectory(projectDirectory), '05-arch-review.md'))).toBe(false);
  });

  it('should reject symlinked and directory candidates without preventing valid sibling reports from being copied', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const namespace = ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'];
    const invalidDirectory = sourceReportPath(projectDirectory, namespace, '05-arch-review.md');
    mkdirSync(invalidDirectory, { recursive: true });
    const symlinkPath = sourceReportPath(projectDirectory, namespace, '06-security-review.md');
    symlinkSync(join(projectDirectory, 'outside-report.md'), symlinkPath);
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-2--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'valid arch review',
      new Date('2026-07-17T00:01:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('partial');
    expect(result.copied).toEqual([
      expect.objectContaining({ reportName: '05-arch-review.md' }),
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reportName: '06-security-review.md', reason: 'invalid_source' }),
    ]);
    expect(existsSync(join(targetReportDirectory(projectDirectory), '06-security-review.md'))).toBe(false);
  });

  it('should classify a directory-only report candidate as an invalid source', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    mkdirSync(sourceReportPath(projectDirectory, ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'], '05-arch-review.md'), { recursive: true });

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'invalid_source' }),
      expect.objectContaining({ reportName: '06-security-review.md', reason: 'not_found' }),
    ]));
  });

  it('should reject a source run symlink that resolves outside the runs directory', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'takt-report-inheritance-outside-'));
    temporaryDirectories.push(outsideDirectory);
    mkdirSync(join(outsideDirectory, 'reports'), { recursive: true });
    writeFileSync(join(outsideDirectory, 'reports', '05-arch-review.md'), 'outside review', 'utf-8');
    mkdirSync(join(projectDirectory, '.takt', 'runs'), { recursive: true });
    symlinkSync(outsideDirectory, join(projectDirectory, '.takt', 'runs', sourceRunSlug));

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'source_unavailable' }),
    ]));
  });

  it('should retain source-directory resolution failures in inheritance diagnostics', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const runsPath = join(projectDirectory, '.takt', 'runs');
    mkdirSync(runsPath, { recursive: true });
    symlinkSync('missing-source-run', join(runsPath, sourceRunSlug));

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: expect.stringMatching(/^source_resolution_failed:/),
      }),
    ]));
  });

  it('should not overwrite reports that already exist in the current run', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'source review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    const existingPath = join(targetReportDirectory(projectDirectory), '05-arch-review.md');
    mkdirSync(join(existingPath, '..'), { recursive: true });
    writeFileSync(existingPath, 'current run review', 'utf-8');

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('partial');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'target_exists' }),
    ]));
    expect(readFileSync(existingPath, 'utf-8')).toBe('current run review');
  });

  it('should make a copied read-only report writable for a later report update', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const sourcePath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'source review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    chmodSync(sourcePath, 0o444);

    // When
    const result = inherit(projectDirectory);
    const copiedPath = join(targetReportDirectory(projectDirectory), '05-arch-review.md');
    writeFileSync(copiedPath, 'updated current review', 'utf-8');

    // Then
    expect(result.status).toBe('partial');
    expect(statSync(copiedPath).mode & 0o200).toBe(0o200);
    expect(readFileSync(copiedPath, 'utf-8')).toBe('updated current review');
    expect(readFileSync(sourcePath, 'utf-8')).toBe('source review');
  });

  it('should match ordinary iteration-prefixed report names exactly', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const expectedSourcePath = writeSourceReport(
      projectDirectory,
      [],
      'iteration-2--review.md',
      'expected review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    writeSourceReport(
      projectDirectory,
      [],
      'iteration-1--review.md',
      'incorrect review',
      new Date('2026-07-17T00:01:00.000Z'),
    );
    const currentReportDirectory = join(projectDirectory, '.takt', 'runs', currentRunSlug, 'reports');

    // When
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: currentReportDirectory,
      reviewReportNames: ['iteration-2--review.md'],
    });

    // Then
    const copiedPath = join(currentReportDirectory, 'iteration-2--review.md');
    expect(result.copied).toEqual([
      expect.objectContaining({ sourcePath: expectedSourcePath, targetPath: copiedPath }),
    ]);
    expect(readFileSync(copiedPath, 'utf-8')).toBe('expected review');
  });

  it('should preserve safe relative report paths within the matching workflow namespace', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const sourcePath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      'reviews/architect-review.md',
      'architecture review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-other-review'],
      'reviews/architect-review.md',
      'unrelated review',
      new Date('2026-07-17T00:01:00.000Z'),
    );

    // When
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: targetReportDirectory(projectDirectory),
      reviewReportNames: ['reviews/architect-review.md'],
    });

    // Then
    const copiedPath = join(targetReportDirectory(projectDirectory), 'reviews', 'architect-review.md');
    expect(result.copied).toEqual([
      expect.objectContaining({ sourcePath, targetPath: copiedPath }),
    ]);
    expect(readFileSync(copiedPath, 'utf-8')).toBe('architecture review');
  });

  it('should retain only the report path below a nested target namespace when copying workflow-call reports', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const namespace = [
      'subworkflows',
      'iteration-1--step-final-gate--workflow-final-gate',
      'subworkflows',
      'iteration-1--step-reviewers--workflow-reviewers',
    ];
    const sourcePath = writeSourceReport(
      projectDirectory,
      namespace,
      'merge-readiness-review.md',
      'nested review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    const targetDirectory = join(
      projectDirectory,
      '.takt',
      'runs',
      currentRunSlug,
      'reports',
      'subworkflows',
      'iteration-2--step-final-gate--workflow-final-gate',
      'subworkflows',
      'iteration-2--step-reviewers--workflow-reviewers',
    );

    // When
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: targetDirectory,
      reviewReportNames: [
        'subworkflows/iteration-*--step-final-gate--workflow-final-gate/subworkflows/iteration-*--step-reviewers--workflow-reviewers/merge-readiness-review.md',
      ],
    });

    // Then
    const copiedPath = join(targetDirectory, 'merge-readiness-review.md');
    expect(result.copied).toEqual([
      expect.objectContaining({ sourcePath, targetPath: copiedPath }),
    ]);
    expect(readFileSync(copiedPath, 'utf-8')).toBe('nested review');
  });

  it('should normalize Windows report separators before matching and copying nested reports', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const reportName = win32.join('reviews', 'architect-review.md');
    const sourcePath = writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      'reviews/architect-review.md',
      'architecture review',
      new Date('2026-07-17T00:00:00.000Z'),
    );

    // When
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: targetReportDirectory(projectDirectory),
      reviewReportNames: [reportName],
    });

    // Then
    const copiedPath = join(targetReportDirectory(projectDirectory), 'reviews', 'architect-review.md');
    expect(result.copied).toEqual([
      expect.objectContaining({ reportName, sourcePath, targetPath: copiedPath }),
    ]);
    expect(readFileSync(copiedPath, 'utf-8')).toBe('architecture review');
  });

  it('should not write reports or diagnostics through a symlinked current report directory', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'source review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'takt-report-inheritance-target-outside-'));
    temporaryDirectories.push(outsideDirectory);
    const targetRoot = join(projectDirectory, '.takt', 'runs', currentRunSlug);
    mkdirSync(targetRoot, { recursive: true });
    symlinkSync(outsideDirectory, join(targetRoot, 'reports'));

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining('target_unavailable') }),
    ]));
    expect(existsSync(join(outsideDirectory, 'subworkflows', 'iteration-2--step-peer-review--workflow-peer-review', '05-arch-review.md'))).toBe(false);
  });

  it('should skip an oversized source report without reading or copying it', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const reportPath = sourceReportPath(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
    );
    mkdirSync(join(reportPath, '..'), { recursive: true });
    writeFileSync(reportPath, 'x'.repeat(1_048_577), 'utf-8');

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md', reason: 'source_too_large:1048576' }),
    ]));
  });

  it('should record a fallback when the source report scan exceeds its depth limit', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      Array.from({ length: 13 }, (_, index) => `nested-${index}`),
      '05-arch-review.md',
      'deep report',
      new Date('2026-07-17T00:00:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: 'scan_failed:report_scan_depth_exceeded:12',
      }),
    ]));
  });

  it('should allow a source report at the maximum scan depth', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      Array.from({ length: 12 }, (_, index) => `nested-${index}`),
      '05-arch-review.md',
      'boundary-depth report',
      new Date('2026-07-17T00:00:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'scan_failed:report_scan_depth_exceeded:12' }),
    ]));
  });

  it('should record a fallback when the source report scan exceeds its entry limit', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const sourceDirectory = join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports');
    mkdirSync(sourceDirectory, { recursive: true });
    for (let index = 0; index <= 1_024; index += 1) {
      writeFileSync(join(sourceDirectory, `unrelated-${index}.txt`), 'unused', 'utf-8');
    }

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: 'scan_failed:report_scan_entry_limit_exceeded:1024',
      }),
    ]));
  });

  it('should copy reports discovered before the source report scan reaches its entry limit', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    writeSourceReport(
      projectDirectory,
      [],
      '05-arch-review.md',
      'available review',
      new Date('2026-07-17T00:00:00.000Z'),
    );
    const sourceDirectory = join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports');
    for (let index = 0; index <= 1_024; index += 1) {
      writeFileSync(join(sourceDirectory, `unrelated-${index}.txt`), 'unused', 'utf-8');
    }

    // When
    const currentReportDirectory = join(projectDirectory, '.takt', 'runs', currentRunSlug, 'reports');
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: currentReportDirectory,
      reviewReportNames,
    });

    // Then
    expect(result.status).toBe('partial');
    expect(readFileSync(join(currentReportDirectory, '05-arch-review.md'), 'utf-8'))
      .toBe('available review');
    expect(result.copied).toEqual([
      expect.objectContaining({ reportName: '05-arch-review.md' }),
    ]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportName: '06-security-review.md',
        reason: 'scan_failed:report_scan_entry_limit_exceeded:1024',
      }),
    ]));
  });

  it('should allow exactly the maximum number of source report entries', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const sourceDirectory = join(projectDirectory, '.takt', 'runs', sourceRunSlug, 'reports');
    mkdirSync(sourceDirectory, { recursive: true });
    for (let index = 0; index < 1_021; index += 1) {
      writeFileSync(join(sourceDirectory, `unrelated-${index}.txt`), 'unused', 'utf-8');
    }
    writeSourceReport(
      projectDirectory,
      ['subworkflows', 'iteration-1--step-peer-review--workflow-peer-review'],
      '05-arch-review.md',
      'boundary-entry report',
      new Date('2026-07-17T00:00:00.000Z'),
    );

    // When
    const result = inherit(projectDirectory);

    // Then
    expect(result.copied).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '05-arch-review.md' }),
    ]));
    expect(result.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'scan_failed:report_scan_entry_limit_exceeded:1024' }),
    ]));
  });

  it('should record a fallback when the configured report name count exceeds its limit', () => {
    // Given
    const projectDirectory = createProjectDirectory();
    const reportNames = Array.from({ length: 1_025 }, (_, index) => `review-${index}.md`);

    // When
    const result = inheritReviewReports({
      cwd: projectDirectory,
      sourceRunSlug,
      currentRunSlug,
      targetReportDirectory: targetReportDirectory(projectDirectory),
      reviewReportNames: reportNames,
    });

    // Then
    expect(result.status).toBe('unavailable');
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportName: '*', reason: 'report_name_limit_exceeded:1024' }),
    ]));
  });
});
