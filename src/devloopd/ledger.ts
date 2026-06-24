import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';
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
