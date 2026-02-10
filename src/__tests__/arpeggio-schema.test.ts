/**
 * Tests for Arpeggio-related Zod schemas.
 *
 * Covers:
 * - ArpeggioMergeRawSchema cross-validation (.refine())
 * - ArpeggioConfigRawSchema required fields and defaults
 * - PieceMovementRawSchema with arpeggio field
 */

import { describe, it, expect } from 'vitest';
import {
  ArpeggioMergeRawSchema,
  ArpeggioConfigRawSchema,
  PieceMovementRawSchema,
} from '../core/models/index.js';

describe('ArpeggioMergeRawSchema', () => {
  it('should accept concat strategy without inline_js or file', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'concat',
    });
    expect(result.success).toBe(true);
  });

  it('should accept concat strategy with separator', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'concat',
      separator: '\n---\n',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.separator).toBe('\n---\n');
    }
  });

  it('should default strategy to concat when omitted', () => {
    const result = ArpeggioMergeRawSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strategy).toBe('concat');
    }
  });

  it('should accept custom strategy with inline_js', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'custom',
      inline_js: 'return results.map(r => r.content).join(",");',
    });
    expect(result.success).toBe(true);
  });

  it('should accept custom strategy with file', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'custom',
      file: './merge.js',
    });
    expect(result.success).toBe(true);
  });

  it('should reject custom strategy without inline_js or file', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('should reject concat strategy with inline_js', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'concat',
      inline_js: 'return "hello";',
    });
    expect(result.success).toBe(false);
  });

  it('should reject concat strategy with file', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'concat',
      file: './merge.js',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid strategy value', () => {
    const result = ArpeggioMergeRawSchema.safeParse({
      strategy: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('ArpeggioConfigRawSchema', () => {
  const validConfig = {
    source: 'csv',
    source_path: './data.csv',
    template: './template.md',
  };

  it('should accept a valid minimal config', () => {
    const result = ArpeggioConfigRawSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('should apply default values for optional fields', () => {
    const result = ArpeggioConfigRawSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.batch_size).toBe(1);
      expect(result.data.concurrency).toBe(1);
      expect(result.data.max_retries).toBe(2);
      expect(result.data.retry_delay_ms).toBe(1000);
    }
  });

  it('should accept explicit values overriding defaults', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      batch_size: 5,
      concurrency: 3,
      max_retries: 4,
      retry_delay_ms: 2000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.batch_size).toBe(5);
      expect(result.data.concurrency).toBe(3);
      expect(result.data.max_retries).toBe(4);
      expect(result.data.retry_delay_ms).toBe(2000);
    }
  });

  it('should accept config with merge field', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      merge: { strategy: 'concat', separator: '---' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept config with output_path', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      output_path: './output.txt',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output_path).toBe('./output.txt');
    }
  });

  it('should reject when source is empty', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      source: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject when source is missing', () => {
    const { source: _, ...noSource } = validConfig;
    const result = ArpeggioConfigRawSchema.safeParse(noSource);
    expect(result.success).toBe(false);
  });

  it('should reject when source_path is empty', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      source_path: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject when source_path is missing', () => {
    const { source_path: _, ...noSourcePath } = validConfig;
    const result = ArpeggioConfigRawSchema.safeParse(noSourcePath);
    expect(result.success).toBe(false);
  });

  it('should reject when template is empty', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      template: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject when template is missing', () => {
    const { template: _, ...noTemplate } = validConfig;
    const result = ArpeggioConfigRawSchema.safeParse(noTemplate);
    expect(result.success).toBe(false);
  });

  it('should reject batch_size of 0', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      batch_size: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative batch_size', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      batch_size: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject concurrency of 0', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      concurrency: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative concurrency', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      concurrency: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative max_retries', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      max_retries: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should accept max_retries of 0', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      max_retries: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_retries).toBe(0);
    }
  });

  it('should reject non-integer batch_size', () => {
    const result = ArpeggioConfigRawSchema.safeParse({
      ...validConfig,
      batch_size: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('PieceMovementRawSchema with arpeggio', () => {
  it('should accept a movement with arpeggio config', () => {
    const raw = {
      name: 'batch-process',
      arpeggio: {
        source: 'csv',
        source_path: './data.csv',
        template: './prompt.md',
      },
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arpeggio).toBeDefined();
      expect(result.data.arpeggio!.source).toBe('csv');
    }
  });

  it('should accept a movement with arpeggio and rules', () => {
    const raw = {
      name: 'batch-process',
      arpeggio: {
        source: 'csv',
        source_path: './data.csv',
        template: './prompt.md',
        batch_size: 2,
        concurrency: 3,
      },
      rules: [
        { condition: 'All processed', next: 'COMPLETE' },
        { condition: 'Errors found', next: 'fix' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arpeggio!.batch_size).toBe(2);
      expect(result.data.arpeggio!.concurrency).toBe(3);
      expect(result.data.rules).toHaveLength(2);
    }
  });

  it('should accept a movement without arpeggio (normal movement)', () => {
    const raw = {
      name: 'normal-step',
      persona: 'coder.md',
      instruction_template: 'Do work',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arpeggio).toBeUndefined();
    }
  });

  it('should accept a movement with arpeggio including custom merge', () => {
    const raw = {
      name: 'custom-merge-step',
      arpeggio: {
        source: 'csv',
        source_path: './data.csv',
        template: './prompt.md',
        merge: {
          strategy: 'custom',
          inline_js: 'return results.map(r => r.content).join(", ");',
        },
        output_path: './output.txt',
      },
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arpeggio!.merge).toBeDefined();
      expect(result.data.arpeggio!.output_path).toBe('./output.txt');
    }
  });
});
