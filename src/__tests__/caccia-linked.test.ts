import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { WorkflowStepRawSchema } from '../core/models/index.js';
import type { WorkflowEffect } from '../core/models/types.js';
import { validateSystemEffectPayload } from '../core/workflow/system/system-step-effect-runner.js';
import { normalizeWorkflowEffects } from '../infra/config/loaders/workflowSystemStepNormalizer.js';

const step = {
  name: 'review_external', kind: 'system',
  rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
};

describe('Caccia system effect input', () => {
  it.each(['"{context:identify.pr.number}"', "'{context:identify.pr.number}'"])(
    'accepts a full context reference from YAML scalar %s', (scalar) => {
      const parsed = WorkflowStepRawSchema.parse({ ...step, effects: [parse(`type: caccia\npr: ${scalar}`)] });
      expect(normalizeWorkflowEffects(parsed.effects)).toEqual([{ type: 'caccia', pr: '{context:identify.pr.number}' }]);
    },
  );
  it.each([123, '{context:identify.pr.number}', '{structured:identify.number}', '{effect:identify.enqueue_task.pr}'])(
    'accepts and normalizes PR input %j', (pr) => {
      const effects = [{ type: 'caccia', pr }];
      const parsed = WorkflowStepRawSchema.parse({ ...step, effects });
      expect(normalizeWorkflowEffects(parsed.effects)).toEqual(effects);
    },
  );

  it.each([
    { type: 'caccia' },
    { type: 'caccia', pr: 0 },
    { type: 'caccia', pr: -1 },
    { type: 'caccia', pr: 1.5 },
    { type: 'caccia', pr: '123' },
    { type: 'caccia', pr: 'PR {context:identify.pr.number}' },
    { type: 'caccia', pr: '{context:identify.pr.number' },
    { type: 'caccia', pr: 123, enabled: true },
  ])('rejects invalid effect %j at the schema boundary', (effect) => {
    expect(WorkflowStepRawSchema.safeParse({ ...step, effects: [effect] }).success).toBe(false);
  });

  // スキーマの実装前にも参照解決後の検証を独立して観測する。
  const effect = { type: 'caccia', pr: '{context:identify.pr.number}' } as unknown as WorkflowEffect;

  it.each([1, 123, Number.MAX_SAFE_INTEGER])('accepts resolved positive safe PR number %j', (pr) => {
    expect(() => validateSystemEffectPayload(effect, { pr })).not.toThrow();
  });

  it.each([undefined, null, '123', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}])(
    'rejects resolved invalid PR number %j before dispatch', (pr) => {
      expect(() => validateSystemEffectPayload(effect, { pr })).toThrow();
    },
  );
});
