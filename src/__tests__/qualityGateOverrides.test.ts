/**
 * Tests for quality gate override logic
 */

import { describe, it, expect } from 'vitest';
import { applyQualityGateOverrides } from '../infra/config/loaders/qualityGateOverrides.js';
import type { PieceOverrides } from '../core/models/persisted-global-config.js';

describe('applyQualityGateOverrides', () => {
  it('returns undefined when no gates are defined', () => {
    const result = applyQualityGateOverrides('implement', undefined, true, undefined, undefined);
    expect(result).toBeUndefined();
  });

  it('returns YAML gates when no overrides are defined', () => {
    const yamlGates = ['Test passes'];
    const result = applyQualityGateOverrides('implement', yamlGates, true, undefined, undefined);
    expect(result).toEqual(['Test passes']);
  });

  it('returns empty array when yamlGates is empty array and no overrides', () => {
    const yamlGates: string[] = [];
    const result = applyQualityGateOverrides('implement', yamlGates, true, undefined, undefined);
    expect(result).toEqual([]);
  });

  it('merges global override gates with YAML gates (additive)', () => {
    const yamlGates = ['Unit tests pass'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['E2E tests pass'],
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, undefined, globalOverrides);
    expect(result).toEqual(['E2E tests pass', 'Unit tests pass']);
  });

  it('applies movement-specific override from global config', () => {
    const yamlGates = ['Unit tests pass'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['Global gate'],
      movements: {
        implement: {
          qualityGates: ['Movement-specific gate'],
        },
      },
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, undefined, globalOverrides);
    expect(result).toEqual(['Global gate', 'Movement-specific gate', 'Unit tests pass']);
  });

  it('applies project overrides with higher priority than global', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['Global gate'],
    };
    const projectOverrides: PieceOverrides = {
      qualityGates: ['Project gate'],
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, globalOverrides);
    expect(result).toEqual(['Global gate', 'Project gate', 'YAML gate']);
  });

  it('applies movement-specific override from project config', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: PieceOverrides = {
      movements: {
        implement: {
          qualityGates: ['Project movement gate'],
        },
      },
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, undefined);
    expect(result).toEqual(['Project movement gate', 'YAML gate']);
  });

  it('filters global gates when qualityGatesEditOnly=true and edit=false', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['Global gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyQualityGateOverrides('review', yamlGates, false, undefined, globalOverrides);
    expect(result).toEqual(['YAML gate']); // Global gate excluded because edit=false
  });

  it('includes global gates when qualityGatesEditOnly=true and edit=true', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['Global gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, undefined, globalOverrides);
    expect(result).toEqual(['Global gate', 'YAML gate']);
  });

  it('filters project global gates when qualityGatesEditOnly=true and edit=false', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: PieceOverrides = {
      qualityGates: ['Project gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyQualityGateOverrides('review', yamlGates, false, projectOverrides, undefined);
    expect(result).toEqual(['YAML gate']); // Project gate excluded because edit=false
  });

  it('applies movement-specific gates regardless of qualityGatesEditOnly flag', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: PieceOverrides = {
      qualityGates: ['Project global gate'],
      qualityGatesEditOnly: true,
      movements: {
        review: {
          qualityGates: ['Review-specific gate'],
        },
      },
    };
    const result = applyQualityGateOverrides('review', yamlGates, false, projectOverrides, undefined);
    // Project global gate excluded (edit=false), but movement-specific gate included
    expect(result).toEqual(['Review-specific gate', 'YAML gate']);
  });

  it('handles complex priority scenario with all override types', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: PieceOverrides = {
      qualityGates: ['Global gate'],
      movements: {
        implement: {
          qualityGates: ['Global movement gate'],
        },
      },
    };
    const projectOverrides: PieceOverrides = {
      qualityGates: ['Project gate'],
      movements: {
        implement: {
          qualityGates: ['Project movement gate'],
        },
      },
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, globalOverrides);
    expect(result).toEqual([
      'Global gate',
      'Global movement gate',
      'Project gate',
      'Project movement gate',
      'YAML gate',
    ]);
  });

  it('returns YAML gates only when other movements are specified in overrides', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: PieceOverrides = {
      movements: {
        review: {
          qualityGates: ['Review gate'],
        },
      },
    };
    const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, undefined);
    expect(result).toEqual(['YAML gate']); // No override for 'implement', only for 'review'
  });

  describe('deduplication', () => {
    it('removes duplicate gates from multiple sources', () => {
      const yamlGates = ['Test 1', 'Test 2'];
      const globalOverrides: PieceOverrides = {
        qualityGates: ['Test 2', 'Test 3'],
      };
      const projectOverrides: PieceOverrides = {
        qualityGates: ['Test 1', 'Test 4'],
      };
      const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, globalOverrides);
      // Duplicates removed: Test 1, Test 2 appear only once
      expect(result).toEqual(['Test 2', 'Test 3', 'Test 1', 'Test 4']);
    });

    it('removes duplicate gates from single source', () => {
      const projectOverrides: PieceOverrides = {
        qualityGates: ['Test 1', 'Test 2', 'Test 1', 'Test 3', 'Test 2'],
      };
      const result = applyQualityGateOverrides('implement', undefined, true, projectOverrides, undefined);
      expect(result).toEqual(['Test 1', 'Test 2', 'Test 3']);
    });

    it('removes duplicate gates from YAML and overrides', () => {
      const yamlGates = ['npm run test', 'npm run lint'];
      const projectOverrides: PieceOverrides = {
        qualityGates: ['npm run test', 'npm run build'],
      };
      const result = applyQualityGateOverrides('implement', yamlGates, true, projectOverrides, undefined);
      // 'npm run test' appears only once
      expect(result).toEqual(['npm run test', 'npm run build', 'npm run lint']);
    });
  });
});
