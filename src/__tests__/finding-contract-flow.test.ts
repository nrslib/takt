import { describe, expect, it } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import type { WorkflowState } from '../core/models/types.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd(), new Map());
}

function makeEmptyLedger(): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
    updatedAt: '2026-06-13T00:00:00.000Z',
  };
}

function makeLedgerWithOptionalFields(): FindingLedger {
  const observedAt = {
    runId: 'run-1',
    stepName: 'reviewers',
    timestamp: '2026-06-13T01:00:00.000Z',
  };
  const missingRaw = canonicalRawFindingFixture({
    rawFindingId: 'raw-1',
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'medium',
    title: 'Missing optional fields',
    description: 'Missing optional fields',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/missing.ts'] },
    evidence: [],
  });
  const populatedRaw = canonicalRawFindingFixture({
    rawFindingId: 'raw-2',
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'medium',
    title: 'Populated optional fields',
    description: 'value',
    suggestion: 'value',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/value.ts'] },
    evidence: [],
  });
  const evidencePayload = {
    kind: 'file_quote' as const,
    path: 'src/value.ts',
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: 'value',
    snapshotId: 'a'.repeat(64),
    claimIdentityHash: populatedRaw.claimIdentityHash,
    fileHash: 'b'.repeat(64),
  };
  const evidenceRecord = {
    evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
    ...evidencePayload,
  };
  return {
    ...makeEmptyLedger(),
    nextId: 3,
    evidenceRecords: [evidenceRecord],
    rawFindings: [missingRaw, populatedRaw],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'medium',
        title: 'Missing optional fields',
        target: missingRaw.target,
        targetIdentityHash: missingRaw.targetIdentityHash,
        claimIdentityHash: missingRaw.claimIdentityHash,
        semanticClaimIdentityHash: missingRaw.semanticClaimIdentityHash,
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: ['raw-1'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      },
      {
        id: 'F-0002',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'medium',
        title: 'Populated optional fields',
        target: populatedRaw.target,
        targetIdentityHash: populatedRaw.targetIdentityHash,
        claimIdentityHash: populatedRaw.claimIdentityHash,
        semanticClaimIdentityHash: populatedRaw.semanticClaimIdentityHash,
        evidenceIds: [evidenceRecord.evidenceId],
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

    expect(Object.hasOwn(item, 'locations')).toBe(true);
    expect(Object.hasOwn(item, 'description')).toBe(true);
    expect(Object.hasOwn(item, 'suggestion')).toBe(true);
    expect(item).toMatchObject({
      locations: [],
      description: undefined,
      suggestion: undefined,
    });
  });

  it.each(['description', 'suggestion'] as const)(
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

  it('should evaluate locations through the canonical list field', () => {
    const state = makeState(buildFindingsRuleContext(makeLedgerWithOptionalFields()));

    expect(evaluateWhenExpression(
      'exists(findings.open.items, item.locations.length == 1)',
      state,
    )).toBe(true);
    expect(evaluateWhenExpression(
      'findings.open.items[0].locations.length == 0',
      state,
    )).toBe(true);
    expect(evaluateWhenExpression(
      'findings.open.items.locations.length == 2',
      state,
    )).toBe(true);
  });

  it('should route from normalized finding_contract through reconciled ledger findings without Phase 3 AI judge', async () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow',
      finding_contract: {
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
    const rawFinding = canonicalRawFindingFixture({
      rawFindingId: 'raw-security-1',
      familyTag: 'security',
      stepName: 'security-review',
      reviewer: 'security-reviewer',
      severity: 'high' as const,
      title: 'Secret is logged',
      description: 'The code logs a token.',
      suggestion: 'Mask the token before logging.',
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/secret.ts'] },
      evidence: [],
    });
    const ledger = reconcileFindingLedger({
      previousLedger: makeEmptyLedger(),
      rawFindings: [rawFinding],
      managerOutput: {
        anchorAdjudications: [createAnchorAdjudication({
          rawFindingId: rawFinding.rawFindingId,
          decision: 'new',
          anchorRelevance: 'not_applicable',
          evidence: 'The code target does not require anchor adjudication.',
        })],
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
        dismissedFindings: [],
      },
      entityProvisionalMutations: [],
      terminalEntityAttachmentFindingIds: new Set(),
      provisionalFindings: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      rawProvenanceByRawFindingId: new Map([[
        rawFinding.rawFindingId,
        storedRawReconcileProvenance(
          rawFinding,
          computeReviewerStableKey({
            workflowName: 'peer-review',
            callNamespace: '',
            parentStepName: 'peer-review',
            reviewerPersonaKey: rawFinding.reviewer,
          }),
          computeLineageKey({
            claimIdentityHash: rawFinding.claimIdentityHash,
          }),
        ),
      ]]),
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
    }));
    expect(result).toEqual({ index: 1, method: 'auto_select' });
  });
});
