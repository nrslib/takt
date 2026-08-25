import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import {
  archiveLoopAnalysisReport,
  recordLoopAnalysisPullRequest,
} from '../features/tasks/execute/loopAnalysisArchive.js';

describe('loop analysis archive', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('Given a report exists, When it is archived, Then the complete report and source metadata are private and recoverable', () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-archive-'));
    temporaryDirectories.push(rootDirectory);
    const sourceRunDirectory = join(rootDirectory, '.takt', 'runs', 'source-run');
    const reportPath = join(rootDirectory, 'analysis', 'reports', 'loop-analysis.md');
    mkdirSync(sourceRunDirectory, { recursive: true });
    mkdirSync(join(rootDirectory, 'analysis', 'reports'), { recursive: true });
    const fullReport = 'Evidence: /Users/jane/private/report.md\nreports/subworkflows/**/plan.md\n';
    writeFileSync(reportPath, fullReport, { mode: 0o600 });

    const archive = archiveLoopAnalysisReport({
      sourceRunDirectory,
      projectCwd: rootDirectory,
      analysisReportPath: reportPath,
      branch: 'takt/source-run',
    });

    const archiveDirectory = join(getGlobalConfigDir(), 'loop-analysis', 'source-run');
    const archivedReportPath = join(archiveDirectory, 'loop-analysis.md');
    const sourceMetadataPath = join(archiveDirectory, 'source.json');
    expect(archive.sourceMetadataPath).toBe(sourceMetadataPath);
    expect(readFileSync(archivedReportPath, 'utf8')).toBe(fullReport);
    expect(JSON.parse(readFileSync(sourceMetadataPath, 'utf8'))).toEqual({
      version: 1,
      sourceRunDirectory,
      projectCwd: rootDirectory,
      branch: 'takt/source-run',
      analysisReportPath: reportPath,
      archivedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(JSON.parse(readFileSync(sourceMetadataPath, 'utf8')).archivedAt))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(archivedReportPath).mode & 0o777).toBe(0o600);
      expect(statSync(sourceMetadataPath).mode & 0o777).toBe(0o600);
    }

    recordLoopAnalysisPullRequest(archive, {
      number: 41,
      url: 'https://github.com/org/repo/pull/41',
    });

    expect(JSON.parse(readFileSync(sourceMetadataPath, 'utf8')).pullRequest).toEqual({
      number: 41,
      url: 'https://github.com/org/repo/pull/41',
    });
  });

  it('Given a slug is archived again, When the new run is saved, Then old pull request metadata is replaced', () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-archive-rerun-'));
    temporaryDirectories.push(rootDirectory);
    const sourceRunDirectory = join(rootDirectory, '.takt', 'runs', 'source-run-rerun');
    const reportPath = join(rootDirectory, 'analysis', 'reports', 'loop-analysis.md');
    mkdirSync(sourceRunDirectory, { recursive: true });
    mkdirSync(join(rootDirectory, 'analysis', 'reports'), { recursive: true });

    const firstReport = 'first report: /Users/jane/first.md\n';
    const secondReport = 'second report: /Users/jane/second.md\n';
    writeFileSync(reportPath, firstReport, { mode: 0o600 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const firstArchive = archiveLoopAnalysisReport({
      sourceRunDirectory,
      projectCwd: rootDirectory,
      analysisReportPath: reportPath,
      branch: 'takt/old-run',
    });
    recordLoopAnalysisPullRequest(firstArchive, {
      number: 41,
      url: 'https://github.com/org/repo/pull/41',
    });

    writeFileSync(reportPath, secondReport, { mode: 0o600 });
    vi.setSystemTime(new Date('2026-08-25T00:01:00.000Z'));
    const secondArchive = archiveLoopAnalysisReport({
      sourceRunDirectory,
      projectCwd: rootDirectory,
      analysisReportPath: reportPath,
      branch: 'takt/new-run',
    });

    const archiveDirectory = join(getGlobalConfigDir(), 'loop-analysis', 'source-run-rerun');
    const archivedReportPath = join(archiveDirectory, 'loop-analysis.md');
    const metadata = JSON.parse(
      readFileSync(secondArchive.sourceMetadataPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(readFileSync(archivedReportPath, 'utf8')).toBe(secondReport);
    expect(metadata).toMatchObject({
      version: 1,
      sourceRunDirectory,
      projectCwd: rootDirectory,
      branch: 'takt/new-run',
      analysisReportPath: reportPath,
      archivedAt: '2026-08-25T00:01:00.000Z',
    });
    expect(metadata).not.toHaveProperty('pullRequest');
  });
});
