import { describe, expect, it } from 'vitest';
import { WorkflowRuleSchema } from '../core/models/workflow-schemas.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { makeStep } from './engine-test-helpers.js';

describe('workflow rule effects', () => {
  it('normalizes and exposes only the selected rule effects', () => {
    const raw = WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [{
        type: 'capture_artifacts',
        allowed_patterns: ['specs/phase-*/plan.md'],
        required_basenames: ['plan.md'],
        same_parent: true,
      }],
    });
    const rule = normalizeRule(raw);
    const step = makeStep('plan', { rules: [rule] });

    expect(determineRuleTransition(step, 0)).toEqual({
      nextStep: 'plan-review',
      effects: [{
        type: 'capture_artifacts',
        allowedPatterns: ['specs/phase-*/plan.md'],
        requiredBasenames: ['plan.md'],
        sameParent: true,
      }],
    });
  });

  it('rejects unknown or incomplete effect contracts', () => {
    expect(() => WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [{ type: 'capture_artifacts' }],
    })).toThrow();
    expect(() => WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [{ type: 'shell', command: 'git add -A' }],
    })).toThrow();
  });
});
