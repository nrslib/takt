/**
 * Tests for arpeggio template expansion.
 */

import { describe, it, expect } from 'vitest';
import { expandTemplate } from '../core/piece/arpeggio/template.js';
import type { DataBatch } from '../core/piece/arpeggio/types.js';

function makeBatch(rows: Record<string, string>[], batchIndex = 0, totalBatches = 1): DataBatch {
  return { rows, batchIndex, totalBatches };
}

describe('expandTemplate', () => {
  it('should expand {line:1} with formatted row data', () => {
    const batch = makeBatch([{ name: 'Alice', age: '30' }]);
    const result = expandTemplate('Process this: {line:1}', batch);
    expect(result).toBe('Process this: name: Alice\nage: 30');
  });

  it('should expand {line:1} and {line:2} for multi-row batches', () => {
    const batch = makeBatch([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
    const result = expandTemplate('Row 1: {line:1}\nRow 2: {line:2}', batch);
    expect(result).toBe('Row 1: name: Alice\nage: 30\nRow 2: name: Bob\nage: 25');
  });

  it('should expand {col:N:name} with specific column values', () => {
    const batch = makeBatch([{ name: 'Alice', age: '30', city: 'Tokyo' }]);
    const result = expandTemplate('Name: {col:1:name}, City: {col:1:city}', batch);
    expect(result).toBe('Name: Alice, City: Tokyo');
  });

  it('should expand {batch_index} and {total_batches}', () => {
    const batch = makeBatch([{ name: 'Alice' }], 2, 5);
    const result = expandTemplate('Batch {batch_index} of {total_batches}', batch);
    expect(result).toBe('Batch 2 of 5');
  });

  it('should expand all placeholder types in a single template', () => {
    const batch = makeBatch([
      { name: 'Alice', role: 'dev' },
      { name: 'Bob', role: 'pm' },
    ], 0, 3);
    const template = 'Batch {batch_index}/{total_batches}\nFirst: {col:1:name}\nSecond: {line:2}';
    const result = expandTemplate(template, batch);
    expect(result).toBe('Batch 0/3\nFirst: Alice\nSecond: name: Bob\nrole: pm');
  });

  it('should throw when {line:N} references out-of-range row', () => {
    const batch = makeBatch([{ name: 'Alice' }]);
    expect(() => expandTemplate('{line:2}', batch)).toThrow(
      'Template placeholder {line:2} references row 2 but batch has 1 rows'
    );
  });

  it('should throw when {col:N:name} references out-of-range row', () => {
    const batch = makeBatch([{ name: 'Alice' }]);
    expect(() => expandTemplate('{col:2:name}', batch)).toThrow(
      'Template placeholder {col:2:name} references row 2 but batch has 1 rows'
    );
  });

  it('should throw when {col:N:name} references unknown column', () => {
    const batch = makeBatch([{ name: 'Alice' }]);
    expect(() => expandTemplate('{col:1:missing}', batch)).toThrow(
      'Template placeholder {col:1:missing} references unknown column "missing"'
    );
  });

  it('should handle templates with no placeholders', () => {
    const batch = makeBatch([{ name: 'Alice' }]);
    const result = expandTemplate('No placeholders here', batch);
    expect(result).toBe('No placeholders here');
  });

  it('should handle multiple occurrences of the same placeholder', () => {
    const batch = makeBatch([{ name: 'Alice' }], 1, 3);
    const result = expandTemplate('{batch_index} and {batch_index}', batch);
    expect(result).toBe('1 and 1');
  });
});
