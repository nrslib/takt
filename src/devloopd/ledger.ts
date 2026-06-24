import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readRunMetaBySlug, type RunMeta } from '../core/workflow/run/run-meta.js';
import { listRecentRuns } from '../features/interactive/runSessionReader.js';
import { isPathInside } from '../shared/utils/pathBoundary.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export interface ImportTaktRunOptions {
  repoPath?: string;
  issue?: number;
  runSlug?: string;
  latest?: boolean;
  ledgerPath?: string;
}

export interface DevloopArtifactRecord {
  kind: 'log' | 'report';
  path: string;
  sha256: string;
  bytes: number;
}

export interface TaktRunImportedEvent {
  version: 1;
  eventId: string;
  eventType: 'takt_run_imported';
  timestamp: string;
  repoPath: string;
  issueNumber?: number;
  runSlug: string;
  taktRunPath: string;
  status: RunMeta['status'];
  task: string;
  workflow: string;
  startTime: string;
  endTime?: string;
  artifacts: DevloopArtifactRecord[];
}

export interface ImportTaktRunReport {
  passed: boolean;
  message: string;
  runSlug?: string;
  event?: TaktRunImportedEvent;
  ledgerPath: string;
}

export interface TimelineOptions {
  repoPath?: string;
  issue?: number;
  runSlug?: string;
  ledgerPath?: string;
}

export interface TimelineReport {
  passed: boolean;
  message: string;
  events: TaktRunImportedEvent[];
  ledgerPath: string;
}

export interface ReconcileTaktRunsOptions {
  repoPath?: string;
  ledgerPath?: string;
  issue?: number;
}

export interface ReconcileSkippedRun {
  runSlug: string;
  reason: 'already imported' | 'run is still running' | 'run metadata unreadable';
}

export interface ReconcileTaktRunsReport {
  passed: boolean;
  message: string;
  imported: ImportTaktRunReport[];
  skipped: ReconcileSkippedRun[];
  ledgerPath: string;
}

export interface ExportDevloopLedgerOptions {
  repoPath?: string;
  ledgerPath?: string;
  issue?: number;
  runSlug?: string;
  outputPath: string;
  force?: boolean;
}

export interface ExportDevloopLedgerReport {
  passed: boolean;
  message: string;
  events: TaktRunImportedEvent[];
  ledgerPath: string;
  outputPath: string;
  bytes: number;
}

export const DEFAULT_DEVLOOP_LEDGER_RELATIVE_PATH = join('.devloop', 'ledger.jsonl');

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
}

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

export function resolveDevloopLedgerPath(repoPath: string, ledgerPath: string | undefined): string {
  return ledgerPath ? resolve(repoPath, ledgerPath) : join(repoPath, DEFAULT_DEVLOOP_LEDGER_RELATIVE_PATH);
}

function resolveLedgerExportPath(repoPath: string, outputPath: string): { outputPath: string } | { error: string } {
  if (outputPath.trim().length === 0) {
    return { error: 'Output path is required' };
  }

  const repoRoot = resolve(repoPath);
  const resolvedOutputPath = isAbsolute(outputPath) ? resolve(outputPath) : resolve(repoRoot, outputPath);
  if (!isAbsolute(outputPath) && !isPathInside(repoRoot, resolvedOutputPath)) {
    return { error: 'Relative export path must stay inside the repository. Use an absolute path for external backups.' };
  }

  return { outputPath: resolvedOutputPath };
}

function selectRunSlug(repoPath: string, options: ImportTaktRunOptions): string | undefined {
  if (options.runSlug) {
    return options.runSlug;
  }

  if (options.latest === true || !options.runSlug) {
    return listRecentRuns(repoPath)[0]?.slug;
  }

  return undefined;
}

function readRequiredRunMeta(repoPath: string, runSlug: string): RunMeta | undefined {
  return readRunMetaBySlug(repoPath, runSlug) ?? undefined;
}

function listRunSlugs(repoPath: string): string[] {
  const runsDir = resolve(repoPath, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return [];
  }

  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => {
      // Preserve TAKT execution order so ledger replay stays stable across daemon restarts.
      const leftMeta = readRunMetaBySlug(repoPath, left);
      const rightMeta = readRunMetaBySlug(repoPath, right);
      return (leftMeta?.startTime ?? left).localeCompare(rightMeta?.startTime ?? right);
    });
}

function sha256File(filePath: string): { sha256: string; bytes: number } {
  const content = readFileSync(filePath);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  };
}

function collectFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

function collectArtifacts(
  repoPath: string,
  meta: RunMeta,
): DevloopArtifactRecord[] {
  const repoRoot = resolve(repoPath);
  const artifactInputs = [
    { kind: 'log' as const, dir: resolve(repoPath, meta.logsDirectory) },
    { kind: 'report' as const, dir: resolve(repoPath, meta.reportDirectory) },
  ];
  const artifacts: DevloopArtifactRecord[] = [];

  for (const input of artifactInputs) {
    if (!isPathInside(repoRoot, input.dir)) {
      continue;
    }
    for (const filePath of collectFiles(input.dir)) {
      if (!isPathInside(repoRoot, filePath)) {
        continue;
      }
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const digest = sha256File(filePath);
      artifacts.push({
        kind: input.kind,
        path: relative(repoRoot, filePath),
        sha256: digest.sha256,
        bytes: digest.bytes,
      });
    }
  }

  return artifacts;
}

function buildImportEvent(
  repoPath: string,
  issue: number | undefined,
  runSlug: string,
  meta: RunMeta,
): TaktRunImportedEvent {
  return {
    version: 1,
    eventId: `evt_${randomUUID()}`,
    eventType: 'takt_run_imported',
    timestamp: new Date().toISOString(),
    repoPath,
    ...(issue !== undefined ? { issueNumber: issue } : {}),
    runSlug,
    taktRunPath: relative(repoPath, resolve(repoPath, meta.runRoot)),
    status: meta.status,
    task: sanitizeDetail(meta.task),
    workflow: meta.workflow,
    startTime: meta.startTime,
    ...(meta.endTime !== undefined ? { endTime: meta.endTime } : {}),
    artifacts: collectArtifacts(repoPath, meta),
  };
}

function appendLedgerEvent(ledgerPath: string, event: TaktRunImportedEvent): void {
  mkdirSync(resolve(ledgerPath, '..'), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  writeFileSync(ledgerPath, line, { encoding: 'utf-8', flag: 'a' });
}

export function readDevloopLedgerEvents(ledgerPath: string): TaktRunImportedEvent[] {
  if (!existsSync(ledgerPath)) {
    return [];
  }

  return readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as TaktRunImportedEvent;
        return event.eventType === 'takt_run_imported' ? [event] : [];
      } catch {
        return [];
      }
    });
}

export function importTaktRun(options: ImportTaktRunOptions): ImportTaktRunReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const runSlug = selectRunSlug(repoPath, options);
  if (!runSlug) {
    return { passed: false, message: 'No TAKT runs found', ledgerPath };
  }

  const meta = readRequiredRunMeta(repoPath, runSlug);
  if (!meta) {
    return { passed: false, message: `TAKT run not found or unreadable: ${runSlug}`, runSlug, ledgerPath };
  }

  const event = buildImportEvent(repoPath, options.issue, runSlug, meta);
  appendLedgerEvent(ledgerPath, event);
  return {
    passed: true,
    message: `Imported TAKT run ${runSlug}`,
    runSlug,
    event,
    ledgerPath,
  };
}

export function renderTimeline(options: TimelineOptions): TimelineReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const events = readDevloopLedgerEvents(ledgerPath)
    .filter((event) => options.issue === undefined || event.issueNumber === options.issue)
    .filter((event) => options.runSlug === undefined || event.runSlug === options.runSlug)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  return {
    passed: events.length > 0,
    message: events.length > 0 ? `Found ${events.length} imported TAKT run(s)` : 'No imported TAKT runs found',
    events,
    ledgerPath,
  };
}

export function reconcileTaktRuns(options: ReconcileTaktRunsOptions = {}): ReconcileTaktRunsReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const importedRunSlugs = new Set(readDevloopLedgerEvents(ledgerPath).map((event) => event.runSlug));
  const imported: ImportTaktRunReport[] = [];
  const skipped: ReconcileSkippedRun[] = [];

  for (const runSlug of listRunSlugs(repoPath)) {
    if (importedRunSlugs.has(runSlug)) {
      skipped.push({ runSlug, reason: 'already imported' });
      continue;
    }

    const meta = readRequiredRunMeta(repoPath, runSlug);
    if (!meta) {
      skipped.push({ runSlug, reason: 'run metadata unreadable' });
      continue;
    }
    if (meta.status === 'running') {
      skipped.push({ runSlug, reason: 'run is still running' });
      continue;
    }

    const report = importTaktRun({
      repoPath,
      runSlug,
      issue: options.issue,
      ledgerPath: options.ledgerPath,
    });
    imported.push(report);
    if (report.passed) {
      importedRunSlugs.add(runSlug);
    }
  }

  const failedImports = imported.filter((report) => !report.passed);
  return {
    passed: failedImports.length === 0,
    message: failedImports.length === 0
      ? `Reconciled ${imported.length} TAKT run(s)`
      : `Failed to reconcile ${failedImports.length} TAKT run(s)`,
    imported,
    skipped,
    ledgerPath,
  };
}

export function exportDevloopLedger(options: ExportDevloopLedgerOptions): ExportDevloopLedgerReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const resolvedOutput = resolveLedgerExportPath(repoPath, options.outputPath);
  if ('error' in resolvedOutput) {
    return {
      passed: false,
      message: resolvedOutput.error,
      events: [],
      ledgerPath,
      outputPath: options.outputPath,
      bytes: 0,
    };
  }

  if (existsSync(resolvedOutput.outputPath) && options.force !== true) {
    return {
      passed: false,
      message: `Output already exists: ${resolvedOutput.outputPath}. Pass --force to overwrite it.`,
      events: [],
      ledgerPath,
      outputPath: resolvedOutput.outputPath,
      bytes: 0,
    };
  }

  const events = readDevloopLedgerEvents(ledgerPath)
    // Keep append order so exported JSONL can be replayed as the same audit ledger.
    .filter((event) => options.issue === undefined || event.issueNumber === options.issue)
    .filter((event) => options.runSlug === undefined || event.runSlug === options.runSlug);
  const content = events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');
  mkdirSync(resolve(resolvedOutput.outputPath, '..'), { recursive: true });
  writeFileSync(resolvedOutput.outputPath, content, { encoding: 'utf-8', flag: 'w' });

  return {
    passed: true,
    message: `Exported ${events.length} ledger event(s)`,
    events,
    ledgerPath,
    outputPath: resolvedOutput.outputPath,
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

export function formatImportTaktRunReport(report: ImportTaktRunReport): string {
  const lines = [
    report.passed ? 'devloopd import-takt-run passed' : 'devloopd import-takt-run failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
  ];
  if (report.event) {
    lines.push(`Artifacts: ${report.event.artifacts.length}`);
  }
  return lines.join('\n');
}

function formatIssue(event: TaktRunImportedEvent): string {
  return event.issueNumber !== undefined ? `#${event.issueNumber}` : '#unknown';
}

export function formatTimelineReport(report: TimelineReport): string {
  const lines = [
    report.passed ? 'devloopd timeline' : 'devloopd timeline empty',
    report.message,
  ];

  for (const event of report.events) {
    lines.push(
      `[${event.startTime}] ${formatIssue(event)} ${event.runSlug} ${event.status} ${event.workflow} - ${event.task}`,
    );
    for (const artifact of event.artifacts.filter((item) => item.kind === 'report')) {
      lines.push(`  report: ${artifact.path} (${basename(artifact.path)}, ${artifact.bytes} bytes)`);
    }
  }

  return lines.join('\n');
}

export function formatReconcileTaktRunsReport(report: ReconcileTaktRunsReport): string {
  const lines = [
    report.passed ? 'devloopd reconcile-runs passed' : 'devloopd reconcile-runs failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
  ];

  if (report.imported.length > 0) {
    lines.push('Imported:');
    lines.push(...report.imported.map((item) => `- ${item.runSlug ?? 'unknown'}: ${item.message}`));
  }
  if (report.skipped.length > 0) {
    lines.push('Skipped:');
    lines.push(...report.skipped.map((item) => `- ${item.runSlug}: ${item.reason}`));
  }

  return lines.join('\n');
}

export function formatExportDevloopLedgerReport(report: ExportDevloopLedgerReport): string {
  const lines = [
    report.passed ? 'devloopd export-ledger passed' : 'devloopd export-ledger failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
    `Output: ${report.outputPath}`,
  ];

  if (report.passed) {
    lines.push(`Events: ${report.events.length}`);
    lines.push(`Bytes: ${report.bytes}`);
  }

  return lines.join('\n');
}
