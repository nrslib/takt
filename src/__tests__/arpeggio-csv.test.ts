/**
 * Tests for CSV data source parsing and batch reading.
 */

import { describe, it, expect } from 'vitest';
import { parseCsv, CsvDataSource } from '../core/piece/arpeggio/csv-data-source.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('parseCsv', () => {
  it('should parse simple CSV content', () => {
    const csv = 'name,age\nAlice,30\nBob,25';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  it('should handle quoted fields', () => {
    const csv = 'name,description\nAlice,"Hello, World"\nBob,"Line1"';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'description'],
      ['Alice', 'Hello, World'],
      ['Bob', 'Line1'],
    ]);
  });

  it('should handle escaped quotes (double quotes)', () => {
    const csv = 'name,value\nAlice,"He said ""hello"""\nBob,simple';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'value'],
      ['Alice', 'He said "hello"'],
      ['Bob', 'simple'],
    ]);
  });

  it('should handle CRLF line endings', () => {
    const csv = 'name,age\r\nAlice,30\r\nBob,25';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  it('should handle bare CR line endings', () => {
    const csv = 'name,age\rAlice,30\rBob,25';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  it('should handle empty fields', () => {
    const csv = 'a,b,c\n1,,3\n,,';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['', '', ''],
    ]);
  });

  it('should handle newlines within quoted fields', () => {
    const csv = 'name,bio\nAlice,"Line1\nLine2"\nBob,simple';
    const result = parseCsv(csv);
    expect(result).toEqual([
      ['name', 'bio'],
      ['Alice', 'Line1\nLine2'],
      ['Bob', 'simple'],
    ]);
  });
});

describe('CsvDataSource', () => {
  function createTempCsv(content: string): string {
    const dir = join(tmpdir(), `takt-csv-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'test.csv');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('should read batches with batch_size 1', async () => {
    const filePath = createTempCsv('name,age\nAlice,30\nBob,25\nCharlie,35');
    const source = new CsvDataSource(filePath);
    const batches = await source.readBatches(1);

    expect(batches).toHaveLength(3);
    expect(batches[0]!.rows).toEqual([{ name: 'Alice', age: '30' }]);
    expect(batches[0]!.batchIndex).toBe(0);
    expect(batches[0]!.totalBatches).toBe(3);
    expect(batches[1]!.rows).toEqual([{ name: 'Bob', age: '25' }]);
    expect(batches[2]!.rows).toEqual([{ name: 'Charlie', age: '35' }]);
  });

  it('should read batches with batch_size 2', async () => {
    const filePath = createTempCsv('name,age\nAlice,30\nBob,25\nCharlie,35');
    const source = new CsvDataSource(filePath);
    const batches = await source.readBatches(2);

    expect(batches).toHaveLength(2);
    expect(batches[0]!.rows).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
    expect(batches[0]!.totalBatches).toBe(2);
    expect(batches[1]!.rows).toEqual([
      { name: 'Charlie', age: '35' },
    ]);
  });

  it('should throw when CSV has no data rows', async () => {
    const filePath = createTempCsv('name,age');
    const source = new CsvDataSource(filePath);
    await expect(source.readBatches(1)).rejects.toThrow('CSV file has no data rows');
  });

  it('should handle missing columns by returning empty string', async () => {
    const filePath = createTempCsv('a,b,c\n1,2\n3');
    const source = new CsvDataSource(filePath);
    const batches = await source.readBatches(1);

    expect(batches[0]!.rows).toEqual([{ a: '1', b: '2', c: '' }]);
    expect(batches[1]!.rows).toEqual([{ a: '3', b: '', c: '' }]);
  });
});
