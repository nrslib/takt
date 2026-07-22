import { describe, expect, it } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import type { WorkflowState } from '../core/models/types.js';

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd());
}

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

function makeLedgerWithOptionalFields(): FindingLedger {
  const observedAt = {
    runId: 'run-1',
    stepName: 'reviewers',
    timestamp: '2026-06-13T01:00:00.000Z',
  };
  return {
    ...makeEmptyLedger(),
    nextId: 3,
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'medium',
        title: 'Missing optional fields',
        reviewers: ['reviewer'],
        rawFindingIds: ['raw-1'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      },
      {
        id: 'F-0002',
        status: 'open',
        lifecycle: 'new',
        severity: 'medium',
        title: 'Populated optional fields',
        location: 'value',
        description: 'value',
        suggestion: 'value',
        reviewers: ['reviewer'],
        rawFindingIds: ['raw-2'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      },
    ],
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
  return { state };
}

describe('Finding Contract integration flow', () => {
  it('should normalize optional open item fields as own properties', () => {
    const context = buildFindingsRuleContext(makeLedgerWithOptionalFields());
    const item = context.open.items[0]!;

    expect(Object.hasOwn(item, 'location')).toBe(true);
    expect(Object.hasOwn(item, 'description')).toBe(true);
    expect(Object.hasOwn(item, 'suggestion')).toBe(true);
    expect(item).toMatchObject({
      location: undefined,
      description: undefined,
      suggestion: undefined,
    });
  });

  it.each(['location', 'description', 'suggestion'] as const)(
    'should evaluate missing and populated %s values through every access form',
    (field) => {
      const state = makeState(buildFindingsRuleContext(makeLedgerWithOptionalFields()));

      expect(evaluateWhenExpression(
        `exists(findings.open.items, item.${field} == "value")`,
        state,
      )).toBe(true);
      expect(evaluateWhenExpression(
        `findings.open.items[0].${field} == null`,
        state,
      )).toBe(false);
      expect(evaluateWhenExpression(
        `findings.open.items.${field}.length == 2`,
        state,
      )).toBe(true);
      expect(evaluateWhenExpression(
        `findings.open.items.${field}[1] == "value"`,
        state,
      )).toBe(true);
    },
  );

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
            { condition: 'when(findings.open.count == 0)', next: 'COMPLETE' },
            { condition: 'when(findings.open.bySeverity.high > 0)', next: 'fix' },
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
        waivedFindings: [],
        disputeNotes: [],
        invalidatedFindings: [],
        duplicateFindings: [],
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

    const result = new RuleEvaluator(workflow.steps[0]!, ctx).evaluate(undefined);

    expect(workflow.findingContract).toEqual(expect.objectContaining({
      ledgerPath: '.takt/findings/peer-review.json',
    }));
    expect(result).toEqual({ index: 1, method: 'auto_select' });
  });
});
