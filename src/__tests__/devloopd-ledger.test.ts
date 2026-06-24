import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportDevloopLedger,
  formatExportDevloopLedgerReport,
  formatImportTaktRunReport,
  formatReconcileTaktRunsReport,
  formatTimelineReport,
  importTaktRun,
  reconcileTaktRuns,
  renderTimeline,
} from '../devloopd/ledger.js';

function writeRunFixture(
  repoPath: string,
  slug: string,
  overrides: {
    issue?: number;
    status?: string;
    startTime?: string;
    endTime?: string;
    task?: string;
    workflow?: string;
    reportName?: string;
    reportContent?: string;
  } = {},
): void {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'logs', 'session.jsonl'), [
    JSON.stringify({ type: 'workflow_start', ts: overrides.startTime ?? '2026-06-24T00:00:00.000Z' }),
    JSON.stringify({ type: 'workflow_complete', ts: overrides.endTime ?? '2026-06-24T00:10:00.000Z' }),
  ].join('\n'), 'utf-8');
  writeFileSync(
    join(runDir, 'reports', overrides.reportName ?? 'summary.md'),
    overrides.reportContent ?? '# Summary\nDone',
    'utf-8',
  );
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: overrides.task ?? `Issue #${overrides.issue ?? 123}`,
    workflow: overrides.workflow ?? 'subscription-devloop',
    status: overrides.status ?? 'completed',
    startTime: overrides.startTime ?? '2026-06-24T00:00:00.000Z',
    endTime: overrides.endTime ?? '2026-06-24T00:10:00.000Z',
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    runSlug: slug,
  }), 'utf-8');
}

describe('devloopd ledger import and timeline', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-devloopd-ledger-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('imports a TAKT run into the devloop ledger with artifact hashes', () => {
    writeRunFixture(repoPath, '20260624-issue-123', { issue: 123 });

    const report = importTaktRun({
      repoPath,
      issue: 123,
      runSlug: '20260624-issue-123',
    });

    expect(report.passed).toBe(true);
    expect(formatImportTaktRunReport(report)).toContain('20260624-issue-123');

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(1);
    const event = JSON.parse(ledger[0]!) as {
      eventType: string;
      issueNumber: number;
      artifacts: Array<{ kind: string; path: string; sha256: string }>;
    };
    expect(event.eventType).toBe('takt_run_imported');
    expect(event.issueNumber).toBe(123);
    expect(event.artifacts.some((artifact) => artifact.kind === 'report' && artifact.path.endsWith('summary.md'))).toBe(true);
    expect(event.artifacts.every((artifact) => artifact.sha256.length === 64)).toBe(true);
  });

  it('imports the latest run when no run slug is specified', () => {
    writeRunFixture(repoPath, 'old-run', { startTime: '2026-06-24T00:00:00.000Z' });
    writeRunFixture(repoPath, 'new-run', { startTime: '2026-06-24T01:00:00.000Z' });

    const report = importTaktRun({ repoPath, issue: 123, latest: true });

    expect(report.passed).toBe(true);
    expect(report.runSlug).toBe('new-run');
  });

  it('renders a timeline filtered by issue number', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123, task: 'Fix bug' });
    writeRunFixture(repoPath, 'run-456', { issue: 456, task: 'Other issue' });
    importTaktRun({ repoPath, issue: 123, runSlug: 'run-123' });
    importTaktRun({ repoPath, issue: 456, runSlug: 'run-456' });

    const timeline = renderTimeline({ repoPath, issue: 123 });
    const output = formatTimelineReport(timeline);

    expect(timeline.passed).toBe(true);
    expect(output).toContain('#123');
    expect(output).toContain('run-123');
    expect(output).toContain('Fix bug');
    expect(output).not.toContain('run-456');
  });

  it('fails cleanly when no TAKT run can be imported', () => {
    const report = importTaktRun({ repoPath, issue: 123, latest: true });

    expect(report.passed).toBe(false);
    expect(formatImportTaktRunReport(report)).toContain('No TAKT runs found');
  });

  it('reconciles missing non-running TAKT runs without duplicating imported runs', () => {
    writeRunFixture(repoPath, 'run-imported', { startTime: '2026-06-24T00:00:00.000Z' });
    writeRunFixture(repoPath, 'run-missing', { startTime: '2026-06-24T01:00:00.000Z' });
    writeRunFixture(repoPath, 'run-active', { status: 'running', startTime: '2026-06-24T02:00:00.000Z' });
    importTaktRun({ repoPath, runSlug: 'run-imported' });

    const report = reconcileTaktRuns({ repoPath });
    const output = formatReconcileTaktRunsReport(report);

    expect(report.passed).toBe(true);
    expect(report.imported.map((item) => item.runSlug)).toEqual(['run-missing']);
    expect(report.skipped).toEqual([
      { runSlug: 'run-imported', reason: 'already imported' },
      { runSlug: 'run-active', reason: 'run is still running' },
    ]);
    expect(output).toContain('run-missing');

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(2);
  });

  it('exports filtered ledger events without overwriting an existing backup by default', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123, task: 'Fix bug' });
    writeRunFixture(repoPath, 'run-456', { issue: 456, task: 'Other issue' });
    importTaktRun({ repoPath, issue: 123, runSlug: 'run-123' });
    importTaktRun({ repoPath, issue: 456, runSlug: 'run-456' });

    const outputPath = join('.devloop', 'backup', 'ledger-123.jsonl');
    const exportReport = exportDevloopLedger({ repoPath, issue: 123, outputPath });
    const output = formatExportDevloopLedgerReport(exportReport);

    expect(exportReport.passed).toBe(true);
    expect(exportReport.events).toHaveLength(1);
    expect(output).toContain('1 ledger event');

    const exportedLines = readFileSync(join(repoPath, outputPath), 'utf-8').trim().split('\n');
    expect(exportedLines).toHaveLength(1);
    expect(JSON.parse(exportedLines[0]!) as { runSlug: string }).toMatchObject({ runSlug: 'run-123' });

    const blockedReport = exportDevloopLedger({ repoPath, issue: 123, outputPath });
    expect(blockedReport.passed).toBe(false);
    expect(blockedReport.message).toContain('--force');

    const forcedReport = exportDevloopLedger({ repoPath, issue: 123, outputPath, force: true });
    expect(forcedReport.passed).toBe(true);

    const escapedReport = exportDevloopLedger({ repoPath, outputPath: '../outside-ledger.jsonl' });
    expect(escapedReport.passed).toBe(false);
    expect(escapedReport.message).toContain('inside the repository');
  });
});
