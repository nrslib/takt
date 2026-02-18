/**
 * Run session reader for interactive mode
 *
 * Scans .takt/runs/ for recent runs, loads NDJSON logs and reports,
 * and formats them for injection into the interactive system prompt.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadNdjsonLog } from '../../infra/fs/index.js';
import type { SessionLog } from '../../shared/utils/index.js';

/** Maximum number of runs to return from listing */
const MAX_RUNS = 10;

/** Maximum character length for movement log content */
const MAX_CONTENT_LENGTH = 500;

/** Summary of a run for selection UI */
export interface RunSummary {
  readonly slug: string;
  readonly task: string;
  readonly piece: string;
  readonly status: string;
  readonly startTime: string;
}

/** A single movement log entry for display */
interface MovementLogEntry {
  readonly step: string;
  readonly persona: string;
  readonly status: string;
  readonly content: string;
}

/** A report file entry */
interface ReportEntry {
  readonly filename: string;
  readonly content: string;
}

/** Full context loaded from a run for prompt injection */
export interface RunSessionContext {
  readonly task: string;
  readonly piece: string;
  readonly status: string;
  readonly movementLogs: readonly MovementLogEntry[];
  readonly reports: readonly ReportEntry[];
}

/** Absolute paths to a run's logs and reports directories */
export interface RunPaths {
  readonly logsDir: string;
  readonly reportsDir: string;
}

interface MetaJson {
  readonly task: string;
  readonly piece: string;
  readonly status: string;
  readonly startTime: string;
  readonly logsDirectory: string;
  readonly reportDirectory: string;
  readonly runSlug: string;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '…';
}

function parseMetaJson(metaPath: string): MetaJson | null {
  if (!existsSync(metaPath)) {
    return null;
  }
  const raw = readFileSync(metaPath, 'utf-8').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as MetaJson;
  } catch {
    return null;
  }
}

function buildMovementLogs(sessionLog: SessionLog): MovementLogEntry[] {
  return sessionLog.history.map((entry) => ({
    step: entry.step,
    persona: entry.persona,
    status: entry.status,
    content: truncateContent(entry.content, MAX_CONTENT_LENGTH),
  }));
}

function loadReports(reportsDir: string): ReportEntry[] {
  if (!existsSync(reportsDir)) {
    return [];
  }

  const files = readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort();
  return files.map((filename) => ({
    filename,
    content: readFileSync(join(reportsDir, filename), 'utf-8'),
  }));
}

function findSessionLogFile(logsDir: string): string | null {
  if (!existsSync(logsDir)) {
    return null;
  }

  const files = readdirSync(logsDir).filter(
    (f) => f.endsWith('.jsonl') && !f.includes('-provider-events'),
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

    const metaPath = join(runsDir, entry.name, 'meta.json');
    const meta = parseMetaJson(metaPath);
    if (!meta) continue;

    summaries.push({
      slug: entry.name,
      task: meta.task,
      piece: meta.piece,
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
  const metaPath = join(cwd, '.takt', 'runs', slug, 'meta.json');
  const meta = parseMetaJson(metaPath);
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
  const metaPath = join(cwd, '.takt', 'runs', slug, 'meta.json');
  const meta = parseMetaJson(metaPath);
  if (!meta) {
    throw new Error(`Run not found: ${slug}`);
  }

  const logsDir = join(cwd, meta.logsDirectory);
  const logFile = findSessionLogFile(logsDir);

  let movementLogs: MovementLogEntry[] = [];
  if (logFile) {
    const sessionLog = loadNdjsonLog(logFile);
    if (sessionLog) {
      movementLogs = buildMovementLogs(sessionLog);
    }
  }

  const reportsDir = join(cwd, meta.reportDirectory);
  const reports = loadReports(reportsDir);

  return {
    task: meta.task,
    piece: meta.piece,
    status: meta.status,
    movementLogs,
    reports,
  };
}

/**
 * Format run session context into a text block for the system prompt.
 */
export function formatRunSessionForPrompt(ctx: RunSessionContext): {
  runTask: string;
  runPiece: string;
  runStatus: string;
  runMovementLogs: string;
  runReports: string;
} {
  const logLines = ctx.movementLogs.map((log) => {
    const header = `### ${log.step} (${log.persona}) — ${log.status}`;
    return `${header}\n${log.content}`;
  });

  const reportLines = ctx.reports.map((report) => {
    return `### ${report.filename}\n${report.content}`;
  });

  return {
    runTask: ctx.task,
    runPiece: ctx.piece,
    runStatus: ctx.status,
    runMovementLogs: logLines.join('\n\n'),
    runReports: reportLines.join('\n\n'),
  };
}
