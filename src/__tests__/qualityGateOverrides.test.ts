/**
 * Tests for quality gate override logic
 */

import { describe, it, expect } from 'vitest';
import { applyQualityGateOverrides } from '../infra/config/loaders/qualityGateOverrides.js';
import type { WorkflowOverrides } from '../core/models/config-types.js';

type ApplyOverridesArgs = [
  string,
  string[] | undefined,
  boolean | undefined,
  string | undefined,
  WorkflowOverrides | undefined,
  WorkflowOverrides | undefined,
];

function applyOverrides(...args: ApplyOverridesArgs): string[] | undefined {
  return applyQualityGateOverrides(...args);
}

describe('applyQualityGateOverrides', () => {
  it('returns undefined when no gates are defined', () => {
    const result = applyOverrides('implement', undefined, true, undefined, undefined, undefined);
    expect(result).toBeUndefined();
  });

  it('returns YAML gates when no overrides are defined', () => {
    const yamlGates = ['Test passes'];
    const result = applyOverrides('implement', yamlGates, true, undefined, undefined, undefined);
    expect(result).toEqual(['Test passes']);
  });

  it('returns empty array when yamlGates is empty array and no overrides', () => {
    const yamlGates: string[] = [];
    const result = applyOverrides('implement', yamlGates, true, undefined, undefined, undefined);
    expect(result).toEqual([]);
  });

  it('merges global override gates with YAML gates (additive)', () => {
    const yamlGates = ['Unit tests pass'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['E2E tests pass'],
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, undefined, globalOverrides);
    expect(result).toEqual(['E2E tests pass', 'Unit tests pass']);
  });

  it('applies step-specific override from global config', () => {
    const yamlGates = ['Unit tests pass'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['Global gate'],
      steps: {
        implement: {
          qualityGates: ['Step-specific gate'],
        },
      },
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, undefined, globalOverrides);
    expect(result).toEqual(['Global gate', 'Step-specific gate', 'Unit tests pass']);
  });

  it('applies project overrides with higher priority than global', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['Global gate'],
    };
    const projectOverrides: WorkflowOverrides = {
      qualityGates: ['Project gate'],
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, globalOverrides);
    expect(result).toEqual(['Global gate', 'Project gate', 'YAML gate']);
  });

  it('applies step-specific override from project config', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: WorkflowOverrides = {
      steps: {
        implement: {
          qualityGates: ['Project step gate'],
        },
      },
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, undefined);
    expect(result).toEqual(['Project step gate', 'YAML gate']);
  });

  it('filters global gates when qualityGatesEditOnly=true and edit=false', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['Global gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyOverrides('review', yamlGates, false, undefined, undefined, globalOverrides);
    expect(result).toEqual(['YAML gate']); // Global gate excluded because edit=false
  });

  it('includes global gates when qualityGatesEditOnly=true and edit=true', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['Global gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, undefined, globalOverrides);
    expect(result).toEqual(['Global gate', 'YAML gate']);
  });

  it('filters project global gates when qualityGatesEditOnly=true and edit=false', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: WorkflowOverrides = {
      qualityGates: ['Project gate'],
      qualityGatesEditOnly: true,
    };
    const result = applyOverrides('review', yamlGates, false, undefined, projectOverrides, undefined);
    expect(result).toEqual(['YAML gate']); // Project gate excluded because edit=false
  });

  it('applies step-specific gates regardless of qualityGatesEditOnly flag', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: WorkflowOverrides = {
      qualityGates: ['Project global gate'],
      qualityGatesEditOnly: true,
      steps: {
        review: {
          qualityGates: ['Review-specific gate'],
        },
      },
    };
    const result = applyOverrides('review', yamlGates, false, undefined, projectOverrides, undefined);
    // Project global gate excluded (edit=false), but step-specific gate included
    expect(result).toEqual(['Review-specific gate', 'YAML gate']);
  });

  it('handles complex priority scenario with all override types', () => {
    const yamlGates = ['YAML gate'];
    const globalOverrides: WorkflowOverrides = {
      qualityGates: ['Global gate'],
      steps: {
        implement: {
          qualityGates: ['Global step gate'],
        },
      },
    };
    const projectOverrides: WorkflowOverrides = {
      qualityGates: ['Project gate'],
      steps: {
        implement: {
          qualityGates: ['Project step gate'],
        },
      },
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, globalOverrides);
    expect(result).toEqual([
      'Global gate',
      'Global step gate',
      'Project gate',
      'Project step gate',
      'YAML gate',
    ]);
  });

  it('returns YAML gates only when other steps are specified in overrides', () => {
    const yamlGates = ['YAML gate'];
    const projectOverrides: WorkflowOverrides = {
      steps: {
        review: {
          qualityGates: ['Review gate'],
        },
      },
    };
    const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, undefined);
    expect(result).toEqual(['YAML gate']); // No override for 'implement', only for 'review'
  });

  describe('persona overrides', () => {
    it('applies persona-specific gates from global and project configs in order', () => {
      // Given: both global and project configs define gates for the same persona
      const yamlGates = ['YAML gate'];
      const globalOverrides = {
        personas: {
          coder: {
            qualityGates: ['Global persona gate'],
          },
        },
      } as WorkflowOverrides;
      const projectOverrides = {
        personas: {
          coder: {
            qualityGates: ['Project persona gate'],
          },
        },
      } as WorkflowOverrides;

      // When: the step is executed with the matching persona
      const result = applyOverrides('implement', yamlGates, true, 'coder', projectOverrides, globalOverrides);

      // Then: gates are additive with global persona gates before project persona gates
      expect(result).toEqual(['Global persona gate', 'Project persona gate', 'YAML gate']);
    });

    it('does not apply persona-specific gates when persona does not match', () => {
      // Given: config defines gates for reviewer persona only
      const yamlGates = ['YAML gate'];
      const projectOverrides = {
        personas: {
          reviewer: {
            qualityGates: ['Reviewer persona gate'],
          },
        },
      } as WorkflowOverrides;

      // When: step persona is coder
      const result = applyOverrides('implement', yamlGates, true, 'coder', projectOverrides, undefined);

      // Then: only YAML gates remain
      expect(result).toEqual(['YAML gate']);
    });

    it('deduplicates gates across step, persona, and YAML sources', () => {
      // Given: same gate appears in multiple override layers
      const yamlGates = ['Shared gate', 'YAML only'];
      const globalOverrides = {
        steps: {
          implement: {
            qualityGates: ['Shared gate', 'Global step only'],
          },
        },
        personas: {
          coder: {
            qualityGates: ['Shared gate', 'Global persona only'],
          },
        },
      } as WorkflowOverrides;
      const projectOverrides = {
        personas: {
          coder: {
            qualityGates: ['Shared gate', 'Project persona only'],
          },
        },
      } as WorkflowOverrides;

      // When: overrides are merged for matching step + persona
      const result = applyOverrides('implement', yamlGates, true, 'coder', projectOverrides, globalOverrides);

      // Then: duplicates are removed, first appearance order is preserved
      expect(result).toEqual([
        'Shared gate',
        'Global step only',
        'Global persona only',
        'Project persona only',
        'YAML only',
      ]);
    });

    it('throws when personaName is empty', () => {
      const projectOverrides = {
        personas: {
          coder: {
            qualityGates: ['Project persona gate'],
          },
        },
      } as WorkflowOverrides;
      expect(() =>
        applyOverrides('implement', ['YAML gate'], true, '   ', projectOverrides, undefined)
      ).toThrow('Invalid persona name for step "implement": empty value');
    });
  });

  describe('deduplication', () => {
    it('removes duplicate gates from multiple sources', () => {
      const yamlGates = ['Test 1', 'Test 2'];
      const globalOverrides: WorkflowOverrides = {
        qualityGates: ['Test 2', 'Test 3'],
      };
      const projectOverrides: WorkflowOverrides = {
        qualityGates: ['Test 1', 'Test 4'],
      };
      const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, globalOverrides);
      // Duplicates removed: Test 1, Test 2 appear only once
      expect(result).toEqual(['Test 2', 'Test 3', 'Test 1', 'Test 4']);
    });

    it('removes duplicate gates from single source', () => {
      const projectOverrides: WorkflowOverrides = {
        qualityGates: ['Test 1', 'Test 2', 'Test 1', 'Test 3', 'Test 2'],
      };
      const result = applyOverrides('implement', undefined, true, undefined, projectOverrides, undefined);
      expect(result).toEqual(['Test 1', 'Test 2', 'Test 3']);
    });

    it('removes duplicate gates from YAML and overrides', () => {
      const yamlGates = ['npm run test', 'npm run lint'];
      const projectOverrides: WorkflowOverrides = {
        qualityGates: ['npm run test', 'npm run build'],
      };
      const result = applyOverrides('implement', yamlGates, true, undefined, projectOverrides, undefined);
      // 'npm run test' appears only once
      expect(result).toEqual(['npm run test', 'npm run build', 'npm run lint']);
    });
  });
});
