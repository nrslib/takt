import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/index.js';

describe('workflow promotion runtime.yaml boundary', () => {
  it('accepts `{at:N}` entries that advance the runtime ladder', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ at: 3 }, { at: 6 }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a bare promotion entry', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{}],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0] }),
      ]));
    }
  });

  it('rejects provider/model/options targets and conditions', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ at: 3, model: 'gpt-5.5' }, { condition: 'ai("escalate")' }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['promotion', 0, 'model'],
          message: expect.stringContaining('runtime.yaml'),
        }),
        expect.objectContaining({
          path: ['promotion', 1, 'condition'],
          message: expect.stringContaining('runtime.yaml'),
        }),
      ]));
    }
  });
});
