/**
 * Run session reader for interactive mode
 *
 * Scans .takt/runs/ for recent runs, loads NDJSON logs and reports,
 * and formats them for injection into the interactive system prompt.
 */

import { Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readRunContextOrderContent } from '../../core/workflow/run/order-content.js';
import { readRunMetaBySlug } from '../../core/workflow/run/run-meta.js';
import {
  PROVIDER_EVENTS_LOG_FILE_SUFFIX,
  USAGE_EVENTS_LOG_FILE_SUFFIX,
} from '../../core/logging/contracts.js';
import { loadNdjsonLog } from '../../infra/fs/index.js';
import type { SessionLog } from '../../shared/utils/index.js';

/** Maximum number of runs to return from listing */
const MAX_RUNS = 10;

/** Maximum character length for step log content */
const MAX_CONTENT_LENGTH = 500;

/** Summary of a run for selection UI */
export interface RunSummary {
  readonly slug: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly startTime: string;
}

/** A single step log entry for display */
type SessionHistoryEntry = SessionLog['history'][number];

interface StepLogEntry {
  readonly step: string;
  readonly persona: string;
  readonly status: string;
  readonly content: string;
  readonly workflow?: SessionHistoryEntry['workflow'];
  readonly stack?: SessionHistoryEntry['stack'];
}

/** A report file entry */
interface ReportEntry {
  readonly filename: string;
  readonly content: string;
}

/** Full context loaded from a run for prompt injection */
export interface RunSessionContext {
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly stepLogs: readonly StepLogEntry[];
  readonly reports: readonly ReportEntry[];
}

/** Absolute paths to a run's logs and reports directories */
export interface RunPaths {
  readonly logsDir: string;
  readonly reportsDir: string;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '…';
}

function buildStepLogs(sessionLog: SessionLog): StepLogEntry[] {
  return sessionLog.history.map((entry) => ({
    step: entry.step,
    persona: entry.persona,
    status: entry.status,
    content: truncateContent(entry.content, MAX_CONTENT_LENGTH),
    workflow: entry.workflow,
    stack: entry.stack,
  }));
}

function formatStepScopeEntry(
  entry: NonNullable<StepLogEntry['stack']>[number],
): string {
  const kindSuffix = entry.kind === 'workflow_call' ? ' [workflow_call]' : '';
  return `${entry.workflow}/${entry.step}${kindSuffix}`;
}

function formatStepScope(log: StepLogEntry): string {
  if (log.stack && log.stack.length > 0) {
    return log.stack.map((entry) => formatStepScopeEntry(entry)).join(' -> ');
  }

  if (log.workflow) {
    return `${log.workflow}/${log.step}`;
  }

  return log.step;
}

function collectReportFiles(rootDir: string, currentDir: string): ReportEntry[] {
  const entries = readdirSync(currentDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  const reports: ReportEntry[] = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      reports.push(...collectReportFiles(rootDir, fullPath));
      continue;
    }

    if (!isMarkdownReport(entry)) {
      continue;
    }

    reports.push({
      filename: relative(rootDir, fullPath),
      content: readFileSync(fullPath, 'utf-8'),
    });
  }

  return reports;
}

function isMarkdownReport(entry: Dirent): boolean {
  return entry.isFile() && entry.name.endsWith('.md');
}

function loadReports(reportsDir: string): ReportEntry[] {
  if (!existsSync(reportsDir)) {
    return [];
  }

  return collectReportFiles(reportsDir, reportsDir);
}

function findSessionLogFile(logsDir: string): string | null {
  if (!existsSync(logsDir)) {
    return null;
  }

  const files = readdirSync(logsDir).filter(
    (f) => (
      f.endsWith('.jsonl')
      && !f.endsWith(PROVIDER_EVENTS_LOG_FILE_SUFFIX)
      && !f.endsWith(USAGE_EVENTS_LOG_FILE_SUFFIX)
    ),
  );

  const first = files[0];
  if (!first) {
    return null;
  }

  return join(logsDir, first);
}

/**
 * List recent runs sorted by startTime descending.
 */
export function listRecentRuns(cwd: string): RunSummary[] {
  const runsDir = join(cwd, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return [];
  }

  const entries = readdirSync(runsDir, { withFileTypes: true });
  const summaries: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const meta = readRunMetaBySlug(cwd, entry.name);
    if (!meta) continue;

    summaries.push({
      slug: entry.name,
      task: meta.task,
      workflow: meta.workflow,
      status: meta.status,
      startTime: meta.startTime,
    });
  }

  summaries.sort((a, b) => b.startTime.localeCompare(a.startTime));
  return summaries.slice(0, MAX_RUNS);
}

/**
 * Find the most recent run matching the given task content.
 *
 * @returns The run slug if found, null otherwise.
 */
export function findRunForTask(cwd: string, taskContent: string): string | null {
  const runs = listRecentRuns(cwd);
  const match = runs.find((r) => r.task === taskContent);
  return match?.slug ?? null;
}

/**
 * Get absolute paths to a run's logs and reports directories.
 */
export function getRunPaths(cwd: string, slug: string): RunPaths {
  const meta = readRunMetaBySlug(cwd, slug);
  if (!meta) {
    throw new Error(`Run not found: ${slug}`);
  }

  return {
    logsDir: join(cwd, meta.logsDirectory),
    reportsDir: join(cwd, meta.reportDirectory),
  };
}

/**
 * Load full run session context for prompt injection.
 */
export function loadRunSessionContext(cwd: string, slug: string): RunSessionContext {
  const meta = readRunMetaBySlug(cwd, slug);
  if (!meta) {
    throw new Error(`Run not found: ${slug}`);
  }

  const logsDir = join(cwd, meta.logsDirectory);
  const logFile = findSessionLogFile(logsDir);

  let stepLogs: StepLogEntry[] = [];
  if (logFile) {
    const sessionLog = loadNdjsonLog(logFile);
    if (sessionLog) {
      stepLogs = buildStepLogs(sessionLog);
    }
  }

  const reportsDir = join(cwd, meta.reportDirectory);
  const reports = loadReports(reportsDir);

  return {
    task: meta.task,
    workflow: meta.workflow,
    status: meta.status,
    stepLogs,
    reports,
  };
}

/**
 * Load the previous order.md content from the run directory.
 *
 * Uses findRunForTask to locate the matching run by task content,
 * then reads order.md from its context/task directory.
 *
 * @returns The order.md content if found, null otherwise.
 */
export function loadPreviousOrderContent(cwd: string, taskContent: string): string | null {
  const slug = findRunForTask(cwd, taskContent);
  if (!slug) {
    return null;
  }

  return readRunContextOrderContent(cwd, slug) ?? null;
}

/**
 * Format run session context into a text block for the system prompt.
 */
export function formatRunSessionForPrompt(ctx: RunSessionContext): {
  runTask: string;
  runWorkflow: string;
  runStatus: string;
  runStepLogs: string;
  runReports: string;
} {
  const logLines = ctx.stepLogs.map((log) => {
    const header = `### ${formatStepScope(log)} (${log.persona}) — ${log.status}`;
    return `${header}\n${log.content}`;
  });

  const reportLines = ctx.reports.map((report) => {
    return `### ${report.filename}\n${report.content}`;
  });

  return {
    runTask: ctx.task,
    runWorkflow: ctx.workflow,
    runStatus: ctx.status,
    runStepLogs: logLines.join('\n\n'),
    runReports: reportLines.join('\n\n'),
  };
}
