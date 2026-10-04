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
