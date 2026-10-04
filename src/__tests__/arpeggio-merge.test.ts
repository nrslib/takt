/**
 * Tests for arpeggio merge processing.
 */

import { describe, it, expect } from 'vitest';
import { buildMergeFn } from '../core/workflow/arpeggio/merge.js';
import { expandTemplate } from '../core/workflow/arpeggio/template.js';
import type { ArpeggioMergeStepConfig, DataBatch } from '../core/workflow/arpeggio/types.js';
import type { BatchResult } from '../core/workflow/arpeggio/types.js';

function makeResult(batchIndex: number, content: string, success = true): BatchResult {
  return { batchIndex, content, success };
}

function makeFailedResult(batchIndex: number, error: string): BatchResult {
  return { batchIndex, content: '', success: false, error };
}

describe('buildMergeFn', () => {
  describe('concat strategy', () => {
    it('should concatenate results with default separator (newline)', () => {
      const config: ArpeggioMergeStepConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'Result A'),
        makeResult(1, 'Result B'),
        makeResult(2, 'Result C'),
      ];
      expect(mergeFn(results)).toBe('Result A\nResult B\nResult C');
    });

    it('should concatenate results with custom separator', () => {
      const config: ArpeggioMergeStepConfig = { strategy: 'concat', separator: '\n---\n' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\n---\nB');
    });

    it('should sort results by batch index', () => {
      const config: ArpeggioMergeStepConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(2, 'C'),
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\nB\nC');
    });

    it('should filter out failed results', () => {
      const config: ArpeggioMergeStepConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeFailedResult(1, 'oops'),
        makeResult(2, 'C'),
      ];
      expect(mergeFn(results)).toBe('A\nC');
    });

    it('should return empty string when all results failed', () => {
      const config: ArpeggioMergeStepConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeFailedResult(0, 'error1'),
        makeFailedResult(1, 'error2'),
      ];
      expect(mergeFn(results)).toBe('');
    });
  });

  describe('custom strategy', () => {
    it('should execute inline_js merge function', () => {
      const config: ArpeggioMergeStepConfig = {
        strategy: 'custom',
        inlineJs: 'return results.filter((r) => r.success).map((r) => r.content).reverse().join("|");',
      };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(1, 'B'),
        makeResult(0, 'A'),
      ];
      expect(mergeFn(results)).toBe('B|A');
    });
  });
});

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
