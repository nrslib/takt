import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendJsonLine } from '../infra/fs/index.js';

const tempDirs = new Set<string>();

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-jsonl-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('appendJsonLine', () => {
  it('creates the file and writes a JSON record followed by a newline', () => {
    const dir = createTempDir();
    const path = join(dir, 'test.jsonl');
    const record = { key: 'value', num: 42 };

    appendJsonLine(path, record);

    const content = readFileSync(path, 'utf-8');
    expect(content).toBe(`${JSON.stringify(record)}\n`);
  });

  it('appends multiple records to the same file', () => {
    const dir = createTempDir();
    const path = join(dir, 'test.jsonl');
    const records = [
      { event: 'first', value: 1 },
      { event: 'second', value: 2 },
      { event: 'third', value: 3 },
    ];

    for (const record of records) {
      appendJsonLine(path, record);
    }

    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual(records[0]);
    expect(JSON.parse(lines[1]!)).toEqual(records[1]);
    expect(JSON.parse(lines[2]!)).toEqual(records[2]);
  });

  it('serializes nested objects correctly', () => {
    const dir = createTempDir();
    const path = join(dir, 'nested.jsonl');
    const record = { outer: { inner: [1, 2, 3] }, flag: true };

    appendJsonLine(path, record);

    const parsed = JSON.parse(readFileSync(path, 'utf-8').trim()) as unknown;
    expect(parsed).toEqual(record);
  });

  it('each line is valid JSON and parseable independently', () => {
    const dir = createTempDir();
    const path = join(dir, 'multi.jsonl');

    appendJsonLine(path, { a: 1 });
    appendJsonLine(path, { b: 'text with "quotes"' });

    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('throws when the parent directory does not exist', () => {
    const path = join(createTempDir(), 'missing-subdir', 'test.jsonl');
    expect(() => appendJsonLine(path, { x: 1 })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});