import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('../../tools/token-usage.sh', import.meta.url));
const tempDirs = new Set<string>();

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run-1',
    provider: 'codex',
    provider_model: 'gpt-5',
    step: 'implement',
    timestamp: '2026-05-14T16:46:45.000Z',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_input_tokens: 0,
    },
    ...overrides,
  };
}

function runTokenUsage(records: Array<Record<string, unknown>>, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-token-usage-csv-'));
  tempDirs.add(dir);
  writeFileSync(
    join(dir, 'session-usage-events.phase.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf-8',
  );
  return execFileSync('bash', [SCRIPT_PATH, dir, ...args], { encoding: 'utf-8' });
}

function runCsv(records: Array<Record<string, unknown>>): string[] {
  return runTokenUsage(records, ['--csv'])
    .trim()
    .split('\n');
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('token-usage.sh output', () => {
  it('groups the same step separately by persona and tags', () => {
    const [header, ...rows] = runCsv([
      makeRecord({ persona: 'coder', tags: ['coding'] }),
      makeRecord({ persona: 'reviewer', tags: ['review'] }),
      makeRecord({ persona: 'coder', tags: ['coding'] }),
    ]);

    expect(header).toBe(
      'task,run_id,provider,model,step,persona,tags,input_tokens,output_tokens,total_tokens,cached_tokens,calls',
    );
    expect(rows).toEqual([
      '-,run-1,codex,gpt-5,implement,coder,coding,20,10,30,0,2',
      '-,run-1,codex,gpt-5,implement,reviewer,review,10,5,15,0,1',
    ]);
  });

  it('escapes CSV cells containing commas and quotes', () => {
    const [, row] = runCsv([
      makeRecord({
        run_id: 'run,1',
        provider_model: 'gpt-"5"',
        persona: 'reviewer, "lead"',
        tags: ['coding,review', 'quality'],
      }),
    ]);

    expect(row).toBe(
      '-,"run,1",codex,"gpt-""5""",implement,"reviewer, ""lead""","coding,review|quality",10,5,15,0,1',
    );
  });

  it('leaves invalid optional metadata empty', () => {
    const [, row] = runCsv([
      makeRecord({ persona: 1, tags: ['coding', 2] }),
    ]);

    expect(row).toBe('-,run-1,codex,gpt-5,implement,,,10,5,15,0,1');
  });

  it('distinguishes text rows with the same step by persona and tags', () => {
    const output = runTokenUsage([
      makeRecord({ persona: 'coder', tags: ['coding', 'review'] }),
      makeRecord({ persona: 'reviewer' }),
      makeRecord({ tags: ['validation'] }),
      makeRecord(),
    ], []);

    expect(output).toContain('implement [persona: coder; tags: coding|review] (×1)');
    expect(output).toContain('implement [persona: reviewer] (×1)');
    expect(output).toContain('implement [tags: validation] (×1)');
    expect(output).toContain('implement (×1)');
  });
});
