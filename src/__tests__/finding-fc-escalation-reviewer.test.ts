import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../core/models/types.js';
import type { ProviderEscalationTarget } from '../core/models/config-types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../core/models/finding-types.js';
import {
  buildFindingEscalationReviewerStep,
  findingEscalationReviewerReportName,
} from '../core/workflow/findings/escalation-reviewer-step.js';
import { resolveRestatementPresentationPhase } from '../core/workflow/findings/restatement-presentation-phase.js';
import { computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  listFindingReviewPublications,
  persistFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
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

/** 格上げ先。runtime.yaml の `escalate: strong` を解決した結果に相当する。 */
const ESCALATION_TARGET: ProviderEscalationTarget = {
  profile: 'strong',
  provider: 'mock',
  model: 'strong-model',
};

const FINDING_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Manage findings.',
    outputContract: 'Manager output contract.',
  },
  adjudicator: {
    persona: 'supervisor',
    instruction: 'Adjudicate findings.',
  },
};

describe('FC escalation reviewer — presentation phase', () => {
  it('spends the restatement budget on the owner and the last presentation on escalation', () => {
    const phases = [0, 1, 2, 3].map((presentedCount) => resolveRestatementPresentationPhase({
      presentedCount,
      presentationLimit: 3,
      escalationEnabled: true,
    }));

    expect(phases).toEqual(['restatement', 'restatement', 'escalation', 'exhausted']);
  });

  it('escalates the first and only presentation when presentationLimit is 1', () => {
    expect(resolveRestatementPresentationPhase({
      presentedCount: 0,
      presentationLimit: 1,
      escalationEnabled: true,
    })).toBe('escalation');
  });

  it('keeps every presentation on the owner reviewer when the owner profile has no escalate', () => {
    const phases = [0, 1, 2, 3].map((presentedCount) => resolveRestatementPresentationPhase({
      presentedCount,
      presentationLimit: 3,
      escalationEnabled: false,
    }));

    expect(phases).toEqual(['restatement', 'restatement', 'restatement', 'exhausted']);
  });

  it('gives the owner request and the escalation request different identities without changing the digest contract', () => {
    const requestWithoutId = {
      anomalyId: 'RA-ESCALATION',
      presentationOrdinal: 3,
      reviewScopeSnapshotId: '1'.repeat(64),
      sourceExcerptDigest: '2'.repeat(64),
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: ['src/example.ts'],
      missingRequirements: ['title'] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const ownerId = computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: 'architecture-review',
    });
    const escalationId = computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    });

    expect(ownerId).not.toBe(escalationId);
    expect(computeRestatementRequestId({
      ...requestWithoutId,
      reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    })).toBe(escalationId);
  });
});

describe('FC escalation reviewer — synthetic step inherits the owner reviewer', () => {
  const ownerStep = {
    kind: 'agent' as const,
    name: 'architecture-review',
    persona: 'architecture-reviewer',
    personaPath: '/facets/personas/architecture-reviewer.md',
    personaDisplayName: 'architecture-reviewer',
    instruction: 'Review the architecture.',
    policyContents: [{ name: 'coding', content: 'Coding policy.' }],
    knowledgeContents: [{ name: 'architecture', content: 'Architecture knowledge.' }],
    outputContracts: [{ name: 'architecture-review', format: 'Owner report format.' }],
    rules: [makeRule('approved', 'COMPLETE')],
  } as unknown as AgentWorkflowStep;

  it('keeps the owner persona, policy, knowledge and report format', () => {
    const step = buildFindingEscalationReviewerStep({
      ownerStep,
      escalation: ESCALATION_TARGET,
    });

    expect(step).toMatchObject({
      kind: 'agent',
      name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      engineSynthesized: true,
      providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      sessionKey: findingEscalationReviewerReportName(ownerStep.name),
      persona: 'architecture-reviewer',
      personaPath: '/facets/personas/architecture-reviewer.md',
      personaDisplayName: 'architecture-reviewer',
      policyContents: ownerStep.policyContents,
      knowledgeContents: ownerStep.knowledgeContents,
      session: 'refresh',
      edit: false,
      rules: [],
    });
    expect(step.outputContracts).toEqual([{
      name: findingEscalationReviewerReportName(ownerStep.name),
      format: 'Owner report format.',
    }]);
    expect(step.structuredOutput).toBeUndefined();
  });

  it('changes only the model, and drops the owner review procedure', () => {
    const step = buildFindingEscalationReviewerStep({
      ownerStep,
      escalation: ESCALATION_TARGET,
    });

    expect(step).toMatchObject({
      provider: 'mock',
      providerSpecified: true,
      model: 'strong-model',
      modelSpecified: true,
    });
    // 手順はエンジンが注入する restatement-only 契約が担う。
    expect(step.instruction).toBe(ownerStep.persona);
    expect(step.instruction).not.toBe(ownerStep.instruction);
  });

  it('gives each owner its own report name so grouped calls never collide', () => {
    const first = buildFindingEscalationReviewerStep({ ownerStep, escalation: ESCALATION_TARGET });
    const second = buildFindingEscalationReviewerStep({
      ownerStep: { ...ownerStep, name: 'security-review' },
      escalation: ESCALATION_TARGET,
    });

    expect(first.name).toBe(second.name);
    expect(first.outputContracts?.[0]?.name).not.toBe(second.outputContracts?.[0]?.name);
  });

  it('fails loudly when no owner output contract can be inherited', () => {
    expect(() => buildFindingEscalationReviewerStep({
      ownerStep: { kind: 'agent', name: 'review', instruction: 'Review.' } as AgentWorkflowStep,
      escalation: ESCALATION_TARGET,
    })).toThrow(/output contract/);
  });

  it('inherits the owner lifecycle identity while keeping a separate publication identity', () => {
    const escalationStep = buildFindingEscalationReviewerStep({
      ownerStep,
      escalation: ESCALATION_TARGET,
    });
    const stableKeyOf = (step: AgentWorkflowStep) => computeReviewerStableKey({
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      // manager-intake.ts と同じ導出（persona 優先、無ければ step 名）。
      reviewerPersonaKey: step.persona ?? step.name,
    });

    // 代打の主張は owner の lifecycle をそのまま継ぐ（別人の新規観測として
    // 二重計上されない）。persona を継承した帰結であり、意図した挙動。
    expect(stableKeyOf(escalationStep)).toBe(stableKeyOf(ownerStep));
    // publication identity だけは reviewer キーと owner 別 report 名で分かれる。
    expect(escalationStep.name).not.toBe(ownerStep.name);
    expect(escalationStep.outputContracts?.[0]?.name).not.toBe(ownerStep.outputContracts?.[0]?.name);
  });

  it('inherits the owner MCP servers so the stand-in can re-fetch the same evidence', () => {
    const withMcp = {
      ...ownerStep,
      mcpServers: { docs: { command: 'docs-server' } },
    } as unknown as AgentWorkflowStep;

    expect(buildFindingEscalationReviewerStep({
      ownerStep: withMcp,
      escalation: ESCALATION_TARGET,
    }).mcpServers).toEqual({ docs: { command: 'docs-server' } });
  });

  it('fails loudly when the owner reviewer has no persona to inherit', () => {
    expect(() => buildFindingEscalationReviewerStep({
      ownerStep: {
        ...ownerStep,
        persona: undefined,
      } as unknown as AgentWorkflowStep,
      escalation: ESCALATION_TARGET,
    })).toThrow(/persona/);
  });
});

describe('FC escalation reviewer — workflow configuration', () => {
  const findingContractRaw = {
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
  };

  it('rejects the removed escalation_reviewer block at load time', () => {
    expect(FindingContractConfigRawSchema.safeParse(findingContractRaw).success).toBe(true);
    expect(FindingContractConfigRawSchema.safeParse({
      ...findingContractRaw,
      escalation_reviewer: { persona: 'escalation-supervisor' },
    }).success).toBe(false);
    expect(() => normalizeWorkflowConfig({
      name: 'legacy-escalation-workflow',
      finding_contract: {
        ...findingContractRaw,
        escalation_reviewer: { persona: 'escalation-supervisor' },
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp/project')).toThrow();
  });

  it('reserves the escalation-reviewer step name for every finding contract workflow', () => {
    const workflowRaw = (withFindingContract: boolean) => ({
      name: 'reserved-name-workflow',
      ...(withFindingContract ? { finding_contract: findingContractRaw } : {}),
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
      finding_contract: findingContractRaw,
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
    expect(rebuiltReportInstruction).toContain('Write an ordinary Markdown review report');
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
  function makeServices(presentationLimit: number, options: { escalates?: boolean } = {}) {
    const escalates = options.escalates ?? true;
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
        // runtime.yaml の `escalate` 付き profile へ解決されたレビュアーを再現する。
        providerRouting: {
          steps: {
            [reviewerStep.name]: {
              provider: 'mock' as const,
              model: 'weak-model',
              ...(escalates ? { escalation: ESCALATION_TARGET } : {}),
            },
          },
        },
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
      findingContract: FINDING_CONTRACT as never,
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

  const escalationRequests = (
    services: ReturnType<typeof makeServices>['services'],
    freezeKey: string,
  ) => {
    const contexts = services.optionsBuilder.buildFindingEscalationInstructionContexts({
      ownerReviewerSteps: [reviewerStep as AgentWorkflowStep],
      reviewScopeSnapshotId,
      findingContractFreezeKey: freezeKey,
    });
    const presentation = contexts.get(reviewerStep.name)?.reviewer?.presentationContext;
    return presentation?.revision === 2 ? presentation.restatementRequests : undefined;
  };

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
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
      reportName: `${findingEscalationReviewerReportName(reviewerStep.name)}.md`,
    });
  }

  it('does not escalate in the same round the owner reviewer spends its (limit-1) presentation', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      const freezeKey = 'freeze-limit-2';

      const ownerContext = services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        true,
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
      expect(escalationRequests(services, freezeKey)).toBeUndefined();
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
        true,
        reviewScopeSnapshotId,
        freezeKey,
      );
      const ownerPresentation = ownerContext?.reviewer?.presentationContext;
      expect(ownerPresentation?.revision === 2 && ownerPresentation.restatementRequests).toEqual([]);

      expect(escalationRequests(services, freezeKey)).toMatchObject([
        { reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY, presentationOrdinal: 1 },
      ]);
    } finally {
      cleanup();
    }
  });

  it('keeps the last presentation on the owner when the owner profile declares no escalate', () => {
    const { services, cleanup } = makeServices(1, { escalates: false });
    try {
      const freezeKey = 'freeze-no-escalate';

      const ownerContext = services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        true,
        reviewScopeSnapshotId,
        freezeKey,
      );
      const ownerPresentation = ownerContext?.reviewer?.presentationContext;
      expect(ownerPresentation?.revision === 2 && ownerPresentation.restatementRequests).toMatchObject([
        { reviewer: reviewerStep.name, presentationOrdinal: 1 },
      ]);

      expect(escalationRequests(services, freezeKey)).toBeUndefined();
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
          true,
          reviewScopeSnapshotId,
          freezeKey,
        );
        return escalationRequests(services, freezeKey);
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
        true,
        reviewScopeSnapshotId,
        'freeze-after-escalation',
      );

      expect(escalationRequests(services, 'freeze-after-escalation')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('refuses to build an escalation batch from anything but the frozen input of the same round', () => {
    const { services, cleanup } = makeServices(1);
    try {
      services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        true,
        reviewScopeSnapshotId,
        'freeze-current-round',
      );

      expect(() => escalationRequests(services, 'freeze-other-round'))
        .toThrow(/frozen reviewer input of the same review round/);
    } finally {
      cleanup();
    }
  });
});

describe('FC escalation reviewer — owner 別 batch の枠按分と strategy 射影', () => {
  const reviewScopeSnapshotId = 'f'.repeat(64);

  function ownerStepFor(name: string): AgentWorkflowStep {
    return {
      kind: 'agent',
      name,
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [{ name, format: 'Owner report format.' }],
      rules: [],
    } as unknown as AgentWorkflowStep;
  }

  /** owner ごとに `anomaliesPerOwner` 件の未提示 intake anomaly（limit 1）を積む。 */
  function makeServices(ownerNames: readonly string[], anomaliesPerOwner: number) {
    const cwd = process.cwd();
    const runPaths = buildRunPaths(cwd, 'escalation-allocation');
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-escalation-allocation-'));
    const observedAt = {
      runId: 'run-escalation-allocation',
      stepName: ownerNames[0]!,
      timestamp: '2026-08-07T00:00:00.000Z',
    };
    const rawFindings = ownerNames.flatMap((owner) => (
      Array.from({ length: anomaliesPerOwner }, (_, index) => canonicalRawFindingFixture({
        rawFindingId: `raw-${owner}-${index}`,
        stepName: owner,
        reviewer: owner,
        familyTag: null,
        severity: null,
        title: null,
        description: null,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: [`src/${owner}-${index}.ts`] },
        rawExcerpt: `Claim ${owner} ${index} must be restated.`,
        evidence: [],
      }))
    ));
    const emptyLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: observedAt.timestamp,
      findings: [],
      evidenceRecords: [],
      rawFindings,
      conflicts: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      ...createEmptyFindingContractRegistries(),
    };
    const specs = rawFindings.map((raw) => createReviewerAnomalySpec({
      wire: raw,
      canonical: canonicalizeReviewerRawFinding(
        candidateFromStoredRawFinding(raw, `stable-${raw.rawFindingId}`),
        { ledger: emptyLedger },
      ).canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'The normalized claim omitted product identity.',
      intakeContract: {
        observationClass: 'claim-bearing',
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['product-identity-incomplete'],
        missingRequirements: ['title'],
        presentationOwnerReviewer: raw.reviewer,
        presentationLimit: 1,
      },
    }));
    const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger, specs, {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());

    const services = createWorkflowEngineServices({
      config: {
        name: 'test-workflow',
        initialStep: ownerNames[0]!,
        maxSteps: 10,
        steps: ownerNames.map((name) => ownerStepFor(name) as unknown as WorkflowStep),
      },
      state: {
        workflowName: 'test-workflow',
        currentStep: ownerNames[0]!,
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
      getMaxSteps: () => 1000,
      options: {
        projectCwd: cwd,
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
        providerRouting: {
          steps: Object.fromEntries(ownerNames.map((name) => [
            name,
            { provider: 'mock' as const, model: 'weak-model', escalation: ESCALATION_TARGET },
          ])),
        },
      },
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      sharedRuntime: createSharedRuntime(undefined, 1000),
      resumeStackPrefix: [],
      runPaths,
      updateMaxSteps: vi.fn(),
      setActiveResumePoint: vi.fn(),
      persistDynamicParallelSelection: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: FINDING_CONTRACT as never,
      findingLedgerStore: { loadLedger: () => ledger } as never,
      updatePersonaSession: vi.fn(),
      resolveNextStepFromDone: vi.fn(),
      resetCycleDetector: vi.fn(),
      emitEvent: vi.fn(),
      createEngine: vi.fn(),
    });
    return {
      services,
      cleanup: () => rmSync(reportDir, { recursive: true, force: true }),
    };
  }

  it('owner 別 batch は 1 step あたりの raw finding 上限を共有し、按分は先着順で決定的', () => {
    const ownerNames = ['review-a', 'review-b', 'review-c'];
    const { services, cleanup } = makeServices(ownerNames, 64);
    try {
      const freezeKey = 'freeze-allocation';
      for (const name of ownerNames) {
        services.optionsBuilder.buildFindingContractInstructionContext(
          ownerStepFor(name) as unknown as WorkflowStep,
          true,
          reviewScopeSnapshotId,
          freezeKey,
        );
      }

      const contexts = services.optionsBuilder.buildFindingEscalationInstructionContexts({
        ownerReviewerSteps: ownerNames.map(ownerStepFor),
        reviewScopeSnapshotId,
        findingContractFreezeKey: freezeKey,
      });

      const requestCountFor = (owner: string) => {
        const presentation = contexts.get(owner)?.reviewer?.presentationContext;
        return presentation?.revision === 2 ? presentation.restatementRequests.length : 0;
      };
      // reviewer あたり 64 件・step 合計 128 件が上限。3人目は残り枠 0 なので
      // batch が作られない（context ごと存在しない）。
      expect([
        requestCountFor('review-a'),
        requestCountFor('review-b'),
        requestCountFor('review-c'),
      ]).toEqual([64, 64, 0]);
      expect(contexts.has('review-c')).toBe(false);

      // 各 batch は自分の owner の anomaly だけを載せる。
      for (const owner of ['review-a', 'review-b']) {
        const presentation = contexts.get(owner)!.reviewer!.presentationContext!;
        expect(presentation.revision).toBe(2);
        if (presentation.revision !== 2) {
          throw new Error('expected a v2 presentation context');
        }
        expect(presentation.restatementRequests.every(
          (request) => request.reviewer === FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        )).toBe(true);
        expect(new Set(presentation.restatementRequests.map(({ anomalyId }) => anomalyId)).size)
          .toBe(64);
      }
    } finally {
      cleanup();
    }
  });

  it('同じラウンドで同じ reviewer を組み直しても提示 batch を作り直さない', () => {
    const { services, cleanup } = makeServices(['review-a'], 1);
    try {
      const freezeKey = 'freeze-projection';
      const step = ownerStepFor('review-a') as unknown as WorkflowStep;
      const phase1 = services.optionsBuilder.buildFindingContractInstructionContext(
        step,
        true,
        reviewScopeSnapshotId,
        freezeKey,
      );
      // Phase 2 が同じ freeze キーで組み直しても凍結値をそのまま返す。
      const phase2 = services.optionsBuilder.buildFindingContractInstructionContext(
        step,
        true,
        reviewScopeSnapshotId,
        freezeKey,
      );

      // 提示 batch を作り直すと同じラウンドで二重計上になる。
      expect(phase2?.reviewer?.presentationContext)
        .toBe(phase1?.reviewer?.presentationContext);
      expect(phase2?.reviewer?.reviewScopeSnapshotId)
        .toBe(phase1?.reviewer?.reviewScopeSnapshotId);
    } finally {
      cleanup();
    }
  });
});

describe('FC escalation reviewer — direct provider call wiring', () => {
  const makeEscalationContext = (anomalyId: string) => ({
    ledgerSummary: { findings: [] },
    reportLedgerSummary: { findings: [] },
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    reviewer: {
      reviewScopeSnapshotId: '5'.repeat(64),
      presentationContext: {
        revision: 2 as const,
        reviewScopeSnapshotId: '5'.repeat(64),
        restatementRequests: [],
        presentedReviewerAnomalyIds: [anomalyId],
        contextDigest: '6'.repeat(64),
      },
    },
  });

  const escalationContext = makeEscalationContext('RA-1');

  const makeOwnerStep = (name: string) => ({
    kind: 'agent' as const,
    name,
    persona: `${name}-persona`,
    instruction: 'Review.',
    outputContracts: [{ name, format: `${name} report format.` }],
  }) as unknown as AgentWorkflowStep;

  const ownerReviewerStep = makeOwnerStep('architecture-review');

  function createRunnerInput(overrides: {
    resumeResult?: unknown;
    prepareResult?: unknown;
    withoutEscalationContext?: boolean;
    ownerReviewerSteps?: readonly AgentWorkflowStep[];
    escalationContexts?: ReadonlyMap<string, unknown>;
    escalatingOwners?: readonly string[];
  } = {}) {
    const ownerReviewerSteps = overrides.ownerReviewerSteps ?? [ownerReviewerStep];
    const escalatingOwners = new Set(
      overrides.escalatingOwners ?? ownerReviewerSteps.map((step) => step.name),
    );
    const recordSynthesizedAgentUsage = vi.fn();
    const prepareFindingReviewPublication = vi.fn().mockImplementation((call: { step: { outputContracts?: { name: string }[] } }) => Promise.resolve(
      overrides.prepareResult ?? {
        publication: { publicationId: `pub-${call.step.outputContracts?.[0]?.name ?? 'escalation'}` },
      },
    ));
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
      resolveStepProviderModel: vi.fn((step: { name: string }) => (
        escalatingOwners.has(step.name)
          ? { provider: 'mock', model: 'weak-model', escalation: ESCALATION_TARGET }
          : { provider: 'mock', model: 'strong-model' }
      )),
    };
    const escalationContexts = overrides.escalationContexts
      ?? new Map(
        overrides.withoutEscalationContext === true
          ? []
          : ownerReviewerSteps.map((step) => [step.name, escalationContext] as const),
      );
    return {
      input: {
        escalationContexts,
        ownerReviewerSteps,
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
      persona: 'architecture-review-persona',
      status: 'done',
      content: '{}',
      sessionId: 'session-escalation',
      timestamp: new Date(),
    };
    executeAgentMock.mockResolvedValue(doneResponse);
    const { input, stepExecutor } = createRunnerInput();

    const outcome = await runFindingEscalationReviewer(input);

    expect(outcome).toMatchObject({ kind: 'published' });
    const results = outcome!.kind === 'published' ? outcome.results : [];
    expect(results).toHaveLength(1);
    expect(results[0]!.step.name).toBe(FINDING_ESCALATION_REVIEWER_ROUTING_KEY);
    // 格上げ枠も1本道: markdown レポート + 正規化係。構造化出力は載らない。
    expect(results[0]!.step.structuredOutput).toBeUndefined();
    // 実際に走った attempt の provider/model をそのまま計上する。
    expect(stepExecutor.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY }),
      true,
      undefined,
      { provider: 'mock', model: 'strong-model' },
    );
    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        parentStepName: 'reviewers',
        stepIteration: 1,
        presentationContext: escalationContext.reviewer.presentationContext,
        // Phase 2 が step 名から context を組み直すと restatement-only 契約が
        // 消えるため、Phase 1 と同じ context を明示的に渡す。
        findingContractContext: escalationContext,
      }),
    );
  });

  it('issues one call per owner reviewer and keeps each owner persona and report separate', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'reviewer',
      status: 'done',
      content: '{}',
      timestamp: new Date(),
    } satisfies AgentResponse);
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor } = createRunnerInput({ ownerReviewerSteps: owners });

    const outcome = await runFindingEscalationReviewer(input);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(executeAgentMock.mock.calls.map((call) => call[0])).toEqual([
      'architecture-review-persona',
      'security-review-persona',
    ]);
    const preparedSteps = stepExecutor.prepareFindingReviewPublication.mock.calls
      .map((call) => (call[0] as { step: AgentWorkflowStep }).step);
    expect(preparedSteps.map((step) => step.outputContracts?.[0]?.name)).toEqual([
      findingEscalationReviewerReportName('architecture-review'),
      findingEscalationReviewerReportName('security-review'),
    ]);
    expect(preparedSteps.map((step) => step.outputContracts?.[0]?.format)).toEqual([
      'architecture-review report format.',
      'security-review report format.',
    ]);
    expect(outcome!.kind === 'published' && outcome.results).toHaveLength(2);
  });

  it('drops already-published owner results when a later owner escalation goes terminal', async () => {
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor } = createRunnerInput({ ownerReviewerSteps: owners });
    executeAgentMock
      .mockResolvedValueOnce({
        persona: 'architecture-review-persona',
        status: 'done',
        content: '{}',
        timestamp: new Date(),
      } satisfies AgentResponse)
      .mockResolvedValueOnce({
        persona: 'security-review-persona',
        status: 'error',
        content: '',
        error: 'provider exploded',
        timestamp: new Date(),
      } satisfies AgentResponse);

    const outcome = await runFindingEscalationReviewer(input);

    // 親ステップが terminal になる = manager の取り込み自体が走らないので、
    // 先行 owner の publication を published として返さない。次ラウンドは
    // stored publication の resume で拾い直す。
    expect(outcome).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledTimes(1);
  });

  it('skips owners whose profile declares no escalate', async () => {
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor } = createRunnerInput({
      ownerReviewerSteps: owners,
      escalatingOwners: ['security-review'],
    });
    executeAgentMock.mockResolvedValue({
      persona: 'reviewer',
      status: 'done',
      content: '{}',
      timestamp: new Date(),
    } satisfies AgentResponse);

    await runFindingEscalationReviewer(input);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(executeAgentMock.mock.calls[0]![0]).toBe('security-review-persona');
    expect(stepExecutor.resumeFindingReviewPublication).toHaveBeenCalledTimes(1);
  });

  it('runs phase 1 with read-only tools so it can read the code it must quote', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'architecture-review-persona',
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
      persona: 'architecture-review-persona',
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

    expect(outcome!.kind === 'published' && outcome.results[0]!.publication)
      .toMatchObject({ publicationId: 'pub-resumed' });
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

    expect(outcome!.kind === 'published' && outcome.results[0]!.publication)
      .toMatchObject({ publicationId: 'pub-carried-over' });
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
        reviewScopeSnapshotId: 'd'.repeat(64),
      },
    };
    // 今ラウンドは格上げ対象の anomaly が0件 = escalation context は空。
    const buildFindingEscalationInstructionContexts = vi.fn().mockReturnValue(new Map());
    const deps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
        resolveStepProviderModelBeforeAutoRouting: vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model' }),
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'mock',
          model: 'weak-model',
          escalation: ESCALATION_TARGET,
        }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue(findingContractContext),
        buildFindingEscalationInstructionContexts,
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
      findingContract: FINDING_CONTRACT,
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

    expect(buildFindingEscalationInstructionContexts).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerReviewerSteps: [expect.objectContaining({ name: reviewerSubStep.name })],
      }),
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
