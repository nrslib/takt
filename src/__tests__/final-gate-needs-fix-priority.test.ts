import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { resolvePhase3Adoption } from '../core/workflow/evaluation/rule-utils.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

interface RawRule {
  condition: string;
  next?: string;
  return?: string;
}

interface RawWorkflow {
  steps: Array<{
    name: string;
    rules: RawRule[];
  }>;
}

const workflowFiles = [
  'builtins/en/workflows/merge-readiness-finding-contract-final-gate.yaml',
  'builtins/en/workflows/merge-readiness-finding-contract-final-gate-for-local-llm.yaml',
  'builtins/ja/workflows/merge-readiness-finding-contract-final-gate.yaml',
  'builtins/ja/workflows/merge-readiness-finding-contract-final-gate-for-local-llm.yaml',
] as const;

const gateSteps = ['merge-readiness-review', 'supervise'] as const;

function stateWithProvisionalFinding(): WorkflowState {
  return {
    findings: {
      open: {
        count: 1,
        bySeverity: { critical: 0, high: 0, medium: 1, low: 0 },
        items: [{
          id: 'F-0001',
          severity: 'medium',
          title: 'Provisional review finding',
          reviewers: ['reviewer'],
        }],
      },
      resolved: { count: 0 },
      waived: { count: 0 },
      provisional: {
        count: 1,
        fixpoint: false,
        items: [{ id: 'F-0001', kind: 'unverified-location', reason: 'Location requires verification' }],
      },
      rounds: { budgetExhausted: false },
      invalidated: { count: 0 },
      superseded: { count: 0 },
      reviewerAnomalies: { count: 0, budgetExhausted: false },
      conflicts: { count: 0, items: [], unadjudicated: { count: 0 } },
    },
  } as unknown as WorkflowState;
}

describe('finding contract final gate needs_fix priority', () => {
  it.each(workflowFiles)('%s preserves the AI needs_fix decision when provisional findings remain', (relativePath) => {
    const raw = parseYaml(readFileSync(join(process.cwd(), relativePath), 'utf-8')) as RawWorkflow;

    for (const stepName of gateSteps) {
      const step = raw.steps.find((candidate) => candidate.name === stepName);
      expect(step, `${stepName} must exist`).toBeDefined();

      const rules = step!.rules.map(normalizeRule);
      const needsFixIndex = rules.findIndex((rule) => rule.condition === 'needs_fix');
      expect(needsFixIndex, `${stepName} must expose needs_fix`).toBeGreaterThanOrEqual(0);

      const adoption = resolvePhase3Adoption(
        rules,
        { ruleIndex: needsFixIndex, method: 'structured_output' },
        stateWithProvisionalFinding(),
        false,
        evaluateWhenExpression,
      );

      expect(adoption.blocked).toBe(false);
      expect(rules[adoption.result.ruleIndex]?.returnValue).toBe('needs_fix');
    }
  });
});
