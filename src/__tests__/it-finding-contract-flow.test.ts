import { describe, expect, it, vi } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import type { WorkflowState } from '../core/models/types.js';

function makeEmptyLedger(): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 1,
    findings: [],
    rawFindings: [],
    conflicts: [],
    updatedAt: '2026-06-13T00:00:00.000Z',
  };
}

function makeState(findings: ReturnType<typeof buildFindingsRuleContext>): WorkflowState & {
  findings: ReturnType<typeof buildFindingsRuleContext>;
} {
  return {
    workflowName: 'finding-contract-workflow',
    currentStep: 'peer-review',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
    findings,
  };
}

function makeContext(state: WorkflowState): RuleEvaluatorContext {
  return {
    state,
    cwd: '/tmp/project',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {
      evaluateCondition: vi.fn().mockRejectedValue(new Error('AI judge should not run when findings rules decide')),
    } as RuleEvaluatorContext['structuredCaller'],
  };
}

describe('Finding Contract integration flow', () => {
  it('should route from normalized finding_contract through reconciled ledger findings without Phase 3 AI judge', async () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      },
      initial_step: 'peer-review',
      max_steps: 3,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review.',
          rules: [
            { when: 'findings.open.count == 0', next: 'COMPLETE' },
            { when: 'findings.open.bySeverity.high > 0', next: 'fix' },
          ],
        },
      ],
    }, '/tmp/project');
    const ledger = reconcileFindingLedger({
      previousLedger: makeEmptyLedger(),
      rawFindings: [
        {
          rawFindingId: 'raw-security-1',
          familyTag: 'security',
          stepName: 'security-review',
          reviewer: 'security-reviewer',
          severity: 'high',
          title: 'Secret is logged',
          location: 'src/secret.ts:12',
          description: 'The code logs a token.',
          suggestion: 'Mask the token before logging.',
        },
      ],
      managerOutput: {
        matches: [],
        newFindings: [
          {
            rawFindingIds: ['raw-security-1'],
            title: 'Secret is logged',
            severity: 'high',
          },
        ],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
      },
      context: {
        workflowName: 'peer-review',
        stepName: 'peer-review',
        runId: 'run-1',
        timestamp: '2026-06-13T01:00:00.000Z',
      },
    });
    const state = makeState(buildFindingsRuleContext(ledger));
    const ctx = makeContext(state);

    const result = await new RuleEvaluator(workflow.steps[0]!, ctx).evaluate('', '');

    expect(workflow.findingContract).toEqual(expect.objectContaining({
      ledgerPath: '.takt/findings/peer-review.json',
    }));
    expect(result).toEqual({ index: 1, method: 'auto_select' });
    expect(ctx.structuredCaller.evaluateCondition).not.toHaveBeenCalled();
  });
});
