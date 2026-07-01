import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('../../tools/token-usage.sh', import.meta.url));

const tempDirs = new Set<string>();

function createScanDir(records: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-token-usage-csv-'));
  tempDirs.add(dir);
  const lines = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(join(dir, 'session-usage-events.phase.jsonl'), `${lines}\n`, 'utf-8');
  return dir;
}

function runCsv(scanDir: string): string[] {
  const output = execFileSync('bash', [SCRIPT_PATH, scanDir, '--csv'], { encoding: 'utf-8' });
  return output.trim().split('\n');
}

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run-1',
    provider: 'codex',
    provider_model: 'gpt-5',
    step: 'implement',
    step_type: 'agent',
    phase: 'phase1_execute',
    timestamp: '2026-05-14T16:46:45.000Z',
    success: true,
    usage_missing: false,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('token-usage.sh --csv', () => {
  it('adds persona and tags columns to the CSV header', () => {
    const scanDir = createScanDir([makeRecord({ persona: 'coder', tags: ['coding', 'review'] })]);

    const [header] = runCsv(scanDir);

    expect(header).toBe(
      'task,run_id,provider,model,step,persona,tags,input_tokens,output_tokens,total_tokens,cached_tokens,calls',
    );
  });

  it('emits persona and pipe-joined tags for a step row', () => {
    const scanDir = createScanDir([
      makeRecord({ persona: 'coder', tags: ['coding', 'review'] }),
      makeRecord({ persona: 'coder', tags: ['coding', 'review'] }),
    ]);

    const rows = runCsv(scanDir).slice(1);

    expect(rows).toHaveLength(1);
    // The leading task column is derived from the scan path and is environment
    // dependent (it picks up a takt-worktrees directory name when present), so
    // assert every column after it to keep the persona/tags check deterministic.
    expect(rows[0]?.split(',').slice(1)).toEqual(
      ['run-1', 'codex', 'gpt-5', 'implement', 'coder', 'coding|review', '20', '10', '30', '0', '2'],
    );
  });

  it('does not break CSV columns when persona and tags are missing', () => {
    const scanDir = createScanDir([makeRecord()]);

    const rows = runCsv(scanDir).slice(1);

    expect(rows).toHaveLength(1);
    const columns = rows[0]?.split(',') ?? [];
    expect(columns).toHaveLength(12);
    // Columns after the environment-dependent task column: run_id, provider,
    // model, step, then the empty persona and tags columns.
    expect(columns.slice(1, 7)).toEqual(['run-1', 'codex', 'gpt-5', 'implement', '', '']);
  });
});
