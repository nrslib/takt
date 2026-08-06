import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../core/models/types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../core/models/finding-types.js';
import {
  buildFindingEscalationReviewerStep,
  requireEscalationOwnerOutputContractFormat,
  FINDING_ESCALATION_REVIEWER_REPORT_NAME,
} from '../core/workflow/findings/escalation-reviewer-step.js';
import { resolveRestatementPresentationPhase } from '../core/workflow/findings/restatement-presentation-phase.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  listFindingReviewPublications,
  persistFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { FindingContractConfigRawSchema } from '../core/models/finding-schemas.js';
import type { WorkflowStep } from '../core/models/types.js';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import { makeRule, makeStep } from './test-helpers.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import {
  createSharedRuntime,
  createWorkflowEngineServices,
} from '../core/workflow/engine/WorkflowEngineSetup.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: vi.fn().mockResolvedValue({ status: 'unchanged' }),
  };
});

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

const { runFindingEscalationReviewer } = await import(
  '../core/workflow/findings/escalation-reviewer-runner.js'
);

function contractWithEscalationReviewer(
  overrides: Partial<NonNullable<FindingContractConfig['escalationReviewer']>> = {},
): FindingContractConfig {
  return {
    manager: {
      persona: 'findings-manager',
      instruction: 'Manage findings.',
      outputContract: 'Manager output contract.',
    },
    adjudicator: {
      persona: 'supervisor',
      instruction: 'Adjudicate findings.',
    },
    escalationReviewer: {
      persona: 'escalation-supervisor',
      providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      ...overrides,
    },
  };
}

describe('FC escalation reviewer — presentation phase', () => {
  it('spends the restatement budget on the owner and the last presentation on escalation', () => {
    const phases = [0, 1, 2, 3].map((presentedCount) => resolveRestatementPresentationPhase({
      presentedCount,
      presentationLimit: 3,
      escalationReviewerConfigured: true,
    }));

    expect(phases).toEqual(['restatement', 'restatement', 'escalation', 'exhausted']);
  });

  it('escalates the first and only presentation when presentationLimit is 1', () => {
    expect(resolveRestatementPresentationPhase({
      presentedCount: 0,
      presentationLimit: 1,
      escalationReviewerConfigured: true,
    })).toBe('escalation');
  });

  it('keeps every presentation on the owner reviewer when no escalation reviewer is configured', () => {
    const phases = [0, 1, 2, 3].map((presentedCount) => resolveRestatementPresentationPhase({
      presentedCount,
      presentationLimit: 3,
      escalationReviewerConfigured: false,
    }));

    expect(phases).toEqual(['restatement', 'restatement', 'restatement', 'exhausted']);
  });

  it('gives the owner request and the escalation request different identities without changing the digest contract', () => {
    const requestWithoutId = {
      anomalyId: 'RA-ESCALATION',
      presentationOrdinal: 2,
      reviewScopeSnapshotId: '3'.repeat(64),
      sourceExcerptDigest: '4'.repeat(64),
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: ['src/example.ts'],
      missingRequirements: ['description'] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const ownerRequestId = computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: 'architecture-review',
    });
    const escalationRequestId = computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    });

    expect(escalationRequestId).not.toBe(ownerRequestId);
    expect(computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    })).toBe(escalationRequestId);
  });
});

describe('FC escalation reviewer — synthetic step', () => {
  it('builds a read-only reviewer step with a fixed name, routing key and report name', () => {
    const step = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer(),
      ownerOutputContractFormat: 'Owner report format.',
    });

    expect(step).toMatchObject({
      kind: 'agent',
      name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      engineSynthesized: true,
      providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      sessionKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      session: 'refresh',
      edit: false,
      rules: [],
    });
    expect(step.outputContracts).toEqual([{
      name: FINDING_ESCALATION_REVIEWER_REPORT_NAME,
      format: 'Owner report format.',
    }]);
    expect(step.structuredOutput).toBeUndefined();
  });

  it('falls back to the persona body as instruction and keeps a configured output contract', () => {
    const inherited = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer(),
      ownerOutputContractFormat: 'Owner report format.',
    });
    const configured = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer({
        instruction: 'Restate the escalated claims.',
        outputContract: 'Escalation report format.',
      }),
      ownerOutputContractFormat: 'Owner report format.',
    });

    expect(inherited.instruction).toBe('escalation-supervisor');
    expect(configured.instruction).toBe('Restate the escalated claims.');
    expect(configured.outputContracts).toEqual([{
      name: FINDING_ESCALATION_REVIEWER_REPORT_NAME,
      format: 'Escalation report format.',
    }]);
  });

  it('prefers the direct provider/model over the workflow defaults', () => {
    const direct = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer({ provider: 'codex', model: 'gpt-test' }),
      workflowProvider: 'claude',
      workflowModel: 'workflow-model',
      ownerOutputContractFormat: 'Owner report format.',
    });
    const inherited = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer(),
      workflowProvider: 'claude',
      workflowModel: 'workflow-model',
      ownerOutputContractFormat: 'Owner report format.',
    });

    expect(direct).toMatchObject({
      provider: 'codex',
      providerSpecified: true,
      model: 'gpt-test',
      modelSpecified: true,
    });
    expect(inherited).toMatchObject({
      provider: 'claude',
      providerSpecified: false,
      model: 'workflow-model',
      modelSpecified: false,
    });
  });

  it('refuses to build a step when no escalation reviewer is configured', () => {
    expect(() => buildFindingEscalationReviewerStep({
      contract: { manager: contractWithEscalationReviewer().manager },
      ownerOutputContractFormat: 'Owner report format.',
    })).toThrow(/finding_contract\.escalation_reviewer/);
  });

  it('fails loudly when no owner output contract can be inherited', () => {
    expect(() => requireEscalationOwnerOutputContractFormat([
      { kind: 'agent', name: 'review', instruction: 'Review.' } as AgentWorkflowStep,
    ])).toThrow(/output contract/);
  });

  it('routes provider/model through the escalation-reviewer persona key', () => {
    const step = buildFindingEscalationReviewerStep({
      contract: contractWithEscalationReviewer(),
      ownerOutputContractFormat: 'Owner report format.',
    });

    expect(resolveStepProviderModel({
      step,
      provider: 'mock',
      model: 'project-model',
      providerRouting: {
        personas: {
          [FINDING_ESCALATION_REVIEWER_ROUTING_KEY]: { provider: 'codex', model: 'gpt-5' },
          'escalation-supervisor': { provider: 'cursor', model: 'persona-name-model' },
        },
      },
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.personas',
      modelSource: 'provider_routing.personas',
    });
  });
});

describe('FC escalation reviewer — configuration schema', () => {
  it('requires only the persona and rejects unknown fields', () => {
    expect(FindingContractConfigRawSchema.safeParse({
      manager: { persona: 'm', instruction: 'i', output_contract: 'o' },
      escalation_reviewer: { persona: 'escalation-supervisor' },
    }).success).toBe(true);
    expect(FindingContractConfigRawSchema.safeParse({
      manager: { persona: 'm', instruction: 'i', output_contract: 'o' },
      escalation_reviewer: {},
    }).success).toBe(false);
    expect(FindingContractConfigRawSchema.safeParse({
      manager: { persona: 'm', instruction: 'i', output_contract: 'o' },
      escalation_reviewer: { persona: 'escalation-supervisor', unknown_field: true },
    }).success).toBe(false);
  });

  it('normalizes the routing key to escalation-reviewer regardless of the persona name', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'escalation-workflow',
      finding_contract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        // 正規化済み WorkflowConfig を engine が組み立てる際、合成 FC ロールは
        // 事前検証される（CLAUDE.md）。adjudicator を欠くと検証を素通りする
        // 構成をテストが作ってしまう。
        adjudicator: {
          persona: 'supervisor',
          instruction: 'adjudicate-finding-contract',
        },
        escalation_reviewer: {
          persona: 'terminal-supervisor',
          provider: 'codex',
          model: 'gpt-test',
        },
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp/project');

    expect(workflow.findingContract?.escalationReviewer).toEqual({
      persona: 'terminal-supervisor',
      personaDisplayName: 'terminal-supervisor',
      providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      provider: 'codex',
      model: 'gpt-test',
    });
  });

  it('leaves escalationReviewer undefined when the workflow omits it', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'plain-fc-workflow',
      finding_contract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        // 正規化済み WorkflowConfig を engine が組み立てる際、合成 FC ロールは
        // 事前検証される（CLAUDE.md）。adjudicator を欠くと検証を素通りする
        // 構成をテストが作ってしまう。
        adjudicator: {
          persona: 'supervisor',
          instruction: 'adjudicate-finding-contract',
        },
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp/project');

    expect(workflow.findingContract?.escalationReviewer).toBeUndefined();
  });

  it('reserves the escalation-reviewer step name only while the role is configured', () => {
    const workflowRaw = (withEscalationReviewer: boolean) => ({
      name: 'reserved-name-workflow',
      finding_contract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        // 正規化済み WorkflowConfig を engine が組み立てる際、合成 FC ロールは
        // 事前検証される（CLAUDE.md）。adjudicator を欠くと検証を素通りする
        // 構成をテストが作ってしまう。
        adjudicator: {
          persona: 'supervisor',
          instruction: 'adjudicate-finding-contract',
        },
        ...(withEscalationReviewer
          ? { escalation_reviewer: { persona: 'terminal-supervisor' } }
          : {}),
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review.',
          rules: [{ condition: 'done', next: 'escalation-reviewer' }],
        },
        {
          name: 'escalation-reviewer',
          persona: 'reviewer',
          instruction: 'Review again.',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => normalizeWorkflowConfig(workflowRaw(true), '/tmp/project'))
      .toThrow(/step name "escalation-reviewer" is reserved/);
    expect(() => normalizeWorkflowConfig(workflowRaw(false), '/tmp/project')).not.toThrow();
  });

  it('reserves the escalation-reviewer name for parallel sub-steps too', () => {
    expect(() => normalizeWorkflowConfig({
      name: 'reserved-parallel-workflow',
      finding_contract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        // 正規化済み WorkflowConfig を engine が組み立てる際、合成 FC ロールは
        // 事前検証される（CLAUDE.md）。adjudicator を欠くと検証を素通りする
        // 構成をテストが作ってしまう。
        adjudicator: {
          persona: 'supervisor',
          instruction: 'adjudicate-finding-contract',
        },
        escalation_reviewer: { persona: 'terminal-supervisor' },
      },
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [{
        name: 'reviewers',
        parallel: [
          {
            name: 'escalation-reviewer',
            persona: 'reviewer',
            instruction: 'Review.',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
        rules: [{ condition: 'all(done)', next: 'COMPLETE' }],
      }],
    }, '/tmp/project')).toThrow(/step name "escalation-reviewer" is reserved/);
  });
});

describe('FC escalation reviewer — restatement instruction', () => {
  it.each(['en', 'ja'] as const)(
    'tells the %s restatement reviewer to read the target files and request quotes from them',
    (language) => {
      const requestWithoutId = {
        anomalyId: 'RA-ESCALATION',
        reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        presentationOrdinal: 2,
        reviewScopeSnapshotId: '7'.repeat(64),
        sourceExcerptDigest: '8'.repeat(64),
        claimedExcerpt: 'A bounded reviewer claim.',
        targetPaths: ['src/example.ts'],
        missingRequirements: [] as const,
        expectedRelation: 'new' as const,
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent' as const,
      };
      const context = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
        restatementRequests: [{
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        }],
      });
      const instruction = buildFindingContractInstruction({
        contract: {
          ledgerSummary: { findings: [] },
          hasOpenFindings: false,
          hasWaivedFindings: false,
          hasDismissedFindings: false,
          reviewer: {
            mode: 'structured',
            rawFindingsStructuredOutput: { schemaRef: 'test', schema: { type: 'object' } },
            reviewScopeSnapshotId: context.reviewScopeSnapshotId,
            presentationContext: context,
          },
        },
        language,
        renderFencedJsonBlock: (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
      });

      expect(instruction).toContain('file_quote');
      expect(instruction).toContain('verbatimExcerpt');
      expect(instruction).toMatch(language === 'en' ? /Read the request's target files/ : /対象ファイルをリポジトリで実際に読/);
    },
  );

  it('keeps phase 2 restatement-only for the escalation context and loses it for a rebuilt empty one', () => {
    const requestWithoutId = {
      anomalyId: 'RA-PHASE2',
      reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '9'.repeat(64),
      sourceExcerptDigest: 'a'.repeat(64),
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: [] as const,
      missingRequirements: [] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const escalationPresentationContext = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    const reportInstruction = (
      presentationContext: ReturnType<typeof createFindingReviewPresentationContextV2>,
    ) => buildFindingContractReportInstruction({
      contract: {
        ledgerSummary: { findings: [] },
        reportLedgerSummary: { findings: [] },
        hasOpenFindings: false,
        hasWaivedFindings: false,
        hasDismissedFindings: false,
        reviewer: {
          mode: 'structured',
          rawFindingsStructuredOutput: { schemaRef: 'test', schema: { type: 'object' } },
          reviewScopeSnapshotId: presentationContext.reviewScopeSnapshotId,
          presentationContext,
        },
      },
      language: 'en',
      renderFencedJsonBlock: (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    });

    // Phase 1 と同じ context を渡した Phase 2 は restatement-only のまま。
    const escalationReportInstruction = reportInstruction(escalationPresentationContext);
    expect(escalationReportInstruction).toContain('restatement-only review');
    expect(escalationReportInstruction).toContain('RA-PHASE2');
    // reviewer 名から組み直した context（request 0件）は通常レビュー契約へ化ける。
    const rebuiltReportInstruction = reportInstruction(createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
    }));
    expect(rebuiltReportInstruction).not.toContain('restatement-only review');
    expect(rebuiltReportInstruction).toContain('Report every fresh issue you observe');
  });
});

describe('FC escalation reviewer — presentation freeze', () => {
  const reviewerStep: WorkflowStep = {
    name: 'architecture-review',
    persona: 'reviewer',
    instruction: 'Review.',
    outputContracts: [{ name: 'architecture-review', format: 'Owner report format.' }],
    rules: [],
  };
  const reviewScopeSnapshotId = 'b'.repeat(64);
  const structuredStrategy = {
    kind: 'structured',
    reportGeneration: 'structured',
    intake: 'reviewer_structured',
  } as const;

  function makeServices(presentationLimit: number) {
    const cwd = process.cwd();
    const runPaths = buildRunPaths(cwd, `escalation-freeze-${presentationLimit}`);
    // 提示回数の正本は report dir の canonical publication。凍結が効いているかを
    // 見るため、実際に publication を書き込める隔離ディレクトリを使う。
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-escalation-freeze-'));
    const raw = canonicalRawFindingFixture({
      rawFindingId: 'raw-freeze',
      stepName: reviewerStep.name,
      reviewer: reviewerStep.name,
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/example.ts'] },
      rawExcerpt: 'The reviewer claim must be restated.',
      evidence: [],
    });
    const observedAt = {
      runId: 'run-escalation-freeze',
      stepName: reviewerStep.name,
      timestamp: '2026-08-07T00:00:00.000Z',
    };
    const emptyLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: observedAt.timestamp,
      findings: [],
      evidenceRecords: [],
      rawFindings: [raw],
      conflicts: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      ...createEmptyFindingContractRegistries(),
    };
    const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger, [createReviewerAnomalySpec({
      wire: raw,
      canonical: canonicalizeReviewerRawFinding(
        candidateFromStoredRawFinding(raw, 'reviewer-stable-key'),
        { ledger: emptyLedger },
      ).canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'The normalized claim omitted product identity.',
      intakeContract: {
        observationClass: 'claim-bearing',
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['product-identity-incomplete'],
        missingRequirements: ['title'],
        presentationOwnerReviewer: reviewerStep.name,
        presentationLimit,
      },
    })], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());

    const services = createWorkflowEngineServices({
      config: {
        name: 'test-workflow',
        initialStep: reviewerStep.name,
        maxSteps: 10,
        steps: [reviewerStep],
      },
      state: {
        workflowName: 'test-workflow',
        currentStep: reviewerStep.name,
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        restoredStepIterationNames: new Set(),
        dynamicParallelSelections: new Map(),
        resumedDynamicParallelSteps: new Set(),
        status: 'running',
      },
      task: 'test task',
      projectCwd: cwd,
      getCwd: () => cwd,
      getReportDir: () => reportDir,
      getRunPaths: () => runPaths,
      getMaxSteps: () => 10,
      options: {
        projectCwd: cwd,
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      },
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      sharedRuntime: createSharedRuntime(undefined, 10),
      resumeStackPrefix: [],
      runPaths,
      updateMaxSteps: vi.fn(),
      setActiveResumePoint: vi.fn(),
      persistDynamicParallelSelection: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: contractWithEscalationReviewer() as never,
      findingLedgerStore: { loadLedger: () => ledger } as never,
      updatePersonaSession: vi.fn(),
      resolveNextStepFromDone: vi.fn(),
      resetCycleDetector: vi.fn(),
      emitEvent: vi.fn(),
      createEngine: vi.fn(),
    });
    return {
      services,
      reportDir,
      anomalyId: ledger.reviewerAnomalies![0]!.id,
      cleanup: () => rmSync(reportDir, { recursive: true, force: true }),
    };
  }

  /** 指定 reviewer がその anomaly を提示した canonical publication を報告先へ実際に書き込む。 */
  function persistPresentation(input: {
    reportDir: string;
    anomalyId: string;
    presentationOrdinal: number;
    reviewerStepName: string;
    reportName: string;
  }): void {
    const requestWithoutId = {
      anomalyId: input.anomalyId,
      reviewer: input.reviewerStepName,
      presentationOrdinal: input.presentationOrdinal,
      reviewScopeSnapshotId,
      sourceExcerptDigest: 'c'.repeat(64),
      claimedExcerpt: 'The reviewer claim must be restated.',
      targetPaths: ['src/example.ts'],
      missingRequirements: ['title'] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const presentationContext = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    expect(presentationContext.presentedReviewerAnomalyIds).toEqual([input.anomalyId]);
    persistFindingReviewPublication(input.reportDir, {
      publication: createFindingReviewPublication({
        identity: {
          scopeIdentity: 'scope-fc-escalation-freeze',
          callNamespace: '',
          parentStepName: reviewerStep.name,
          stepIteration: 1,
          reviewerStepName: input.reviewerStepName,
          reportName: input.reportName,
        },
        protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
        reportContent: `${input.reviewerStepName} restatement report.`,
        rawFindings: [],
        presentationContext,
      }),
      reviewerExecutionIdentity: { provider: 'codex' },
    });
  }

  function persistOwnerPresentation(input: {
    reportDir: string;
    anomalyId: string;
    presentationOrdinal: number;
  }): void {
    persistPresentation({
      ...input,
      reviewerStepName: reviewerStep.name,
      reportName: 'architecture-review.md',
    });
  }

  function persistEscalationPresentation(input: {
    reportDir: string;
    anomalyId: string;
    presentationOrdinal: number;
  }): void {
    persistPresentation({
      ...input,
      reviewerStepName: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      reportName: `${FINDING_ESCALATION_REVIEWER_REPORT_NAME}.md`,
    });
  }

  it('does not escalate in the same round the owner reviewer spends its (limit-1) presentation', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      const freezeKey = 'freeze-limit-2';

      const ownerContext = services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        structuredStrategy,
        reviewScopeSnapshotId,
        freezeKey,
      );
      const ownerPresentation = ownerContext?.reviewer?.presentationContext;
      // owner が limit-1 回目（ordinal 1）を提示するラウンド。
      expect(ownerPresentation?.revision === 2 && ownerPresentation.restatementRequests).toMatchObject([
        { reviewer: reviewerStep.name, presentationOrdinal: 1 },
      ]);

      // owner の canonical publication が実際に成立した状態を作る。ここで
      // presentation counts を数え直すと presentedCount=1 → ordinal 2 =
      // escalation になり、同じ iteration で二重提示になる。
      persistOwnerPresentation({ reportDir, anomalyId, presentationOrdinal: 1 });
      expect(listFindingReviewPublications(reportDir)[0]!.presentationContext.presentedReviewerAnomalyIds)
        .toEqual([anomalyId]);

      // 凍結した presentation counts を使う限り、同じラウンドでは発火しない。
      expect(services.optionsBuilder.buildFindingEscalationInstructionContext({
        ownerStepNames: [reviewerStep.name],
        reviewScopeSnapshotId,
        findingContractFreezeKey: freezeKey,
      })).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('escalates the only presentation when presentationLimit is 1 and leaves the owner batch empty', () => {
    const { services, cleanup } = makeServices(1);
    try {
      const freezeKey = 'freeze-limit-1';

      const ownerContext = services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        structuredStrategy,
        reviewScopeSnapshotId,
        freezeKey,
      );
      const ownerPresentation = ownerContext?.reviewer?.presentationContext;
      expect(ownerPresentation?.revision === 2 && ownerPresentation.restatementRequests).toEqual([]);

      const escalationContext = services.optionsBuilder.buildFindingEscalationInstructionContext({
        ownerStepNames: [reviewerStep.name],
        reviewScopeSnapshotId,
        findingContractFreezeKey: freezeKey,
      });
      const escalationPresentation = escalationContext?.reviewer?.presentationContext;
      expect(escalationPresentation?.revision === 2 && escalationPresentation.restatementRequests)
        .toMatchObject([
          { reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY, presentationOrdinal: 1 },
        ]);
    } finally {
      cleanup();
    }
  });

  it('re-issues the same escalation request after a round whose publication never landed', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      // owner が limit-1 回目を提示し、その publication だけが成立している状態。
      persistOwnerPresentation({ reportDir, anomalyId, presentationOrdinal: 1 });

      const escalationRequestsForRound = (freezeKey: string) => {
        services.optionsBuilder.buildFindingContractInstructionContext(
          reviewerStep,
          structuredStrategy,
          reviewScopeSnapshotId,
          freezeKey,
        );
        const context = services.optionsBuilder.buildFindingEscalationInstructionContext({
          ownerStepNames: [reviewerStep.name],
          reviewScopeSnapshotId,
          findingContractFreezeKey: freezeKey,
        });
        const presentation = context?.reviewer?.presentationContext;
        return presentation?.revision === 2 ? presentation.restatementRequests : undefined;
      };

      const firstRound = escalationRequestsForRound('freeze-escalation-round-1');
      expect(firstRound).toMatchObject([
        { reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY, presentationOrdinal: 2 },
      ]);

      // このラウンドは escalation publication を成立させずに失敗した想定。
      // report dir には owner の publication しか無いままにする。
      expect(listFindingReviewPublications(reportDir)).toHaveLength(1);

      // 次ラウンドは同じ ordinal・同じ request ID の escalation request を再発行する。
      const secondRound = escalationRequestsForRound('freeze-escalation-round-2');
      expect(secondRound).toEqual(firstRound);
    } finally {
      cleanup();
    }
  });

  it('stops issuing escalation requests once the escalation publication lands', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      persistOwnerPresentation({ reportDir, anomalyId, presentationOrdinal: 1 });
      persistEscalationPresentation({ reportDir, anomalyId, presentationOrdinal: 2 });

      services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        structuredStrategy,
        reviewScopeSnapshotId,
        'freeze-after-escalation',
      );

      expect(services.optionsBuilder.buildFindingEscalationInstructionContext({
        ownerStepNames: [reviewerStep.name],
        reviewScopeSnapshotId,
        findingContractFreezeKey: 'freeze-after-escalation',
      })).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('refuses to build an escalation batch from anything but the frozen input of the same round', () => {
    const { services, cleanup } = makeServices(1);
    try {
      services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        structuredStrategy,
        reviewScopeSnapshotId,
        'freeze-current-round',
      );

      expect(() => services.optionsBuilder.buildFindingEscalationInstructionContext({
        ownerStepNames: [reviewerStep.name],
        reviewScopeSnapshotId,
        findingContractFreezeKey: 'freeze-other-round',
      })).toThrow(/frozen reviewer input of the same review round/);
    } finally {
      cleanup();
    }
  });
});

describe('FC escalation reviewer — direct provider call wiring', () => {
  const escalationContext = {
    ledgerSummary: { findings: [] },
    reportLedgerSummary: { findings: [] },
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    reviewer: {
      mode: 'structured' as const,
      rawFindingsStructuredOutput: { schemaRef: 'takt.findings.raw', schema: { type: 'object' } },
      reviewScopeSnapshotId: '5'.repeat(64),
      presentationContext: {
        revision: 2 as const,
        reviewScopeSnapshotId: '5'.repeat(64),
        restatementRequests: [],
        presentedReviewerAnomalyIds: [],
        contextDigest: '6'.repeat(64),
      },
    },
  };

  const ownerReviewerStep = {
    kind: 'agent' as const,
    name: 'architecture-review',
    instruction: 'Review.',
    outputContracts: [{ name: 'architecture-review', format: 'Owner report format.' }],
  };

  function createRunnerInput(overrides: {
    resumeResult?: unknown;
    prepareResult?: unknown;
    withoutEscalationContext?: boolean;
  } = {}) {
    const recordSynthesizedAgentUsage = vi.fn();
    const prepareFindingReviewPublication = vi.fn().mockResolvedValue(
      overrides.prepareResult ?? { publication: { publicationId: 'pub-escalation' } },
    );
    const stepExecutor = {
      recordSynthesizedAgentUsage,
      resumeFindingReviewPublication: vi.fn().mockResolvedValue(overrides.resumeResult),
      buildInstruction: vi.fn().mockReturnValue('escalation instruction'),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      prepareFindingReviewPublication,
    };
    const optionsBuilder = {
      // 通常レビュアーの Phase 1 と同じ形。allowedTools は provider 既定
      // （undefined）で、permission は profile 解決に委ねられている。
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd: '/repo',
        allowedTools: undefined,
        sessionId: undefined,
        permissionResolution: {
          stepName: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
          requiredPermissionMode: undefined,
          providerProfiles: { mock: { defaultPermissionMode: 'edit' } },
        },
      }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model' }),
    };
    return {
      input: {
        contract: contractWithEscalationReviewer(),
        ...(overrides.withoutEscalationContext === true ? {} : { escalationContext }),
        ownerReviewerSteps: [ownerReviewerStep],
        parentStepName: 'reviewers',
        stepIteration: 1,
        state: { iteration: 1 },
        task: 'Improve the code.',
        maxSteps: 20,
        optionsBuilder,
        stepExecutor,
        updatePersonaSession: vi.fn(),
      } as unknown as Parameters<typeof runFindingEscalationReviewer>[0],
      stepExecutor,
      optionsBuilder,
    };
  }

  beforeEach(() => {
    executeAgentMock.mockReset();
  });

  it('publishes through the ordinary intake pipeline and records synthesized usage', async () => {
    const doneResponse: AgentResponse = {
      persona: 'escalation-supervisor',
      status: 'done',
      content: '{}',
      sessionId: 'session-escalation',
      timestamp: new Date(),
    };
    executeAgentMock.mockResolvedValue(doneResponse);
    const { input, stepExecutor } = createRunnerInput();

    const outcome = await runFindingEscalationReviewer(input);

    expect(outcome).toMatchObject({
      kind: 'published',
      publication: { publicationId: 'pub-escalation' },
    });
    expect(outcome!.step.name).toBe(FINDING_ESCALATION_REVIEWER_ROUTING_KEY);
    expect(outcome!.step.structuredOutput).toBe(
      escalationContext.reviewer.rawFindingsStructuredOutput,
    );
    // 実際に走った attempt の provider/model をそのまま計上する。
    expect(stepExecutor.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY }),
      true,
      undefined,
      { provider: 'mock', model: 'mock-model' },
    );
    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        parentStepName: 'reviewers',
        stepIteration: 1,
        presentationContext: escalationContext.reviewer.presentationContext,
        // Phase 2 が step 名から context を組み直すと restatement-only 契約が
        // 消えるため、Phase 1 と同じ context を明示的に渡す。
        findingContractContext: escalationContext,
        reviewerOutputStrategy: {
          kind: 'structured',
          reportGeneration: 'structured',
          intake: 'reviewer_structured',
        },
      }),
    );
  });

  it('runs phase 1 with read-only tools so it can read the code it must quote', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'escalation-supervisor',
      status: 'done',
      content: '{}',
      timestamp: new Date(),
    } satisfies AgentResponse);
    const { input, optionsBuilder } = createRunnerInput();

    await runFindingEscalationReviewer(input);

    expect(optionsBuilder.buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        edit: false,
        session: 'refresh',
      }),
      undefined,
    );
    const agentOptions = executeAgentMock.mock.calls[0]![2]!;
    // findings-manager の allowedTools: [] は流用しない。読み取りツールが
    // 塞がれると新規の byte-exact 証拠を自作できない。
    expect(agentOptions.allowedTools).toBeUndefined();
    // provider profile が edit を既定にしていても書き込みへ昇格させない。
    expect(agentOptions.permissionMode).toBe('readonly');
    expect(agentOptions).not.toHaveProperty('permissionResolution');
    expect(agentOptions.sessionId).toBeUndefined();
  });

  it('maps a failed phase 1 to a terminal outcome without preparing a publication', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'escalation-supervisor',
      status: 'error',
      content: '',
      error: 'provider exploded',
      timestamp: new Date(),
    } satisfies AgentResponse);
    const { input, stepExecutor } = createRunnerInput();

    const outcome = await runFindingEscalationReviewer(input);

    expect(outcome).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
  });

  it('resumes a stored escalation publication without issuing a provider call', async () => {
    const { input, stepExecutor } = createRunnerInput({
      resumeResult: { publication: { publicationId: 'pub-resumed' }, response: { status: 'done' } },
    });

    const outcome = await runFindingEscalationReviewer(input);

    expect(outcome).toMatchObject({
      kind: 'published',
      publication: { publicationId: 'pub-resumed' },
    });
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
  });

  it('hands a stored escalation publication to the manager even when the budget is spent', async () => {
    // 前ラウンドで publication が成立していれば提示は計上済みで、今ラウンドの
    // escalation request は0件になる。それでも raw findings がまだ intake されて
    // いない可能性があるため、request の有無より先に stored publication を引く。
    const { input, stepExecutor } = createRunnerInput({
      withoutEscalationContext: true,
      resumeResult: { publication: { publicationId: 'pub-carried-over' }, response: { status: 'done' } },
    });

    const outcome = await runFindingEscalationReviewer(input);

    expect(outcome).toMatchObject({
      kind: 'published',
      publication: { publicationId: 'pub-carried-over' },
    });
    expect(stepExecutor.resumeFindingReviewPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        parentStepName: 'reviewers',
        stepIteration: 1,
        step: expect.objectContaining({ name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY }),
      }),
    );
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is neither an escalation request nor a stored publication', async () => {
    const { input, stepExecutor } = createRunnerInput({ withoutEscalationContext: true });

    expect(await runFindingEscalationReviewer(input)).toBeUndefined();
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
  });
});

describe('FC escalation reviewer — caller reaches the runner without a request batch', () => {
  const reviewerSubStep = {
    kind: 'agent' as const,
    name: 'architecture-review',
    persona: 'reviewer',
    instruction: 'Review.',
    outputContracts: [
      { name: 'architecture-review.md', format: 'Owner report format.', formatRef: 'review-finding-contract' },
    ],
    rules: [makeRule('approved', 'COMPLETE')],
  };

  it('calls the escalation runner even when this round has no escalation request', async () => {
    const publication = { publicationId: 'pub-owner', rawFindings: [] };
    const resumeFindingReviewPublication = vi.fn().mockResolvedValue({
      publication,
      response: {
        persona: reviewerSubStep.name,
        status: 'done',
        content: '[STEP:1] approved',
        timestamp: new Date('2026-08-07T00:00:00.000Z'),
      },
    });
    const findingContractContext = {
      ledgerSummary: '{"findings":[]}',
      reportLedgerSummary: '{"ids":[]}',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        mode: 'structured' as const,
        rawFindingsStructuredOutput: { schemaRef: 'takt.findings.raw', schema: { type: 'object' } },
        reviewScopeSnapshotId: 'd'.repeat(64),
      },
    };
    // 今ラウンドは格上げ対象の anomaly が0件 = escalation context は undefined。
    const buildFindingEscalationInstructionContext = vi.fn().mockReturnValue(undefined);
    const deps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
        resolveStepProviderModelBeforeAutoRouting: vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model' }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model' }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue(findingContractContext),
        buildFindingEscalationInstructionContext,
      },
      stepExecutor: {
        buildInstruction: vi.fn((step: { name: string }) => `instruction:${step.name}`),
        buildPhase1Instruction: vi.fn((instruction: string) => instruction),
        emitStepReports: vi.fn(),
        persistPreviousResponseSnapshot: vi.fn(),
        applyPostExecutionRulesOnly: vi.fn(async (_step, _state, response) => ({
          ...response,
          matchedRuleIndex: 0,
        })),
        recordSynthesizedAgentUsage: vi.fn(),
        resumeFindingReviewPublication,
        prepareFindingReviewPublication: vi.fn(),
      },
      engineOptions: { projectCwd: '/tmp/project' },
      getCwd: () => '/tmp/project',
      getReportDir: () => '.takt/runs/test/reports',
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'test task',
      getInteractive: () => false,
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
      reviewPublicationDir: '/tmp/project/reports',
      findingManagerAuthority: 'standard',
      findingContract: contractWithEscalationReviewer(),
      findingLedgerStore: {
        ledgerIdentity: 'scope-escalation-caller',
        workflowName: 'test-workflow',
        runId: 'test-run',
        loadLedger: () => ({ findings: [] }),
      },
      observabilityEnabled: false,
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
      claimStepOccurrence: vi.fn().mockReturnValue(1),
      updateMaxSteps: vi.fn(),
      setActiveResumePoint: vi.fn(),
      dynamicParallelSelector: { selectParticipants: vi.fn() },
    } as unknown as ParallelRunnerDeps;

    await new ParallelRunner(deps).runParallelStep(
      makeStep({
        name: 'reviewers',
        instruction: 'Run reviewers',
        parallel: [reviewerSubStep as unknown as WorkflowStep],
        rules: [makeRule('all("approved")', 'COMPLETE')],
      }),
      {
        workflowName: 'test-workflow',
        currentStep: 'reviewers',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      } as unknown as Parameters<ParallelRunner['runParallelStep']>[1],
      'test task',
      10,
      vi.fn(),
    );

    expect(buildFindingEscalationInstructionContext).toHaveBeenCalledWith(
      expect.objectContaining({ ownerStepNames: [reviewerSubStep.name] }),
    );
    // request が0件でも runner へ到達し、未取り込みの stored escalation publication を
    // resume で引き当てにいく。ここで早期 return すると raw findings が永久に
    // intake されない。
    const escalationResumeCalls = resumeFindingReviewPublication.mock.calls.filter(
      ([call]) => call.step.name === FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    );
    expect(escalationResumeCalls).toHaveLength(1);
    expect(escalationResumeCalls[0]![0]).toMatchObject({
      parentStepName: 'reviewers',
      stepIteration: 1,
    });
  });
});
