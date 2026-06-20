import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PhaseUsageEventLogRecord } from '../core/logging/phaseUsageEvent.js';
import { PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX } from '../core/logging/contracts.js';

export type UsageAnalysisFormat = 'markdown' | 'csv';

export interface UsageAnalysisOptions {
  format?: UsageAnalysisFormat;
}

export interface UsageAnalysisRow {
  step: string;
  phase: string;
  provider: string;
  model: string;
  runs: number;
  calls: number;
  missing: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  avgTotalTokens: number;
  medianTotalTokens: number;
  stddevTotalTokens: number;
}

interface UsageGroup {
  key: string;
  step: string;
  phase: string;
  provider: string;
  model: string;
  runs: Set<string>;
  calls: number;
  missing: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalSamples: number[];
}

const MARKDOWN_COLUMNS: Array<[string, keyof UsageAnalysisRow]> = [
  ['step', 'step'],
  ['phase', 'phase'],
  ['provider', 'provider'],
  ['model', 'model'],
  ['runs', 'runs'],
  ['calls', 'calls'],
  ['missing', 'missing'],
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['total_tokens', 'totalTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['avg_total_tokens', 'avgTotalTokens'],
  ['median_total_tokens', 'medianTotalTokens'],
  ['stddev_total_tokens', 'stddevTotalTokens'],
];

export function analyzeUsage(inputs: string[]): UsageAnalysisRow[] {
  const files = resolvePhaseUsageFiles(inputs);
  const groups = new Map<string, UsageGroup>();

  for (const file of files) {
    for (const record of readPhaseUsageRecords(file)) {
      const key = groupKey(record);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          step: record.step,
          phase: record.phase,
          provider: record.provider,
          model: record.provider_model,
          runs: new Set<string>(),
          calls: 0,
          missing: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalSamples: [],
        };
        groups.set(key, group);
      }
      addRecord(group, record);
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(groupToRow);
}

export function formatUsageAnalysis(rows: UsageAnalysisRow[], format: UsageAnalysisFormat = 'markdown'): string {
  return format === 'csv' ? formatCsv(rows) : formatMarkdown(rows);
}

export function resolvePhaseUsageFiles(inputs: string[]): string[] {
  const files = new Set<string>();
  for (const input of inputs) {
    const target = resolve(input);
    if (!existsSync(target)) {
      throw new Error(`Input path does not exist: ${input}`);
    }
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      for (const file of listPhaseUsageFilesInDirectory(target)) {
        files.add(file);
      }
      continue;
    }
    if (stat.isFile()) {
      if (!isPhaseUsageFile(target)) {
        throw new Error(`Input file is not a phase usage event file: ${input}`);
      }
      files.add(target);
    }
  }
  return [...files].sort();
}

function listPhaseUsageFilesInDirectory(dir: string): string[] {
  const candidates = [
    ...listDirectPhaseUsageFiles(dir),
    ...listDirectPhaseUsageFiles(join(dir, 'logs')),
  ];
  return candidates;
}

function listDirectPhaseUsageFiles(dir: string): string[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => isPhaseUsageFile(entry))
    .map((entry) => join(dir, entry));
}

function isPhaseUsageFile(path: string): boolean {
  return basename(path).endsWith(PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX);
}

function readPhaseUsageRecords(file: string): PhaseUsageEventLogRecord[] {
  const records: PhaseUsageEventLogRecord[] = [];
  const content = readFileSync(file, 'utf-8');
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed) as unknown;
      if (isPhaseUsageRecord(record)) {
        records.push(record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in ${file}:${index + 1}: ${message}`);
    }
  }
  return records;
}

function isPhaseUsageRecord(value: unknown): value is PhaseUsageEventLogRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PhaseUsageEventLogRecord>;
  return typeof candidate.run_id === 'string'
    && typeof candidate.provider === 'string'
    && typeof candidate.provider_model === 'string'
    && typeof candidate.step === 'string'
    && typeof candidate.phase === 'string'
    && typeof candidate.usage_missing === 'boolean'
    && candidate.usage !== null
    && typeof candidate.usage === 'object';
}

function groupKey(record: PhaseUsageEventLogRecord): string {
  return [
    record.step,
    record.phase,
    record.provider,
    record.provider_model,
  ].join('\u0000');
}

function addRecord(group: UsageGroup, record: PhaseUsageEventLogRecord): void {
  group.runs.add(record.run_id);
  group.calls += 1;
  if (record.usage_missing) {
    group.missing += 1;
    return;
  }

  const inputTokens = finiteNumber(record.usage.input_tokens);
  const outputTokens = finiteNumber(record.usage.output_tokens);
  const totalTokens = finiteNumber(record.usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    group.missing += 1;
    return;
  }

  group.inputTokens += inputTokens;
  group.outputTokens += outputTokens;
  group.totalTokens += totalTokens;
  group.cachedInputTokens += finiteNumber(record.usage.cached_input_tokens) ?? 0;
  group.cacheCreationInputTokens += finiteNumber(record.usage.cache_creation_input_tokens) ?? 0;
  group.cacheReadInputTokens += finiteNumber(record.usage.cache_read_input_tokens) ?? 0;
  group.totalSamples.push(totalTokens);
}

function groupToRow(group: UsageGroup): UsageAnalysisRow {
  return {
    step: group.step,
    phase: group.phase,
    provider: group.provider,
    model: group.model,
    runs: group.runs.size,
    calls: group.calls,
    missing: group.missing,
    inputTokens: group.inputTokens,
    outputTokens: group.outputTokens,
    totalTokens: group.totalTokens,
    cachedInputTokens: group.cachedInputTokens,
    cacheCreationInputTokens: group.cacheCreationInputTokens,
    cacheReadInputTokens: group.cacheReadInputTokens,
    avgTotalTokens: average(group.totalSamples),
    medianTotalTokens: median(group.totalSamples),
    stddevTotalTokens: standardDeviation(group.totalSamples),
  };
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const avg = average(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function formatMarkdown(rows: UsageAnalysisRow[]): string {
  if (rows.length === 0) {
    return 'No phase usage events found.';
  }
  const header = `| ${MARKDOWN_COLUMNS.map(([name]) => name).join(' | ')} |`;
  const separator = `| ${MARKDOWN_COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) =>
    `| ${MARKDOWN_COLUMNS.map(([, key]) => formatValue(row[key])).join(' | ')} |`
  );
  return [header, separator, ...body].join('\n');
}

function formatCsv(rows: UsageAnalysisRow[]): string {
  const header = MARKDOWN_COLUMNS.map(([name]) => name).join(',');
  const body = rows.map((row) =>
    MARKDOWN_COLUMNS.map(([, key]) => csvCell(formatValue(row[key]))).join(',')
  );
  return [header, ...body].join('\n');
}

function formatValue(value: UsageAnalysisRow[keyof UsageAnalysisRow]): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function parseArgs(argv: string[]): { format: UsageAnalysisFormat; inputs: string[] } {
  let format: UsageAnalysisFormat = 'markdown';
  const inputs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format') {
      const value = argv[index + 1];
      if (value !== 'markdown' && value !== 'csv') {
        throw new Error('--format must be "markdown" or "csv"');
      }
      format = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'markdown' && value !== 'csv') {
        throw new Error('--format must be "markdown" or "csv"');
      }
      format = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new UsageHelp();
    }
    if (arg?.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg !== undefined) {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) {
    throw new Error('At least one phase usage event file or run directory is required');
  }
  return { format, inputs };
}

class UsageHelp extends Error {}

function usageText(): string {
  return [
    'Usage: npm run analyze:usage -- [--format markdown|csv] <file-or-directory>...',
    '',
    `Reads ${PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX} files and aggregates by step, phase, provider, and model.`,
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const { format, inputs } = parseArgs(process.argv.slice(2));
    const rows = analyzeUsage(inputs);
    process.stdout.write(`${formatUsageAnalysis(rows, format)}\n`);
  } catch (error) {
    if (error instanceof UsageHelp) {
      process.stdout.write(`${usageText()}\n`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${usageText()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
