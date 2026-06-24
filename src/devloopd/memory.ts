import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  readDevloopLedgerEvents,
  resolveDevloopLedgerPath,
  type TaktRunImportedEvent,
} from './ledger.js';
import { isPathInside } from '../shared/utils/pathBoundary.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export interface BuildDevloopMemoryOptions {
  repoPath?: string;
  ledgerPath?: string;
  outputPath?: string;
  issue?: number;
  limit?: number;
  write?: boolean;
}

export interface DevloopMemorySnapshot {
  generatedAt: string;
  repoPath: string;
  events: TaktRunImportedEvent[];
  content: string;
}

export interface DevloopMemoryReport {
  passed: boolean;
  message: string;
  ledgerPath: string;
  outputPath?: string;
  snapshot?: DevloopMemorySnapshot;
}

const DEFAULT_MEMORY_RELATIVE_PATH = join('.devloop', 'memory.md');

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

function resolveMemoryPath(repoPath: string, outputPath: string | undefined): string {
  return outputPath ? resolve(repoPath, outputPath) : join(repoPath, DEFAULT_MEMORY_RELATIVE_PATH);
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1) return undefined;
  return limit;
}

function sanitizeMemoryText(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function statusCounts(events: readonly TaktRunImportedEvent[]): Map<TaktRunImportedEvent['status'], number> {
  const counts = new Map<TaktRunImportedEvent['status'], number>();
  for (const event of events) {
    counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
  }
  return counts;
}

function workflowCounts(events: readonly TaktRunImportedEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.workflow, (counts.get(event.workflow) ?? 0) + 1);
  }
  return counts;
}

function formatIssue(event: TaktRunImportedEvent): string {
  return event.issueNumber === undefined ? '#unknown' : `#${event.issueNumber}`;
}

function formatCounts<T extends string>(counts: Map<T, number>, fallback: string): string[] {
  if (counts.size === 0) return [`- ${fallback}: 0`];
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, count]) => `- ${key}: ${count}`);
}

function formatReportArtifacts(event: TaktRunImportedEvent): string[] {
  const reports = event.artifacts.filter((artifact) => artifact.kind === 'report');
  if (reports.length === 0) {
    return ['  - report: none'];
  }
  return reports.map((artifact) =>
    `  - report: ${sanitizeMemoryText(artifact.path)} (${basename(artifact.path)}, ${artifact.bytes} bytes)`,
  );
}

function renderMemoryContent(input: {
  generatedAt: string;
  repoPath: string;
  events: readonly TaktRunImportedEvent[];
}): string {
  const lines = [
    '# devloopd Memory',
    '',
    `Generated: ${input.generatedAt}`,
    `Repository: ${input.repoPath}`,
    '',
    '## Status Counts',
    ...formatCounts(statusCounts(input.events), 'runs'),
    '',
    '## Workflow Counts',
    ...formatCounts(workflowCounts(input.events), 'workflows'),
    '',
    '## Recent Runs',
  ];

  for (const event of input.events) {
    lines.push(
      `- ${formatIssue(event)} ${sanitizeMemoryText(event.runSlug)} ${event.status} ${sanitizeMemoryText(event.workflow)} - ${sanitizeMemoryText(event.task)}`,
      `  - started: ${event.startTime}`,
    );
    if (event.endTime !== undefined) {
      lines.push(`  - ended: ${event.endTime}`);
    }
    lines.push(...formatReportArtifacts(event));
  }

  return `${lines.join('\n')}\n`;
}

function selectEvents(
  events: readonly TaktRunImportedEvent[],
  issue: number | undefined,
  limit: number,
): TaktRunImportedEvent[] {
  return events
    .filter((event) => issue === undefined || event.issueNumber === issue)
    .sort((left, right) => right.startTime.localeCompare(left.startTime))
    .slice(0, limit);
}

function writeMemory(repoPath: string, outputPath: string, content: string): void {
  const resolvedRepoPath = resolve(repoPath);
  const resolvedOutputPath = resolve(outputPath);
  if (!isPathInside(resolvedRepoPath, resolvedOutputPath)) {
    throw new Error('memory output path must stay inside the repository');
  }

  const parent = resolve(resolvedOutputPath, '..');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realRepoPath = realpathSync(resolvedRepoPath);
  const realParent = realpathSync(parent);
  if (!isPathInside(realRepoPath, realParent)) {
    throw new Error('memory output path must stay inside the repository');
  }
  if (existsSync(resolvedOutputPath)) {
    if (lstatSync(resolvedOutputPath).isSymbolicLink()) {
      throw new Error('memory output path must not be a symbolic link');
    }
    if (!isPathInside(realRepoPath, realpathSync(resolvedOutputPath))) {
      throw new Error('memory output path must stay inside the repository');
    }
  }
  chmodSync(parent, 0o700);
  // Project memory can include issue titles and run metadata, so keep it readable only by the local owner.
  writeFileSync(resolvedOutputPath, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(resolvedOutputPath, 0o600);
}

export function buildDevloopMemory(options: BuildDevloopMemoryOptions = {}): DevloopMemoryReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const limit = normalizeLimit(options.limit);
  if (limit === undefined) {
    return {
      passed: false,
      message: `limit must be a positive integer: ${String(options.limit)}`,
      ledgerPath,
    };
  }

  const events = selectEvents(readDevloopLedgerEvents(ledgerPath), options.issue, limit);
  if (events.length === 0) {
    return {
      passed: false,
      message: 'No imported TAKT runs found',
      ledgerPath,
    };
  }

  const generatedAt = new Date().toISOString();
  const content = renderMemoryContent({ generatedAt, repoPath, events });
  const snapshot: DevloopMemorySnapshot = {
    generatedAt,
    repoPath,
    events,
    content,
  };

  if (options.write === true) {
    const outputPath = resolveMemoryPath(repoPath, options.outputPath);
    try {
      writeMemory(repoPath, outputPath, content);
      return {
        passed: true,
        message: `Wrote devloop memory for ${events.length} run(s)`,
        ledgerPath,
        outputPath,
        snapshot,
      };
    } catch (error) {
      return {
        passed: false,
        message: error instanceof Error ? error.message : String(error),
        ledgerPath,
        outputPath,
      };
    }
  }

  return {
    passed: true,
    message: `Rendered devloop memory for ${events.length} run(s)`,
    ledgerPath,
    snapshot,
  };
}

export function formatDevloopMemoryReport(report: DevloopMemoryReport): string {
  const lines = [
    report.passed ? 'devloopd memory passed' : 'devloopd memory failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
  ];

  if (report.outputPath !== undefined) {
    lines.push(`Memory: ${report.outputPath}`);
  }
  if (report.snapshot !== undefined) {
    lines.push('', report.snapshot.content.trimEnd());
  }

  return lines.join('\n');
}
