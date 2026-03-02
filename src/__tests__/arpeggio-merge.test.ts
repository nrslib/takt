/**
 * Tests for arpeggio merge processing.
 */

import { describe, it, expect } from 'vitest';
import { buildMergeFn } from '../core/piece/arpeggio/merge.js';
import type { ArpeggioMergeMovementConfig } from '../core/piece/arpeggio/types.js';
import type { BatchResult } from '../core/piece/arpeggio/types.js';

function makeResult(batchIndex: number, content: string, success = true): BatchResult {
  return { batchIndex, content, success };
}

function makeFailedResult(batchIndex: number, error: string): BatchResult {
  return { batchIndex, content: '', success: false, error };
}

describe('buildMergeFn', () => {
  describe('concat strategy', () => {
    it('should concatenate results with default separator (newline)', () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'Result A'),
        makeResult(1, 'Result B'),
        makeResult(2, 'Result C'),
      ];
      expect(mergeFn(results)).toBe('Result A\nResult B\nResult C');
    });

    it('should concatenate results with custom separator', () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat', separator: '\n---\n' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\n---\nB');
    });

    it('should sort results by batch index', () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(2, 'C'),
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\nB\nC');
    });

    it('should filter out failed results', () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeFailedResult(1, 'oops'),
        makeResult(2, 'C'),
      ];
      expect(mergeFn(results)).toBe('A\nC');
    });

    it('should return empty string when all results failed', () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
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
      const config: ArpeggioMergeMovementConfig = {
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
