import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// These tests exercise the real aggregation logic embedded in tools/token-usage.sh
// (persona/tags first-wins selection and `|` joined tags) by running the script
// against fixture JSONL, so the CSV execution contract cannot silently regress.

const scriptPath = join(process.cwd(), 'tools', 'token-usage.sh');

function record(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    run_id: 'fixture-run',
    provider: 'mock',
    provider_model: 'mock-model',
    timestamp: '2026-06-21T00:00:00.000Z',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 0 },
    ...overrides,
  });
}

function runCsv(scanDir: string): string {
  const result = spawnSync('bash', [scriptPath, scanDir, '--csv', '--all'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`token-usage.sh exited with ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function dataRows(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .slice(1) // drop header
    .filter((line) => line.length > 0)
    .map((line) => line.split(','));
}

describe('token-usage.sh CSV persona/tags columns', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'token-usage-csv-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFixture(lines: string[]): void {
    writeFileSync(join(tempDir, 'usage-events.phase.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
  }

  it('emits the persona and tags columns in the CSV header', () => {
    writeFixture([record({ step: 'review', persona: 'reviewer', tags: ['coding'] })]);

    const header = runCsv(tempDir).trim().split('\n')[0];

    expect(header).toBe(
      'task,run_id,provider,model,step,persona,tags,input_tokens,output_tokens,total_tokens,cached_tokens,calls',
    );
  });

  it('takes the first non-empty persona and tags across records (first-wins)', () => {
    writeFixture([
      record({ step: 'review' }), // no persona, no tags
      record({ step: 'review', persona: 'reviewer', tags: ['coding', 'review'] }),
      record({ step: 'review', persona: 'other', tags: ['ignored'] }),
    ]);

    const rows = dataRows(runCsv(tempDir));
    const reviewRow = rows.find((cols) => cols[4] === 'review');

    expect(reviewRow).toBeDefined();
    expect(reviewRow?.[5]).toBe('reviewer');
    // tags are pipe-joined so commas never leak into the CSV column structure
    expect(reviewRow?.[6]).toBe('coding|review');
    // all three records aggregate into a single step row
    expect(reviewRow?.[11]).toBe('3');
  });

  it('leaves persona and tags columns empty when records carry neither', () => {
    writeFixture([record({ step: 'build' })]);

    const rows = dataRows(runCsv(tempDir));
    const buildRow = rows.find((cols) => cols[4] === 'build');

    expect(buildRow).toBeDefined();
    expect(buildRow?.[5]).toBe('');
    expect(buildRow?.[6]).toBe('');
  });
});
