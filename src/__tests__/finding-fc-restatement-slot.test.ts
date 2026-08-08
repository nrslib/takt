import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../core/models/types.js';
import type { ProviderEscalationTarget } from '../core/models/config-types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../core/models/finding-types.js';
import {
  buildFindingRestatementSlotStep,
  findingRestatementSlotReportName,
} from '../core/workflow/findings/restatement-slot-step.js';
import { resolveRestatementPresentationPhase } from '../core/workflow/findings/restatement-presentation-phase.js';
import {
  budgetCountedRoundMarkers,
  isRoundExcludedFromBudget,
  markRoundExcludedFromBudget,
} from '../core/workflow/findings/round-marker.js';
import {
  attachStopBudgetState,
  stopBudgetRoundsCompleted,
} from '../core/workflow/findings/stop-budget.js';
import { computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

const { runFindingRestatementSlot } = await import(
  '../core/workflow/findings/restatement-slot-runner.js'
);

/** 格上げ先。runtime.yaml の `escalate: strong` を解決した結果に相当する。 */
const ESCALATION_TARGET: ProviderEscalationTarget = {
  profile: 'strong',
  provider: 'mock',
  model: 'strong-model',
};

const OWNER_TARGET = { provider: 'mock' as const, model: 'weak-model' };

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

describe('FC restatement slot — presentation phase', () => {
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
      missingRequirements: ['target'] as const,
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

describe('FC restatement slot — budget accounting', () => {
  const marker = ['run', '', 'reviewers', '1', 'pub-a'].join('\u0000');

  it('keeps an excluded round in the applied marker set but out of the budget count', () => {
    const excluded = markRoundExcludedFromBudget(marker);

    // 適用済み集合には入る（二相コミットの staging 不変条件と crash/replay の
    // 冪等性がこの集合に依存する）。
    expect(excluded).not.toBe(marker);
    expect(isRoundExcludedFromBudget(excluded)).toBe(true);
    expect(isRoundExcludedFromBudget(marker)).toBe(false);
    // 予算カウンタは印付きを数えない。
    expect(budgetCountedRoundMarkers([marker, excluded])).toEqual([marker]);
  });

  it('does not exhaust the stop budget on excluded rounds', () => {
    const limits = { maxRounds: 2, maxMinutes: undefined };
    const withReviewRound = attachStopBudgetState(
      {} as never,
      {} as never,
      limits,
      marker,
      '2026-08-07T00:00:00.000Z',
    );
    const withSlotPass = attachStopBudgetState(
      withReviewRound,
      {} as never,
      limits,
      markRoundExcludedFromBudget(`${marker}-slot`),
      '2026-08-07T00:00:01.000Z',
    );

    // 1ステップで予算を焼き切らない: marker は2件でも予算ラウンドは1回。
    expect(withSlotPass.stopBudget?.roundMarkers).toHaveLength(2);
    expect(stopBudgetRoundsCompleted(withSlotPass)).toBe(1);
    expect(withSlotPass.stopBudget?.exhausted).toBe(false);
  });
});

describe('FC restatement slot — round number definition', () => {
  /**
   * 刻印側（firstObservedRound を打つ側）と読み側（同一ラウンド保護を判定する側）が
   * 同じ「現在ラウンド」定義を使っていることを固定する。
   *
   * suffix 付き marker の導入で `stopBudget.roundMarkers.length`（生値）と
   * `stopBudgetRoundsCompleted()`（計上値）が乖離した。生値を直読みすると
   * currentRound が言い直し slot のパスぶん先へ飛び、着地したばかりの暫定 finding が
   * その場で dismiss 候補になる（同一ラウンド保護の恒久無効化）。
   */
  it('counts the current round without the budget-excluded passes', () => {
    const ledger = {
      stopBudget: {
        roundMarkers: [
          'run\u0000\u0000reviewers\u00001\u0000pub-review',
          markRoundExcludedFromBudget('run\u0000\u0000reviewers\u00001\u0000pub-slot'),
        ],
        firstRoundAt: '2026-08-07T00:00:00.000Z',
        exhausted: false,
      },
    } as never;

    // 生値と計上値が乖離する。刻印側（conflict-claim-landing / manager-utils）は
    // 計上値+1 を firstObservedRound に打つので、読み側が生値+1 を使うと
    // firstObservedRound < currentRound になり、着地したばかりの暫定 finding が
    // その場で dismiss 候補になる。
    expect(ledger.stopBudget.roundMarkers.length).toBe(2);
    expect(stopBudgetRoundsCompleted(ledger)).toBe(1);
  });

  it('has no production reader left on the raw marker array', () => {
    // 定義の分岐は「どこか1箇所が生値を読む」形で再発する。読み口を
    // stopBudgetRoundsCompleted に一本化したことをソースで固定する。
    //
    // 走査は再帰で、slot の呼び出し側（engine/）も含める。表記は optional chain の
    // 有無・空白・改行を吸収する正規表現で見る。完全一致だと
    // `stopBudget?.roundMarkers?.length` ひとつで抜ける。
    const rawMarkerRead = /\bstopBudget\s*\??\s*\.\s*roundMarkers\s*\??\s*\.\s*length\b/u;
    const collectSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          return collectSources(path);
        }
        return entry.name.endsWith('.ts') && entry.name !== 'stop-budget.ts' ? [path] : [];
      });
    const scanRoots = [
      join(process.cwd(), 'src', 'core', 'workflow', 'findings'),
      join(process.cwd(), 'src', 'core', 'workflow', 'engine'),
    ];
    const offenders = scanRoots
      .flatMap(collectSources)
      .filter((path) => rawMarkerRead.test(readFileSync(path, 'utf-8')));

    expect(offenders).toEqual([]);
  });
});

describe('FC restatement slot — synthetic step inherits the owner reviewer', () => {
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
    const step = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: ESCALATION_TARGET,
    });

    expect(step).toMatchObject({
      kind: 'agent',
      name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
      engineSynthesized: true,
      providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
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
      name: findingRestatementSlotReportName({
        ownerStepName: ownerStep.name,
        phase: 'escalation',
        presentationPass: 1,
      }),
      format: 'Owner report format.',
    }]);
    expect(step.sessionKey).toBe(step.outputContracts?.[0]?.name);
    expect(step.structuredOutput).toBeUndefined();
  });

  it('keeps the reviewer key on the owner for the restatement phase so the publication invariant holds', () => {
    const step = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 2,
      target: OWNER_TARGET,
    });

    // publication の reviewerStepName は step 名から決まる。restatement request の
    // reviewer（= owner 名）と一致していないと publication invariant を破る。
    expect(step.name).toBe(ownerStep.name);
    expect(step).toMatchObject({ provider: 'mock', model: 'weak-model' });
    expect(step.outputContracts?.[0]?.name).toBe('followup-architecture-review-2');
    // owner のレビュー本編 report とは別の identity になる。
    expect(step.outputContracts?.[0]?.name).not.toBe(ownerStep.outputContracts?.[0]?.name);
  });

  it('pins modelSpecified even when the target has no model so routing cannot resolve one', () => {
    // provider だけを指名した escalation-reviewer seat がこの経路を通る。
    // modelSpecified を立てないと model だけが routing 層で再解決され、
    // 別 provider 向けの model が混ざった組になる。
    const step = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: { provider: 'mock' },
    });

    expect(step).toMatchObject({
      provider: 'mock',
      providerSpecified: true,
      modelSpecified: true,
    });
    expect(step.model).toBeUndefined();
    expect(resolveStepProviderModel({
      step,
      providerRouting: {
        // 格上げ枠の routing キーは step 名と同じ 'escalation-reviewer'。
        personas: { [FINDING_ESCALATION_REVIEWER_ROUTING_KEY]: { provider: 'codex', model: 'routed-model' } },
      },
    })).toMatchObject({ provider: 'mock', model: undefined });
  });

  it('changes only the model, and drops the owner review procedure', () => {
    const step = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: ESCALATION_TARGET,
    });

    expect(step).toMatchObject({
      provider: 'mock',
      providerSpecified: true,
      model: 'strong-model',
      modelSpecified: true,
    });
    // 手順はエンジンが注入する restatement-only 契約が担う。
    expect(step.instruction).not.toBe(ownerStep.instruction);
    expect(step.instruction).not.toBe(ownerStep.persona);
  });

  it('gives each owner and each presentation pass its own report name', () => {
    const passOne = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 1,
      target: OWNER_TARGET,
    });
    const passTwo = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 2,
      target: OWNER_TARGET,
    });
    const otherOwner = buildFindingRestatementSlotStep({
      ownerStep: { ...ownerStep, name: 'security-review' },
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 1,
      target: OWNER_TARGET,
    });

    // 同じラウンド内の反復も別の publication にならないと提示が計上されない。
    expect(passOne.outputContracts?.[0]?.name).not.toBe(passTwo.outputContracts?.[0]?.name);
    expect(passOne.outputContracts?.[0]?.name).not.toBe(otherOwner.outputContracts?.[0]?.name);
  });

  it('fails loudly when no owner output contract can be inherited', () => {
    expect(() => buildFindingRestatementSlotStep({
      ownerStep: { kind: 'agent', name: 'review', instruction: 'Review.' } as AgentWorkflowStep,
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 1,
      target: OWNER_TARGET,
    })).toThrow(/output contract/);
  });

  it('inherits the owner lifecycle identity while keeping a separate publication identity', () => {
    const escalationStep = buildFindingRestatementSlotStep({
      ownerStep,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: ESCALATION_TARGET,
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
    expect(escalationStep.name).not.toBe(ownerStep.name);
    expect(escalationStep.outputContracts?.[0]?.name).not.toBe(ownerStep.outputContracts?.[0]?.name);
  });

  it('inherits the owner MCP servers so the stand-in can re-fetch the same evidence', () => {
    const withMcp = {
      ...ownerStep,
      mcpServers: { docs: { command: 'docs-server' } },
    } as unknown as AgentWorkflowStep;

    expect(buildFindingRestatementSlotStep({
      ownerStep: withMcp,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: ESCALATION_TARGET,
    }).mcpServers).toEqual({ docs: { command: 'docs-server' } });
  });

  // persona 未指定のレビュアーは正当な構成。言い直し枠は step 名が owner と同じ
  // なので、観測者キー（persona ?? step 名）は persona 無しでも一致する。
  it('inherits an absent persona for the restatement slot instead of failing', () => {
    const ownerWithoutPersona = { ...ownerStep, persona: undefined } as unknown as AgentWorkflowStep;
    const step = buildFindingRestatementSlotStep({
      ownerStep: ownerWithoutPersona,
      phase: 'restatement',
      mode: 'restatement-only',
      presentationPass: 1,
      target: OWNER_TARGET,
    });

    expect(step.persona).toBeUndefined();
    const reviewerKeyOf = (candidate: AgentWorkflowStep) => candidate.persona ?? candidate.name;
    expect(reviewerKeyOf(step)).toBe(reviewerKeyOf(ownerWithoutPersona));
  });

  // 格上げ枠だけは step 名が 'escalation-reviewer' へ変わるため、persona を
  // 共有できないと代打の主張が owner の lifecycle を継がない。
  it('fails loudly when an escalated re-review has no persona to inherit', () => {
    expect(() => buildFindingRestatementSlotStep({
      ownerStep: {
        ...ownerStep,
        persona: undefined,
      } as unknown as AgentWorkflowStep,
      phase: 'escalation',
      mode: 'restatement-only',
      presentationPass: 1,
      target: ESCALATION_TARGET,
    })).toThrow(/persona/);
  });

  // full-review は「レビュー手順そのもの」が決着条件なので、手順が無いまま
  // 完全な再レビューを名乗らせない。
  it('fails loudly when a full re-review has no owner instruction to inherit', () => {
    expect(() => buildFindingRestatementSlotStep({
      ownerStep: { ...ownerStep, instruction: '  ' } as unknown as AgentWorkflowStep,
      phase: 'restatement',
      mode: 'full-review',
      presentationPass: 1,
      target: OWNER_TARGET,
    })).toThrow(/instruction/);
  });
});

describe('FC restatement slot — workflow configuration', () => {
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

describe('FC restatement slot — restatement instruction', () => {
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

      // 引用は現物のファイルから取らせる。ただし観察専任のレビュアーに
      // normalizer の wire フィールド（file_quote / verbatimExcerpt）は書かせない。
      expect(instruction).toContain('Evidence');
      expect(instruction).not.toContain('file_quote');
      expect(instruction).not.toContain('verbatimExcerpt');
      expect(instruction).toMatch(language === 'en' ? /Read the request's target files/ : /対象ファイルをリポジトリで実際に読/);
    },
  );

  it('keeps phase 2 restatement-only for the slot context and loses it for a rebuilt empty one', () => {
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
    const slotPresentationContext = createFindingReviewPresentationContextV2({
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
          mode: 'restatement-only' as const,
        },
      },
      language: 'en',
      renderFencedJsonBlock: (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    });

    // Phase 1 と同じ context を渡した Phase 2 は restatement-only のまま。
    const slotReportInstruction = reportInstruction(slotPresentationContext);
    expect(slotReportInstruction).toContain('restatement-only review');
    expect(slotReportInstruction).toContain('RA-PHASE2');
    // reviewer 名から組み直した context（request 0件）は通常レビュー契約へ化ける。
    const rebuiltReportInstruction = reportInstruction(createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
    }));
    expect(rebuiltReportInstruction).not.toContain('restatement-only review');
    expect(rebuiltReportInstruction).toContain('Write an ordinary Markdown review report');
  });
});

describe('FC restatement slot — per-pass request batches', () => {
  const reviewerStep: WorkflowStep = {
    name: 'architecture-review',
    persona: 'reviewer',
    instruction: 'Review.',
    outputContracts: [{ name: 'architecture-review', format: 'Owner report format.' }],
    rules: [],
  };
  const reviewScopeSnapshotId = 'b'.repeat(64);

  function makeServices(
    presentationLimit: number,
    options: {
      escalates?: boolean;
      nonIntakeAnomaly?: boolean;
      /** 提示予算を残したまま終端処分された intake anomaly を再現する。 */
      terminallyDisposed?: boolean;
    } = {},
  ) {
    const escalates = options.escalates ?? true;
    const cwd = process.cwd();
    // 提示回数の正本は report dir の canonical publication。パスごとに数え直すため、
    // 実際に publication を書き込める隔離ディレクトリを使う。エンジンは
    // runPaths.reportsAbs から数えるので、隔離先をそこへ束ねる。
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-restatement-slot-'));
    const runPaths = {
      ...buildRunPaths(cwd, `restatement-slot-${presentationLimit}`),
      reportsAbs: reportDir,
    };
    const raw = canonicalRawFindingFixture({
      rawFindingId: 'raw-slot',
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
      runId: 'run-restatement-slot',
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
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw, 'reviewer-stable-key'),
      { ledger: emptyLedger },
    ).canonical;
    const anomalyLedger = applyReviewerAnomalySpecsToLedger(emptyLedger, [
      createReviewerAnomalySpec({
        wire: raw,
        canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'The normalized claim omitted product identity.',
        intakeContract: {
          observationClass: 'claim-bearing',
          classificationAuthorityId: 'system/intake_observation_classification_v1',
          reasonCodes: ['product-identity-incomplete'],
          missingRequirements: ['target'],
          presentationOwnerReviewer: reviewerStep.name,
          presentationLimit,
        },
      }),
      // 言い直し予算に乗らない anomaly。決着条件は「そのレビュアーの後続
      // 完全レビュー成立」による取り下げだけ。
      ...(options.nonIntakeAnomaly === true
        ? [createReviewerAnomalySpec({
          wire: raw,
          canonical,
          // slot が決着させられる非 intake anomaly を使う。verdict-claims-mismatch は
          // verdict を伴う publication でしか決着しないので slot の発火条件に入らない。
          anomalyKind: 'protocol-anomaly',
          reason: 'The report could not be bound to its own text.',
        })]
        : []),
    ], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());
    const ledger = options.terminallyDisposed === true
      ? {
        ...anomalyLedger,
        reviewerAnomalies: anomalyLedger.reviewerAnomalies!.map((entry) => (
          entry.intakeContract === undefined
            ? entry
            : {
              ...entry,
              intakeContract: {
                ...entry.intakeContract,
                terminalDisposition: {
                  kind: 'restatement_exhausted_claim_bearing' as const,
                  workflowOutcome: 'review_integrity_unresolved' as const,
                  decidedAt: observedAt,
                  terminalPublicationId: 'publication-terminal',
                  reason: `Restatement presentation limit ${presentationLimit} was reached without verified correspondence`,
                },
              },
            }
        )),
      }
      : anomalyLedger;

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

  const slotRequests = (
    services: ReturnType<typeof makeServices>['services'],
    slot: 'owner' | 'escalation',
  ) => {
    const contexts = services.optionsBuilder.buildFindingRestatementSlotContexts({
      ownerReviewerSteps: [reviewerStep as AgentWorkflowStep],
      reviewScopeSnapshotId,
    });
    const presentation = contexts.get(reviewerStep.name)?.[slot]?.reviewer?.presentationContext;
    if (presentation === undefined) {
      return undefined;
    }
    // context の不在（batch を作らない）と revision 違いは別の状態。undefined へ
    // 畳むと否定契約が緩むので、context がある場合は revision を明示的に固定する。
    expect(presentation.revision).toBe(2);
    return presentation.revision === 2 ? presentation.restatementRequests : undefined;
  };

  /** 指定 reviewer がその anomaly を提示した canonical publication を報告先へ実際に書き込む。 */
  function persistPresentation(input: {
    reportDir: string;
    anomalyId: string;
    presentationOrdinal: number;
    reviewerStepName: string;
    reportName: string;
    repairOrigin?: 'evidence-search';
  }): void {
    const requestWithoutId = {
      anomalyId: input.anomalyId,
      reviewer: input.reviewerStepName,
      presentationOrdinal: input.presentationOrdinal,
      reviewScopeSnapshotId,
      sourceExcerptDigest: 'c'.repeat(64),
      claimedExcerpt: 'The reviewer claim must be restated.',
      targetPaths: ['src/example.ts'],
      missingRequirements: ['target'] as const,
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
          scopeIdentity: 'scope-fc-restatement-slot',
          callNamespace: '',
          parentStepName: reviewerStep.name,
          stepIteration: 1,
          reviewerStepName: input.reviewerStepName,
          reportName: input.reportName,
        },
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
        reportContent: `${input.reviewerStepName} restatement report.`,
        ...(input.repairOrigin === undefined ? {} : { repairOrigin: input.repairOrigin }),
        rawFindings: [],
        presentationContext,
      }),
      reviewerExecutionIdentity: { provider: 'codex' },
    });
  }

  it('keeps the review round itself free of restatement requests', () => {
    const { services, cleanup } = makeServices(2);
    try {
      const ownerContext = services.optionsBuilder.buildFindingContractInstructionContext(
        reviewerStep,
        true,
        reviewScopeSnapshotId,
        'freeze-round',
      );
      const presentation = ownerContext?.reviewer?.presentationContext;

      // 相乗り経路の廃止: レビュー本編の publication は何も提示しない。
      expect(presentation?.revision).toBe(2);
      expect(presentation?.revision === 2 && presentation.restatementRequests).toEqual([]);
      expect(presentation?.revision === 2 && presentation.presentedReviewerAnomalyIds).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('walks the presentation budget one pass at a time and ends on the escalation slot', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      // パス1: owner への通常言い直し。
      expect(slotRequests(services, 'owner')).toMatchObject([
        { reviewer: reviewerStep.name, presentationOrdinal: 1 },
      ]);
      expect(slotRequests(services, 'escalation')).toBeUndefined();

      persistPresentation({
        reportDir,
        anomalyId,
        presentationOrdinal: 1,
        reviewerStepName: reviewerStep.name,
        reportName: findingRestatementSlotReportName({
          ownerStepName: reviewerStep.name,
          phase: 'restatement',
          presentationPass: 1,
        }),
      });

      // パス2: 最終枠なので格上げへ回る。
      expect(slotRequests(services, 'owner')).toBeUndefined();
      expect(slotRequests(services, 'escalation')).toMatchObject([
        { reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY, presentationOrdinal: 2 },
      ]);

      persistPresentation({
        reportDir,
        anomalyId,
        presentationOrdinal: 2,
        reviewerStepName: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        reportName: findingRestatementSlotReportName({
          ownerStepName: reviewerStep.name,
          phase: 'escalation',
          presentationPass: 2,
        }),
      });

      // 予算を使い切ったら request は作られない。
      expect(listFindingReviewPublications(reportDir)).toHaveLength(2);
      expect(slotRequests(services, 'owner')).toBeUndefined();
      expect(slotRequests(services, 'escalation')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('recovers an evidence-search publication that was persisted before manager ingest', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(2);
    try {
      persistPresentation({
        reportDir,
        anomalyId,
        presentationOrdinal: 2,
        reviewerStepName: reviewerStep.name,
        reportName: 'evidence-search-recovery',
        repairOrigin: 'evidence-search',
      });

      const requests = services.optionsBuilder.buildFindingEvidenceSearchRequests({
        ownerReviewerSteps: [reviewerStep as AgentWorkflowStep],
        reviewScopeSnapshotId,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        ownerReviewerStepName: reviewerStep.name,
        reportContent: expect.stringContaining('architecture-review restatement report.'),
        request: expect.objectContaining({ anomalyId }),
      });
    } finally {
      cleanup();
    }
  });

  it('escalates the only presentation when presentationLimit is 1', () => {
    const { services, cleanup } = makeServices(1);
    try {
      expect(slotRequests(services, 'owner')).toBeUndefined();
      expect(slotRequests(services, 'escalation')).toMatchObject([
        { reviewer: FINDING_ESCALATION_REVIEWER_ROUTING_KEY, presentationOrdinal: 1 },
      ]);
    } finally {
      cleanup();
    }
  });

  it('keeps the last presentation on the owner when the owner profile declares no escalate', () => {
    const { services, cleanup } = makeServices(1, { escalates: false });
    try {
      expect(slotRequests(services, 'owner')).toMatchObject([
        { reviewer: reviewerStep.name, presentationOrdinal: 1 },
      ]);
      expect(slotRequests(services, 'escalation')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('marks the owner call as a full re-review while a non-intake anomaly is outstanding', () => {
    const { services, cleanup } = makeServices(2, { nonIntakeAnomaly: true });
    try {
      const contexts = services.optionsBuilder.buildFindingRestatementSlotContexts({
        ownerReviewerSteps: [reviewerStep as AgentWorkflowStep],
        reviewScopeSnapshotId,
      });
      const ownerContexts = contexts.get(reviewerStep.name);

      // 非 intake anomaly の決着条件は「そのレビュアーの後続完全レビュー成立」。
      // 言い直しだけの publication で取り下げると決着の前提が偽になる。
      expect(ownerContexts?.ownerNeedsFullReview).toBe(true);
      // 兼務: 言い直し request も同じ owner 呼び出しへ載る。
      const presentation = ownerContexts?.owner?.reviewer?.presentationContext;
      expect(presentation?.revision === 2 && presentation.restatementRequests).toMatchObject([
        { reviewer: reviewerStep.name, presentationOrdinal: 1 },
      ]);
    } finally {
      cleanup();
    }
  });

  it('still builds an owner call for a non-intake anomaly with no restatement request left', () => {
    const { services, reportDir, anomalyId, cleanup } = makeServices(1, { nonIntakeAnomaly: true });
    try {
      // 言い直し予算を使い切らせる（intake 側の request は0件になる）。
      persistPresentation({
        reportDir,
        anomalyId,
        presentationOrdinal: 1,
        reviewerStepName: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        reportName: findingRestatementSlotReportName({
          ownerStepName: reviewerStep.name,
          phase: 'escalation',
          presentationPass: 1,
        }),
      });
      const ownerContexts = services.optionsBuilder.buildFindingRestatementSlotContexts({
        ownerReviewerSteps: [reviewerStep as AgentWorkflowStep],
        reviewScopeSnapshotId,
      }).get(reviewerStep.name);

      expect(ownerContexts?.ownerNeedsFullReview).toBe(true);
      const presentation = ownerContexts?.owner?.reviewer?.presentationContext;
      expect(presentation?.revision === 2 && presentation.restatementRequests).toEqual([]);
    } finally {
      cleanup();
    }
  });

  /**
   * 実走行(2026-08-07)の停止事故の入口。終端処分は提示回数が正本と食い違えば
   * 予算を残したまま確定し得る。その状態で提示を続けると、言い直しが照合を通った
   * 瞬間に promotion が付いて終端処分と同居し、台帳不変条件で run ごと落ちる。
   * 終端後は owner 枠も格上げ枠も request を作らない。
   */
  it('stops presenting an intake anomaly once it carries a terminal disposition', () => {
    const { services, cleanup } = makeServices(2, { terminallyDisposed: true });
    try {
      expect(slotRequests(services, 'owner')).toBeUndefined();
      expect(slotRequests(services, 'escalation')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('re-issues the same request when a pass produced no publication', () => {
    const { services, cleanup } = makeServices(2);
    try {
      const first = slotRequests(services, 'owner');
      expect(first).toMatchObject([{ presentationOrdinal: 1 }]);
      // publication が成立しなかったパスの後も、同じ ordinal・同じ request ID。
      expect(slotRequests(services, 'owner')).toEqual(first);
    } finally {
      cleanup();
    }
  });
});

describe('FC restatement slot — owner 別 batch の枠按分', () => {
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
  function makeServices(
    ownerNames: readonly string[],
    anomaliesPerOwner: number,
    options: { blankClaimAtom?: boolean } = {},
  ) {
    const cwd = process.cwd();
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-restatement-allocation-'));
    const runPaths = {
      ...buildRunPaths(cwd, 'restatement-slot-allocation'),
      reportsAbs: reportDir,
    };
    const observedAt = {
      runId: 'run-restatement-allocation',
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
        rawExcerpt: options.blankClaimAtom === true
          ? '   '
          : `Claim ${owner} ${index} must be restated.`,
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
        missingRequirements: ['target'],
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

  it('1呼び出しに載せる言い直し要求は10件まで（残りは同じラウンドの次のパスへ）', () => {
    const ownerNames = ['review-a', 'review-b'];
    const { services, cleanup } = makeServices(ownerNames, 64);
    try {
      const contexts = services.optionsBuilder.buildFindingRestatementSlotContexts({
        ownerReviewerSteps: ownerNames.map(ownerStepFor),
        reviewScopeSnapshotId,
      });

      const requestsFor = (owner: string) => {
        const presentation = contexts.get(owner)?.escalation?.reviewer?.presentationContext;
        return presentation?.revision === 2 ? presentation.restatementRequests : [];
      };
      // 投与量効果の実測（10件超で回答率が半減）に合わせた上限。
      expect(requestsFor('review-a')).toHaveLength(10);
      expect(requestsFor('review-b')).toHaveLength(10);

      // 各 batch は自分の owner の anomaly だけを載せる。
      for (const owner of ownerNames) {
        const requests = requestsFor(owner);
        expect(requests.every(
          (request) => request.reviewer === FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
        )).toBe(true);
        expect(new Set(requests.map(({ anomalyId }) => anomalyId)).size).toBe(requests.length);
      }
    } finally {
      cleanup();
    }
  });

  it('照合できる claim 本文を選べない観測には言い直し要求を作らない', () => {
    // description も rawExcerpt も claimedExcerpt も持たない観測。request の文面
    // （title へのフォールバック）と照合ゲートが要求する文字列が乖離するため、
    // どう答えても受理されない request になってしまう。
    const { services, cleanup } = makeServices(['review-a'], 1, { blankClaimAtom: true });
    try {
      const contexts = services.optionsBuilder.buildFindingRestatementSlotContexts({
        ownerReviewerSteps: [ownerStepFor('review-a')],
        reviewScopeSnapshotId,
      });

      expect(contexts.has('review-a')).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('FC restatement slot — direct provider call wiring', () => {
  // 実際の owner context は必ず request を載せている（載っていない context は
  // 呼び出し自体が発行されない）。空 request の fixture を使うと「request が
  // 無ければ呼ばない」という実装契約を素通りする。
  const makeSlotContext = (anomalyId: string) => {
    const requestWithoutId = {
      anomalyId,
      reviewer: 'architecture-review',
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '5'.repeat(64),
      sourceExcerptDigest: '7'.repeat(64),
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: [] as const,
      missingRequirements: [] as const,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    return {
      ledgerSummary: { findings: [] },
      reportLedgerSummary: { findings: [] },
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        reviewScopeSnapshotId: '5'.repeat(64),
        presentationContext: createFindingReviewPresentationContextV2({
          reviewScopeSnapshotId: '5'.repeat(64),
          restatementRequests: [{
            ...requestWithoutId,
            restatementRequestId: computeRestatementRequestId(requestWithoutId),
          }],
        }),
      },
    };
  };

  const slotContext = makeSlotContext('RA-1');

  const makeOwnerStep = (name: string) => ({
    kind: 'agent' as const,
    name,
    persona: `${name}-persona`,
    instruction: 'Review.',
    outputContracts: [{ name, format: `${name} report format.` }],
  }) as unknown as AgentWorkflowStep;

  const ownerReviewerStep = makeOwnerStep('architecture-review');

  type OwnerContexts = {
    owner?: unknown;
    ownerNeedsFullReview: boolean;
    escalation?: unknown;
  };

  function createRunnerInput(overrides: {
    resumeResult?: unknown;
    /** report 名ごとの保存済み publication（中断した run の再開を模す）。 */
    resumeByReportName?: Record<string, unknown>;
    prepareResult?: unknown;
    ownerReviewerSteps?: readonly AgentWorkflowStep[];
    /** パスごとの context。省略時は「毎パス escalation 枠あり」。 */
    contextsPerPass?: readonly ReadonlyMap<string, OwnerContexts>[];
    escalatingOwners?: readonly string[];
    presentationLimit?: number;
  } = {}) {
    const ownerReviewerSteps = overrides.ownerReviewerSteps ?? [ownerReviewerStep];
    const escalatingOwners = new Set(
      overrides.escalatingOwners ?? ownerReviewerSteps.map((step) => step.name),
    );
    const recordSynthesizedAgentUsage = vi.fn();
    const prepareFindingReviewPublication = vi.fn().mockImplementation((call: { step: { outputContracts?: { name: string }[] } }) => Promise.resolve(
      overrides.prepareResult ?? {
        publication: { publicationId: `pub-${call.step.outputContracts?.[0]?.name ?? 'slot'}` },
      },
    ));
    const stepExecutor = {
      recordSynthesizedAgentUsage,
      resumeFindingReviewPublication: vi.fn().mockImplementation(
        (call: { step: { outputContracts?: { name: string }[] } }) => {
          const reportName = call.step.outputContracts?.[0]?.name ?? '';
          return Promise.resolve(
            overrides.resumeByReportName === undefined
              ? overrides.resumeResult
              : overrides.resumeByReportName[reportName],
          );
        },
      ),
      buildInstruction: vi.fn().mockReturnValue('restatement instruction'),
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
      // 合成ステップは provider/model を直接指定して組まれるので、解決結果は
      // その値になる。owner ステップ（未指定）は profile 解決を模す。
      resolveStepProviderModel: vi.fn((step: { name: string; model?: string }) => ({
        provider: 'mock',
        model: step.model ?? 'weak-model',
        ...(escalatingOwners.has(step.name) ? { escalation: ESCALATION_TARGET } : {}),
      })),
    };
    const defaultContexts: ReadonlyMap<string, OwnerContexts> = new Map(
      ownerReviewerSteps.map((step) => [
        step.name,
        { escalation: slotContext, ownerNeedsFullReview: false },
      ] as const),
    );
    let pass = 0;
    const buildSlotContexts = vi.fn(() => {
      const perPass = overrides.contextsPerPass;
      const contexts = perPass === undefined
        ? defaultContexts
        : perPass[pass] ?? new Map<string, OwnerContexts>();
      pass += 1;
      return contexts;
    });
    const ingest = vi.fn().mockResolvedValue(undefined);
    return {
      input: {
        ownerReviewerSteps,
        buildSlotContexts,
        ingest,
        reviewScopeSnapshotId: '5'.repeat(64),
        parentStepName: 'reviewers',
        stepIteration: 1,
        state: { iteration: 1 },
        task: 'Improve the code.',
        maxSteps: 20,
        optionsBuilder,
        stepExecutor,
        updatePersonaSession: vi.fn(),
        presentationLimit: overrides.presentationLimit ?? 1,
      } as unknown as Parameters<typeof runFindingRestatementSlot>[0],
      stepExecutor,
      optionsBuilder,
      buildSlotContexts,
      ingest,
    };
  }

  beforeEach(() => {
    executeAgentMock.mockReset();
  });

  const doneResponse = (persona: string): AgentResponse => ({
    persona,
    status: 'done',
    content: '{}',
    timestamp: new Date(),
  });

  it('publishes through the ordinary intake pipeline, ingests the pass and records synthesized usage', async () => {
    executeAgentMock.mockResolvedValue({
      ...doneResponse('architecture-review-persona'),
      sessionId: 'session-slot',
    });
    const { input, stepExecutor, ingest } = createRunnerInput();

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(ingest).toHaveBeenCalledTimes(1);
    const ingested = ingest.mock.calls[0]![0] as { subStep: AgentWorkflowStep }[];
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.subStep.name).toBe(FINDING_ESCALATION_REVIEWER_ROUTING_KEY);
    // slot も1本道: markdown レポート + 正規化係。構造化出力は載らない。
    expect(ingested[0]!.subStep.structuredOutput).toBeUndefined();
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
        presentationContext: slotContext.reviewer.presentationContext,
        // Phase 2 が step 名から context を組み直すと restatement-only 契約が
        // 消えるため、Phase 1 と同じ context を明示的に渡す。mode も同じ値でなければ
        // Phase 2 だけ通常レビュー契約に化ける。
        findingContractContext: expect.objectContaining({
          reviewer: expect.objectContaining({
            presentationContext: slotContext.reviewer.presentationContext,
            mode: 'restatement-only',
          }),
        }),
      }),
    );
  });

  it('stops after one pass when the restatement resolved the anomaly', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, ingest, buildSlotContexts } = createRunnerInput({
      presentationLimit: 4,
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: false }]]),
        new Map(),
      ],
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
    // 2パス目は提示対象が無く、stored publication も無いので終了する。
    expect(buildSlotContexts).toHaveBeenCalledTimes(2);
  });

  it('iterates inline until the presentation budget and hands the last slot to the escalation target', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, ingest, stepExecutor } = createRunnerInput({
      presentationLimit: 3,
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: false }]]),
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: false }]]),
        new Map([[ownerReviewerStep.name, { escalation: slotContext, ownerNeedsFullReview: false }]]),
      ],
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(executeAgentMock).toHaveBeenCalledTimes(3);
    expect(ingest).toHaveBeenCalledTimes(3);
    const preparedSteps = stepExecutor.prepareFindingReviewPublication.mock.calls
      .map((call) => (call[0] as { step: AgentWorkflowStep }).step);
    expect(preparedSteps.map((step) => step.name)).toEqual([
      ownerReviewerStep.name,
      ownerReviewerStep.name,
      FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    ]);
    // 反復ごとに別の publication identity になる（同じ report 名だと計上されない）。
    expect(preparedSteps.map((step) => step.outputContracts?.[0]?.name)).toEqual([
      'followup-architecture-review-1',
      'followup-architecture-review-2',
      'escalation-reviewer-architecture-review-3',
    ]);
    // 最終枠だけ格上げ先モデルへ回る。
    expect(preparedSteps.map((step) => step.model)).toEqual([
      'weak-model',
      'weak-model',
      'strong-model',
    ]);
  });

  it('issues a full re-review under the owner name so the withdrawal condition can be met', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, stepExecutor, ingest } = createRunnerInput({
      presentationLimit: 3,
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: true }]]),
        new Map(),
      ],
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    const preparedStep = (stepExecutor.prepareFindingReviewPublication.mock.calls[0]![0] as {
      step: AgentWorkflowStep;
    }).step;
    // 取り下げ根拠は publication の reviewerStepName で照合されるため、owner 名で
    // 公開されなければならない。
    expect(preparedStep.name).toBe(ownerReviewerStep.name);
    // 完全な再レビューなので owner のレビュー手順をそのまま使う。
    expect(preparedStep.instruction).toBe(ownerReviewerStep.instruction);
    expect(ingest).toHaveBeenCalledTimes(1);
    // withdrawal の根拠になるのはこの publication だけ。
    expect((ingest.mock.calls[0]![0] as { reviewEvidence?: string }[])[0])
      .toMatchObject({ reviewEvidence: 'review' });
  });

  it('issues the owner full re-review at most once per round', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const fullReviewContexts = new Map([
      [ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: true }],
    ]);
    const { input, stepExecutor, ingest } = createRunnerInput({
      presentationLimit: 3,
      // 非 intake anomaly が決着しないまま毎パス残っている状況。
      contextsPerPass: [fullReviewContexts, fullReviewContexts, fullReviewContexts],
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    const prepared = stepExecutor.prepareFindingReviewPublication.mock.calls
      .map((call) => call[0] as {
        step: AgentWorkflowStep;
        findingContractContext: { reviewer?: { mode?: string } };
      });
    // フルレビューは1パス目だけ。2パス目以降も言い直しは出るが、
    // restatement-only へ格下げされる。
    expect(prepared).toHaveLength(3);
    expect(prepared.map((call) => call.findingContractContext.reviewer?.mode)).toEqual([
      'review',
      'restatement-only',
      'restatement-only',
    ]);
    expect(prepared.map((call) => call.step.instruction)).toEqual([
      ownerReviewerStep.instruction,
      'Restate the requested claims for the owning reviewer.',
      'Restate the requested claims for the owning reviewer.',
    ]);
    // 取り下げの根拠になるのはフルレビューの publication だけ。言い直しだけの
    // publication で withdrawal が走ると、未検証のまま anomaly が決着する。
    const ingested = ingest.mock.calls.map(
      (call) => (call[0] as { reviewEvidence?: string }[])[0]!.reviewEvidence,
    );
    expect(ingested).toEqual(['review', 'none', 'none']);
  });

  it('keeps the restatement-only instruction when no non-intake anomaly is outstanding', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, stepExecutor, ingest } = createRunnerInput({
      presentationLimit: 2,
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: false }]]),
        new Map(),
      ],
    });

    await runFindingRestatementSlot(input);

    const preparedStep = (stepExecutor.prepareFindingReviewPublication.mock.calls[0]![0] as {
      step: AgentWorkflowStep;
    }).step;
    expect(preparedStep.name).toBe(ownerReviewerStep.name);
    expect(preparedStep.instruction).not.toBe(ownerReviewerStep.instruction);
    // 言い直しだけの publication は「完全なレビューが成立した」証跡にならない。
    expect((ingest.mock.calls[0]![0] as { reviewEvidence?: string }[])[0])
      .toMatchObject({ reviewEvidence: 'none' });
  });

  it('stops at the presentation budget even when requests keep coming', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, ingest } = createRunnerInput({ presentationLimit: 2 });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it('issues one call per owner reviewer and keeps each owner persona and report separate', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('reviewer'));
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor, ingest } = createRunnerInput({ ownerReviewerSteps: owners });

    await runFindingRestatementSlot(input);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(executeAgentMock.mock.calls.map((call) => call[0])).toEqual([
      'architecture-review-persona',
      'security-review-persona',
    ]);
    const preparedSteps = stepExecutor.prepareFindingReviewPublication.mock.calls
      .map((call) => (call[0] as { step: AgentWorkflowStep }).step);
    expect(preparedSteps.map((step) => step.outputContracts?.[0]?.name)).toEqual([
      'escalation-reviewer-architecture-review-1',
      'escalation-reviewer-security-review-1',
    ]);
    expect(preparedSteps.map((step) => step.outputContracts?.[0]?.format)).toEqual([
      'architecture-review report format.',
      'security-review report format.',
    ]);
    // 1パスの publication はまとめて1回の manager 取り込みへ渡す。
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toHaveLength(2);
  });

  it('ingests already-published results of the same pass when a later owner goes terminal', async () => {
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor, ingest } = createRunnerInput({ ownerReviewerSteps: owners });
    executeAgentMock
      .mockResolvedValueOnce(doneResponse('architecture-review-persona'))
      .mockResolvedValueOnce({
        persona: 'security-review-persona',
        status: 'error',
        content: '',
        error: 'provider exploded',
        timestamp: new Date(),
      } satisfies AgentResponse);

    const outcome = await runFindingRestatementSlot(input);

    // 親ステップが terminal になっても、先行 owner の永続化済み publication は
    // 台帳へ到達させる。次の機会の resume はこの取り込みの代替ではない。
    expect(outcome).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toHaveLength(1);
  });

  it('skips the escalation slot for owners whose profile declares no escalate', async () => {
    const owners = [makeOwnerStep('architecture-review'), makeOwnerStep('security-review')];
    const { input, stepExecutor } = createRunnerInput({
      ownerReviewerSteps: owners,
      escalatingOwners: ['security-review'],
    });
    executeAgentMock.mockResolvedValue(doneResponse('reviewer'));

    await runFindingRestatementSlot(input);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(executeAgentMock.mock.calls[0]![0]).toBe('security-review-persona');
    // 格上げ先を持たない owner は escalation 枠の resume 探索すら行わない。
    const escalationProbes = stepExecutor.resumeFindingReviewPublication.mock.calls
      .map((call) => (call[0] as { step: AgentWorkflowStep }).step)
      .filter((step) => step.name === FINDING_ESCALATION_REVIEWER_ROUTING_KEY);
    expect(escalationProbes.map((step) => step.outputContracts?.[0]?.name)).toEqual([
      'escalation-reviewer-security-review-1',
    ]);
  });

  it('runs phase 1 with read-only tools so it can read the code it must quote', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, optionsBuilder } = createRunnerInput();

    await runFindingRestatementSlot(input);

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

    const outcome = await runFindingRestatementSlot(input);

    expect(outcome).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
  });

  it('collects every stored slot publication across passes without issuing a provider call', async () => {
    // 中断した run: パス1と2の publication は永続化済みで、まだ manager へ
    // 渡っていない。パス1だけ回収して止めると、パス2の証拠が恒久的に孤児化する
    // （提示予算は消費済みなのに台帳へ届かない）。
    const { input, stepExecutor, ingest } = createRunnerInput({
      presentationLimit: 4,
      contextsPerPass: [new Map(), new Map(), new Map(), new Map()],
      resumeByReportName: {
        'followup-architecture-review-1': {
          publication: { publicationId: 'pub-resumed-1' },
          response: { status: 'done' },
        },
        'followup-architecture-review-2': {
          publication: { publicationId: 'pub-resumed-2' },
          response: { status: 'done' },
        },
      },
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls.map(
      (call) => (call[0] as { publication: { publicationId: string } }[])[0]!.publication.publicationId,
    )).toEqual(['pub-resumed-1', 'pub-resumed-2']);
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
  });

  it('adopts the persisted call mode when resuming, not the mode of the resuming pass', async () => {
    // 中断前は言い直しだけで走った publication。再開時に「今回はフルレビュー枠」と
    // 判定されても、その publication がフルレビューの証拠に化けてはならない
    // （化けると未レビューの anomaly が withdrawal で未検証のまま決着する）。
    const { input, ingest } = createRunnerInput({
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { ownerNeedsFullReview: true }]]),
        new Map(),
      ],
      resumeByReportName: {
        'followup-architecture-review-1': {
          publication: { publicationId: 'pub-resumed-restatement' },
          response: { status: 'done' },
          reviewerCallMode: 'restatement-only',
        },
      },
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();

    expect(ingest).toHaveBeenCalledTimes(1);
    expect((ingest.mock.calls[0]![0] as { reviewEvidence?: string }[])[0])
      .toMatchObject({ reviewEvidence: 'none' });
  });

  it('stamps the call mode onto the publication it prepares', async () => {
    executeAgentMock.mockResolvedValue(doneResponse('architecture-review-persona'));
    const { input, stepExecutor } = createRunnerInput({
      presentationLimit: 2,
      contextsPerPass: [
        new Map([[ownerReviewerStep.name, { owner: slotContext, ownerNeedsFullReview: true }]]),
        new Map(),
      ],
    });

    await runFindingRestatementSlot(input);

    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerCallMode: 'review' }),
    );
  });

  it('regenerates the restatement when the stored report is rejected by the normalizer', async () => {
    // 壊れた報告は読み直しても直らない。ここで打ち切ると同じ stored 報告を
    // 読み続けて提示枠が永久に塞がる（記録の破棄は resume 側が行う）。
    executeAgentMock.mockResolvedValue({
      persona: 'reviewer',
      status: 'done',
      content: 'regenerated restatement report',
      timestamp: new Date(),
    } satisfies AgentResponse);
    const { input, stepExecutor } = createRunnerInput({
      resumeResult: {
        reportRejection: { reason: 'report text could not be bound', reportContent: '{"rawFindings":[]}' },
      },
    });

    await runFindingRestatementSlot(input);

    // 新規生成の経路へ落ちる: provider 呼び出しと publication 準備が走る。
    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(stepExecutor.prepareFindingReviewPublication).toHaveBeenCalledOnce();
  });

  it('contributes nothing when the stored report is rejected and no request remains', async () => {
    const { input, stepExecutor, ingest } = createRunnerInput({
      contextsPerPass: [new Map()],
      resumeResult: {
        reportRejection: { reason: 'report text could not be bound', reportContent: '{"rawFindings":[]}' },
      },
    });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does nothing when there is neither a request nor a stored publication', async () => {
    const { input, stepExecutor, ingest } = createRunnerInput({ contextsPerPass: [new Map()] });

    expect(await runFindingRestatementSlot(input)).toBeUndefined();
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(stepExecutor.prepareFindingReviewPublication).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('FC restatement slot — caller reaches the runner after the manager round', () => {
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

  it('calls the slot runner even when this round has no restatement request', async () => {
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
    // 今ラウンドは言い直し対象の anomaly が0件 = slot context は空。
    const buildFindingRestatementSlotContexts = vi.fn().mockReturnValue(new Map());
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
        buildFindingRestatementSlotContexts,
        buildFindingEvidenceSearchRequests: vi.fn().mockReturnValue([]),
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
        ledgerIdentity: 'scope-restatement-caller',
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

    expect(buildFindingRestatementSlotContexts).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerReviewerSteps: [expect.objectContaining({ name: reviewerSubStep.name })],
      }),
    );
    // request が0件でも runner へ到達し、未取り込みの stored publication を
    // resume で引き当てにいく。ここで早期 return すると raw findings が永久に
    // intake されない。
    const slotResumeReports = resumeFindingReviewPublication.mock.calls
      .map(([call]) => call.step.outputContracts?.[0]?.name as string | undefined)
      .filter((name): name is string => name !== undefined);
    // owner 側と格上げ側の両方を実際に引き当てにいく。owner 側だけ落とすと、
    // 中断した run の言い直し publication が恒久的に孤児化する。
    expect(slotResumeReports).toContain('followup-architecture-review-1');
    expect(slotResumeReports).toContain('escalation-reviewer-architecture-review-1');
    const slotResumeCalls = resumeFindingReviewPublication.mock.calls.filter(
      ([call]) => call.step.outputContracts?.[0]?.name?.startsWith('followup-')
        || call.step.name === FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    );
    expect(slotResumeCalls[0]![0]).toMatchObject({
      parentStepName: 'reviewers',
      stepIteration: 1,
    });
  });
});
