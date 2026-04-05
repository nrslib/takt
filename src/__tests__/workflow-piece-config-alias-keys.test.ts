/**
 * Workflow YAML user-facing key aliases (steps / initial_step / max_steps, parallel `step`).
 * Spec: task order + plan for builtin workflow key renames (#571 / rename-builtin-workflow-keys).
 *
 * - `steps` / `initial_step` preprocess: covered here.
 * - `max_steps`, parallel child `step`, category `workflow_categories` / `workflows`: implemented in schemas + pieceCategories.
 */

import { describe, it, expect } from 'vitest';
import { PieceConfigRawSchema } from '../core/models/index.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';

const minimalStep = {
  name: 'plan',
  persona: 'coder',
  instruction: '{task}',
  rules: [{ condition: 'done', next: 'COMPLETE' }],
};

describe('PieceConfigRawSchema steps / initial_step alias (normalizePieceConfigAliases)', () => {
  it('should parse when only steps and initial_step are set', () => {
    // Given: canonical user-facing keys without legacy movements / initial_movement
    const raw = {
      name: 'wf-steps-only',
      steps: [minimalStep],
      initial_step: 'plan',
    };

    // When
    const result = PieceConfigRawSchema.parse(raw);

    // Then
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]?.name).toBe('plan');
    expect(result.initial_movement).toBe('plan');
    expect(Object.prototype.hasOwnProperty.call(result, 'steps')).toBe(false);
  });

  it('should reject when steps and movements disagree', () => {
    const raw = {
      name: 'wf-steps-movements-conflict',
      steps: [{ ...minimalStep, name: 'a' }],
      movements: [{ ...minimalStep, name: 'b' }],
    };

    expect(() => PieceConfigRawSchema.parse(raw)).toThrow(/steps.*movements|movements.*steps|Workflow definition conflict/i);
  });

  it('should reject when initial_step and initial_movement disagree', () => {
    const raw = {
      name: 'wf-initial-conflict',
      movements: [minimalStep],
      initial_movement: 'plan',
      initial_step: 'other',
    };

    expect(() => PieceConfigRawSchema.parse(raw)).toThrow(
      /initial_step.*initial_movement|initial_movement.*initial_step|Workflow definition conflict/i,
    );
  });

  it('should accept when steps and movements are equal', () => {
    const raw = {
      name: 'wf-steps-movements-same',
      steps: [minimalStep],
      movements: [minimalStep],
      initial_step: 'plan',
      initial_movement: 'plan',
    };

    const result = PieceConfigRawSchema.parse(raw);

    expect(result.movements).toHaveLength(1);
    expect(result.max_movements).toBe(10);
  });
});

describe('normalizePieceConfig steps / initial_step end-to-end', () => {
  it('should surface movements and initialMovement from steps-only raw config', () => {
    const raw = {
      name: 'wf-norm-steps',
      steps: [minimalStep],
      initial_step: 'plan',
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.movements).toHaveLength(1);
    expect(config.movements[0]?.name).toBe('plan');
    expect(config.initialMovement).toBe('plan');
  });
});

describe('PieceConfigRawSchema max_steps alias', () => {
  it('should treat max_steps as max_movements when only max_steps is set', () => {
    const raw = {
      name: 'wf-max-steps',
      max_steps: 7,
      movements: [minimalStep],
    };

    const result = PieceConfigRawSchema.parse(raw);

    expect(result.max_movements).toBe(7);
  });

  it('should accept max_steps and max_movements when they match', () => {
    const raw = {
      name: 'wf-max-both',
      max_steps: 12,
      max_movements: 12,
      movements: [minimalStep],
    };

    const result = PieceConfigRawSchema.parse(raw);

    expect(result.max_movements).toBe(12);
    expect(Object.prototype.hasOwnProperty.call(result, 'max_steps')).toBe(false);
  });

  it('should reject when max_steps and max_movements disagree', () => {
    const raw = {
      name: 'wf-max-conflict',
      max_steps: 5,
      max_movements: 9,
      movements: [minimalStep],
    };

    expect(() => PieceConfigRawSchema.parse(raw)).toThrow(
      /max_steps.*max_movements|max_movements.*max_steps|Workflow definition conflict/i,
    );
  });
});

describe('PieceConfigRawSchema parallel sub-step alias', () => {
  it('should accept parallel child objects that use step instead of name', () => {
    const raw = {
      name: 'wf-parallel-step',
      movements: [
        {
          name: 'review',
          parallel: [
            {
              step: 'arch-review',
              persona: 'arch.md',
              instruction: 'Review architecture',
            },
            {
              step: 'sec-review',
              persona: 'sec.md',
              instruction: 'Review security',
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      initial_movement: 'review',
    };

    const result = PieceConfigRawSchema.parse(raw);

    const parallel = result.movements[0]?.parallel;
    expect(parallel).toHaveLength(2);
    expect(parallel?.[0]?.name).toBe('arch-review');
    expect(parallel?.[1]?.name).toBe('sec-review');
  });

  it('should reject parallel child when step and name disagree', () => {
    const raw = {
      name: 'wf-parallel-step-name-conflict',
      movements: [
        {
          name: 'review',
          parallel: [
            {
              name: 'arch-review',
              step: 'other-review',
              persona: 'arch.md',
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      initial_movement: 'review',
    };

    expect(() => PieceConfigRawSchema.parse(raw)).toThrow(/step.*name|name.*step|conflict/i);
  });
});

describe('normalizePieceConfig max_steps end-to-end', () => {
  it('should surface max_steps as maxMovements on PieceConfig', () => {
    const raw = {
      name: 'wf-e2e-max-steps',
      max_steps: 4,
      movements: [minimalStep],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.maxMovements).toBe(4);
  });
});
