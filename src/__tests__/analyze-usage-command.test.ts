import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeUsage,
  formatUsageAnalysis,
  resolvePhaseUsageFiles,
} from '../commands/analyze-usage.js';

const tempDirs = new Set<string>();

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-analyze-usage-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('analyze usage command', () => {
  it('resolves phase usage files from files, logs directories, and run directories', () => {
    const root = createTempDir();
    const runDir = join(root, 'run-1');
    const logsDir = join(runDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const directFile = join(root, 'direct-usage-events.phase.jsonl');
    const nestedFile = join(logsDir, 'session-usage-events.phase.jsonl');
    writeFileSync(directFile, '', 'utf-8');
    writeFileSync(nestedFile, '', 'utf-8');
    writeFileSync(join(logsDir, 'session-usage-events.jsonl'), '', 'utf-8');

    expect(resolvePhaseUsageFiles([directFile, runDir])).toEqual([
      directFile,
      nestedFile,
    ].sort());
    expect(resolvePhaseUsageFiles([logsDir])).toEqual([nestedFile]);
  });

  it('aggregates by step, phase, provider, and model while excluding missing usage from token stats', () => {
    const root = createTempDir();
    const file = join(root, 'session-usage-events.phase.jsonl');
    writeFileSync(file, [
      record({ run_id: 'run-a', total_tokens: 10, input_tokens: 6, output_tokens: 4 }),
      record({ run_id: 'run-b', total_tokens: 20, input_tokens: 12, output_tokens: 8 }),
      record({ run_id: 'run-b', usage_missing: true, reason: 'usage_not_available', usage: {} }),
      record({
        run_id: 'run-b',
        step: 'review',
        phase: 'phase2_report',
        total_tokens: 5,
        input_tokens: 3,
        output_tokens: 2,
      }),
    ].join('\n') + '\n', 'utf-8');

    const rows = analyzeUsage([file]);

    expect(rows).toEqual([
      expect.objectContaining({
        step: 'implement',
        phase: 'phase1_execute',
        provider: 'mock',
        model: 'mock-model',
        runs: 2,
        calls: 3,
        missing: 1,
        inputTokens: 18,
        outputTokens: 12,
        totalTokens: 30,
        avgTotalTokens: 15,
        medianTotalTokens: 15,
        stddevTotalTokens: 5,
      }),
      expect.objectContaining({
        step: 'review',
        phase: 'phase2_report',
        runs: 1,
        calls: 1,
        totalTokens: 5,
      }),
    ]);
  });

  it('formats markdown and csv output', () => {
    const rows = [{
      step: 'implement',
      phase: 'phase1_execute',
      provider: 'mock',
      model: 'mock,model',
      runs: 1,
      calls: 2,
      missing: 0,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      avgTotalTokens: 2.5,
      medianTotalTokens: 2.5,
      stddevTotalTokens: 0.5,
    }];

    expect(formatUsageAnalysis(rows)).toContain('| implement | phase1_execute | mock | mock,model |');
    expect(formatUsageAnalysis(rows, 'csv')).toContain('implement,phase1_execute,mock,"mock,model"');
  });

  it('throws with line information for invalid JSON', () => {
    const root = createTempDir();
    const file = join(root, 'session-usage-events.phase.jsonl');
    writeFileSync(file, '{bad json}\n', 'utf-8');

    expect(() => analyzeUsage([file])).toThrow(`Invalid JSON in ${file}:1`);
    expect(readFileSync(file, 'utf-8')).toBe('{bad json}\n');
  });

  it('rejects explicit files that are not phase usage event files', () => {
    const root = createTempDir();
    const file = join(root, 'session-usage-events.jsonl');
    writeFileSync(file, '', 'utf-8');

    expect(() => resolvePhaseUsageFiles([file])).toThrow(`Input file is not a phase usage event file: ${file}`);
  });

  it('throws for nonexistent input paths', () => {
    expect(() => resolvePhaseUsageFiles(['/nonexistent/path/file.phase.jsonl']))
      .toThrow('Input path does not exist');
  });

  it('returns empty rows for a file with no valid records', () => {
    const root = createTempDir();
    const file = join(root, 'empty-usage-events.phase.jsonl');
    writeFileSync(file, '', 'utf-8');

    expect(analyzeUsage([file])).toEqual([]);
  });

  it('silently skips records missing required fields', () => {
    const root = createTempDir();
    const file = join(root, 'partial-usage-events.phase.jsonl');
    // Missing run_id and usage_missing fields — should be skipped
    writeFileSync(file, [
      JSON.stringify({ provider: 'mock', provider_model: 'x', step: 'a', phase: 'phase1_execute' }),
      // Valid record
      record({ run_id: 'run-a', total_tokens: 5, input_tokens: 3, output_tokens: 2 }),
    ].join('\n') + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 1, totalTokens: 5 });
  });

  it('formatUsageAnalysis returns "No phase usage events found." for empty rows', () => {
    expect(formatUsageAnalysis([])).toBe('No phase usage events found.');
    expect(formatUsageAnalysis([], 'markdown')).toBe('No phase usage events found.');
  });

  it('formatUsageAnalysis CSV has correct header row', () => {
    const csv = formatUsageAnalysis([], 'csv');
    expect(csv.startsWith('step,phase,provider,model,')).toBe(true);
    expect(csv).toContain('total_tokens');
    expect(csv).toContain('avg_total_tokens');
  });

  it('computes median correctly for an even number of samples', () => {
    const root = createTempDir();
    const file = join(root, 'even-median-usage-events.phase.jsonl');
    // 4 records with total_tokens 10, 20, 30, 40 → median = (20+30)/2 = 25
    writeFileSync(file, [
      record({ run_id: 'run-a', total_tokens: 10, input_tokens: 5, output_tokens: 5 }),
      record({ run_id: 'run-a', total_tokens: 20, input_tokens: 10, output_tokens: 10 }),
      record({ run_id: 'run-a', total_tokens: 30, input_tokens: 15, output_tokens: 15 }),
      record({ run_id: 'run-a', total_tokens: 40, input_tokens: 20, output_tokens: 20 }),
    ].join('\n') + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows[0]?.medianTotalTokens).toBe(25);
  });

  it('computes stddev correctly', () => {
    const root = createTempDir();
    const file = join(root, 'stddev-usage-events.phase.jsonl');
    // Two records: tokens 10 and 20 → avg=15, variance=((10-15)²+(20-15)²)/2=25, stddev=5
    writeFileSync(file, [
      record({ run_id: 'run-a', total_tokens: 10, input_tokens: 6, output_tokens: 4 }),
      record({ run_id: 'run-b', total_tokens: 20, input_tokens: 12, output_tokens: 8 }),
    ].join('\n') + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows[0]?.stddevTotalTokens).toBe(5);
  });

  it('accumulates cache token columns', () => {
    const root = createTempDir();
    const file = join(root, 'cache-usage-events.phase.jsonl');
    writeFileSync(file, JSON.stringify({
      run_id: 'run-a',
      session_id: 'session-a',
      provider: 'mock',
      provider_model: 'mock-model',
      step: 'implement',
      step_type: 'normal',
      phase: 'phase1_execute',
      phase_name: 'execute',
      timestamp: '2026-06-06T00:00:00.000Z',
      success: true,
      usage_missing: false,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cached_input_tokens: 4,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      },
    }) + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows[0]).toMatchObject({
      cachedInputTokens: 4,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 2,
    });
  });

  it('reports zero stats when all records are missing usage', () => {
    const root = createTempDir();
    const file = join(root, 'all-missing-usage-events.phase.jsonl');
    writeFileSync(file, [
      record({ run_id: 'run-a', usage_missing: true }),
      record({ run_id: 'run-b', usage_missing: true }),
    ].join('\n') + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows[0]).toMatchObject({
      calls: 2,
      missing: 2,
      totalTokens: 0,
      avgTotalTokens: 0,
      medianTotalTokens: 0,
      stddevTotalTokens: 0,
    });
  });

  it('formats non-integer numbers with two decimal places in markdown', () => {
    const rows = [{
      step: 'implement',
      phase: 'phase1_execute',
      provider: 'mock',
      model: 'mock-model',
      runs: 1,
      calls: 1,
      missing: 0,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      avgTotalTokens: 3.14159,
      medianTotalTokens: 3.14159,
      stddevTotalTokens: 1.5,
    }];

    const markdown = formatUsageAnalysis(rows, 'markdown');
    expect(markdown).toContain('3.14');
    expect(markdown).toContain('1.50');
  });

  it('treats non-finite token values in usage as missing', () => {
    const root = createTempDir();
    const file = join(root, 'nan-usage-events.phase.jsonl');
    // usage_missing=false but non-finite token values → treated as missing
    writeFileSync(file, JSON.stringify({
      run_id: 'run-a',
      session_id: 'session-a',
      provider: 'mock',
      provider_model: 'mock-model',
      step: 'implement',
      step_type: 'normal',
      phase: 'phase1_execute',
      phase_name: 'execute',
      timestamp: '2026-06-06T00:00:00.000Z',
      success: true,
      usage_missing: false,
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
    }) + '\n', 'utf-8');

    const rows = analyzeUsage([file]);
    expect(rows[0]).toMatchObject({
      calls: 1,
      missing: 1,
      totalTokens: 0,
    });
  });
});

function record(overrides: Record<string, unknown>): string {
  const usageMissing = overrides.usage_missing === true;
  return JSON.stringify({
    run_id: 'run-a',
    session_id: 'session-a',
    provider: 'mock',
    provider_model: 'mock-model',
    step: 'implement',
    step_type: 'normal',
    phase: 'phase1_execute',
    phase_name: 'execute',
    timestamp: '2026-06-06T00:00:00.000Z',
    success: !usageMissing,
    usage_missing: usageMissing,
    usage: usageMissing
      ? {}
      : {
          input_tokens: overrides.input_tokens,
          output_tokens: overrides.output_tokens,
          total_tokens: overrides.total_tokens,
        },
    ...overrides,
  });
}
