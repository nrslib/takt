import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema, WorkflowRuleSchema } from '../core/models/workflow-schemas.js';
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

  it('rejects an incomplete capture effect contract', () => {
    expect(() => WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [{ type: 'capture_artifacts' }],
    })).toThrow();
  });

  it('rejects an unknown effect contract', () => {
    expect(() => WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [{ type: 'shell', command: 'git add -A' }],
    })).toThrow();
  });

  it('rejects duplicate effect types that would overwrite the result binding', () => {
    const capture = {
      type: 'capture_artifacts',
      allowed_patterns: ['specs/phase-*/plan.md'],
      required_basenames: ['plan.md'],
      same_parent: true,
    };
    expect(() => WorkflowRuleSchema.parse({
      condition: 'plan ready',
      next: 'plan-review',
      effects: [capture, capture],
    })).toThrow(/Duplicate effect type/);
  });

  it('requires exactly one commit manifest source', () => {
    const baseRule = { condition: 'Go', next: 'COMPLETE' };
    expect(() => WorkflowRuleSchema.parse({
      ...baseRule,
      effects: [{ type: 'commit_artifacts', message: 'approve' }],
    })).toThrow(/exactly one/);
    expect(() => WorkflowRuleSchema.parse({
      ...baseRule,
      effects: [{
        type: 'commit_artifacts',
        manifest: '{effect:plan.capture_artifacts.manifest}',
        manifest_path: '.takt/state/plan-artifacts.json',
        message: 'approve',
      }],
    })).toThrow(/exactly one/);
  });

  it('requires an explicit workflow capability before rule effects can execute', () => {
    const workflow = {
      name: 'rule-effects-capability',
      steps: [{
        name: 'plan',
        persona: 'planner',
        instruction: 'plan',
        rules: [{
          condition: 'ready',
          next: 'COMPLETE',
          effects: [{
            type: 'capture_artifacts',
            allowed_patterns: ['specs/phase-*/plan.md'],
            required_basenames: ['plan.md'],
            same_parent: true,
          }],
        }],
      }],
    };

    expect(() => WorkflowConfigRawSchema.parse(workflow)).toThrow(/requires\.rule_effects/);
    expect(() => WorkflowConfigRawSchema.parse({
      ...workflow,
      requires: { rule_effects: 1 },
    })).not.toThrow();
  });

  it('rejects rule effects on parallel sub-steps because they have no transition executor', () => {
    expect(() => WorkflowConfigRawSchema.parse({
      name: 'parallel-rule-effects',
      requires: { rule_effects: 1 },
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'review',
        parallel: [{
          name: 'security',
          persona: 'security-reviewer',
          instruction: 'review security',
          rules: [{
            condition: 'Go',
            next: 'COMPLETE',
            effects: [{
              type: 'capture_artifacts',
              allowed_patterns: ['specs/phase-*/plan.md'],
              required_basenames: ['plan.md'],
              same_parent: true,
            }],
          }],
        }],
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    })).toThrow(/parallel sub-step rules do not support effects/);
  });

  it('rejects rule effects on workflow-call parallel sub-steps', () => {
    expect(() => WorkflowConfigRawSchema.parse({
      name: 'parallel-workflow-call-effects',
      requires: { rule_effects: 1 },
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'review',
        parallel: [{
          name: 'child',
          kind: 'workflow_call',
          call: 'child-workflow',
          rules: [{
            condition: 'COMPLETE',
            next: 'COMPLETE',
            effects: [{
              type: 'commit_artifacts',
              manifest_path: '.takt/state/plan-artifacts.json',
              message: 'approve',
            }],
          }],
        }],
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    })).toThrow(/parallel sub-step rules do not support effects/);
  });
});
