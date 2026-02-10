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
    it('should concatenate results with default separator (newline)', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeResult(0, 'Result A'),
        makeResult(1, 'Result B'),
        makeResult(2, 'Result C'),
      ];
      expect(mergeFn(results)).toBe('Result A\nResult B\nResult C');
    });

    it('should concatenate results with custom separator', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat', separator: '\n---\n' };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\n---\nB');
    });

    it('should sort results by batch index', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeResult(2, 'C'),
        makeResult(0, 'A'),
        makeResult(1, 'B'),
      ];
      expect(mergeFn(results)).toBe('A\nB\nC');
    });

    it('should filter out failed results', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeResult(0, 'A'),
        makeFailedResult(1, 'oops'),
        makeResult(2, 'C'),
      ];
      expect(mergeFn(results)).toBe('A\nC');
    });

    it('should return empty string when all results failed', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'concat' };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeFailedResult(0, 'error1'),
        makeFailedResult(1, 'error2'),
      ];
      expect(mergeFn(results)).toBe('');
    });
  });

  describe('custom strategy with inline_js', () => {
    it('should execute inline JS merge function', async () => {
      const config: ArpeggioMergeMovementConfig = {
        strategy: 'custom',
        inlineJs: 'return results.filter(r => r.success).map(r => r.content.toUpperCase()).join(", ");',
      };
      const mergeFn = await buildMergeFn(config);
      const results = [
        makeResult(0, 'hello'),
        makeResult(1, 'world'),
      ];
      expect(mergeFn(results)).toBe('HELLO, WORLD');
    });

    it('should throw when inline JS returns non-string', async () => {
      const config: ArpeggioMergeMovementConfig = {
        strategy: 'custom',
        inlineJs: 'return 42;',
      };
      const mergeFn = await buildMergeFn(config);
      expect(() => mergeFn([makeResult(0, 'test')])).toThrow(
        'Inline JS merge function must return a string, got number'
      );
    });
  });

  describe('custom strategy validation', () => {
    it('should throw when custom strategy has neither inline_js nor file', async () => {
      const config: ArpeggioMergeMovementConfig = { strategy: 'custom' };
      await expect(buildMergeFn(config)).rejects.toThrow(
        'Custom merge strategy requires either inline_js or file path'
      );
    });
  });
});
