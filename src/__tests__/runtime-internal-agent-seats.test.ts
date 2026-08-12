import { describe, expect, it } from 'vitest';
import type { FindingContractConfig, WorkflowConfig } from '../core/models/types.js';
import type {
  InternalAgentSeats,
  ProviderEscalationTarget,
  ProviderRoutingConfig,
} from '../core/models/config-types.js';
import { buildFindingManagerStep } from '../core/workflow/findings/manager-step.js';
import { buildFindingTerminalAdjudicationStep } from '../core/workflow/findings/adjudication-step.js';
import {
  findingRestatementSlotReportName,
  resolveFindingEscalationTarget,
} from '../core/workflow/findings/restatement-slot-step.js';
import { resolveRestatementPresentationPhase } from '../core/workflow/findings/restatement-presentation-phase.js';
import { loopJudgeProviderFields } from '../core/workflow/loop-judge-step.js';
import { internalAgentSeatOverride } from '../core/workflow/internal-agent-seat.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';

/**
 * runtime.yaml `provider.targets.internal_agents` の seat は全部オプショナル。
 * 指定した seat だけが step 直指定の層で効き、未指定 seat は従来の既定解決
 * （provider_routing → workflow → …）へそのまま落ちる。
 */

const contract: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Manage the ledger.',
    outputContract: 'findings-manager',
    providerRoutingPersonaKey: 'findings-manager',
  },
  adjudicator: {
    persona: 'supervisor',
    instruction: 'Adjudicate.',
    providerRoutingPersonaKey: 'supervisor',
  },
};

const workflowDefaults = {
  workflowProvider: 'codex' as WorkflowConfig['provider'],
  workflowModel: 'workflow-model',
};

const routing: ProviderRoutingConfig = {
  personas: {
    'findings-manager': { provider: 'claude', model: 'routed-manager' },
    supervisor: { provider: 'claude', model: 'routed-supervisor' },
    'loop-judge': { provider: 'claude', model: 'routed-judge' },
  },
};

const seats: InternalAgentSeats = {
  findingsManager: { provider: 'opencode', model: 'seat-manager' },
  terminalAdjudicator: { provider: 'opencode', model: 'seat-adjudicator' },
  loopJudge: { provider: 'opencode', model: 'seat-judge' },
  escalationReviewer: { provider: 'opencode', model: 'seat-escalation' },
};

describe('internalAgentSeatOverride', () => {
  it('bakes a seat in as a step-direct provider/model', () => {
    expect(internalAgentSeatOverride({
      provider: 'opencode',
      model: 'seat-model',
      providerOptions: { opencode: { agent: 'build' } },
      permissionMode: 'readonly',
    })).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-model',
      modelSpecified: true,
      internalProviderOptions: { opencode: { agent: 'build' } },
      internalPermissionMode: 'readonly',
    });
  });

  it('leaves the exact permission unset when the seat omits it', () => {
    expect(internalAgentSeatOverride({ provider: 'opencode', model: 'seat-model' }))
      .not.toHaveProperty('internalPermissionMode');
  });

  it('returns nothing for an unset seat so the caller keeps the ordinary resolution', () => {
    expect(internalAgentSeatOverride(undefined)).toBeUndefined();
    expect(internalAgentSeatOverride({ model: 'model-only' })).toBeUndefined();
  });

  it('stops model fallback for a seat that names only a provider', () => {
    // provider だけ差し替えて model 解決を下位層へ残すと、別 provider 向けの model が混ざる。
    const step = buildFindingManagerStep({
      contract,
      ...workflowDefaults,
      internalAgentSeats: { findingsManager: { provider: 'codex' } },
    });
    expect(resolveStepProviderModel({ step, providerRouting: routing })).toMatchObject({
      provider: 'codex',
      model: undefined,
    });
  });
});

describe('findings-manager seat', () => {
  it('outranks provider_routing.personas when assigned', () => {
    const step = buildFindingManagerStep({ contract, ...workflowDefaults, internalAgentSeats: seats });
    expect(resolveStepProviderModel({ step, providerRouting: routing })).toMatchObject({
      provider: 'opencode',
      model: 'seat-manager',
      providerSource: 'step',
    });
  });

  it('falls back to persona routing and the workflow defaults without a seat', () => {
    const step = buildFindingManagerStep({ contract, ...workflowDefaults });
    expect(resolveStepProviderModel({ step, providerRouting: routing })).toMatchObject({
      provider: 'claude',
      model: 'routed-manager',
      providerSource: 'provider_routing.personas',
    });
    expect(resolveStepProviderModel({ step })).toMatchObject({
      provider: 'codex',
      model: 'workflow-model',
      providerSource: 'workflow',
    });
  });

  it('keeps an explicit CLI override above the seat', () => {
    const step = buildFindingManagerStep({ contract, ...workflowDefaults, internalAgentSeats: seats });
    expect(resolveStepProviderModel({
      step,
      provider: 'cursor',
      providerSource: 'cli',
      model: 'cli-model',
      modelSource: 'cli',
    })).toMatchObject({ provider: 'cursor', model: 'cli-model', providerSource: 'cli' });
  });
});

describe('terminal-adjudicator seat', () => {
  it('outranks provider_routing.personas when assigned', () => {
    const step = buildFindingTerminalAdjudicationStep({
      contract,
      ...workflowDefaults,
      internalAgentSeats: seats,
    });
    expect(resolveStepProviderModel({ step, providerRouting: routing })).toMatchObject({
      provider: 'opencode',
      model: 'seat-adjudicator',
      providerSource: 'step',
    });
  });

  it('falls back to the supervisor persona routing without a seat', () => {
    const step = buildFindingTerminalAdjudicationStep({ contract, ...workflowDefaults });
    expect(resolveStepProviderModel({ step, providerRouting: routing })).toMatchObject({
      provider: 'claude',
      model: 'routed-supervisor',
      providerSource: 'provider_routing.personas',
    });
  });
});

describe('loop-judge seat', () => {
  it('propagates an explicitly configured permission mode', () => {
    expect(loopJudgeProviderFields({}, {
      loopJudge: { provider: 'opencode', model: 'seat-judge', permissionMode: 'readonly' },
    })).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-judge',
      modelSpecified: true,
      internalPermissionMode: 'readonly',
    });
  });
  it('replaces the workflow judge provider/model when assigned', () => {
    expect(loopJudgeProviderFields({ provider: 'codex', model: 'judge-model' }, seats)).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-judge',
      modelSpecified: true,
    });
  });

  it('keeps the workflow judge fields without a seat', () => {
    expect(loopJudgeProviderFields({ provider: 'codex', model: 'judge-model' }, undefined)).toEqual({
      provider: 'codex',
      model: 'judge-model',
    });
    expect(loopJudgeProviderFields({}, {})).toEqual({});
  });
});

describe('escalation-reviewer seat', () => {
  const escalation = {
    profile: 'strong',
    provider: 'codex' as const,
    model: 'escalate-model',
  };

  it('takes the seat ahead of the reviewer profile escalate target', () => {
    expect(resolveFindingEscalationTarget({ seat: seats.escalationReviewer, escalation }))
      .toEqual({ provider: 'opencode', model: 'seat-escalation' });
  });

  it('uses the escalate target when no seat is assigned', () => {
    expect(resolveFindingEscalationTarget({ seat: undefined, escalation })).toEqual(escalation);
  });

  it('enables no escalation slot when neither is present', () => {
    expect(resolveFindingEscalationTarget({ seat: undefined, escalation: undefined }))
      .toBeUndefined();
  });

  it('does not fire for a reviewer whose profile declares no escalate, seat or not', () => {
    // 発火条件は profile の `escalate` 宣言だけ。seat は「発火したときの宛先」しか
    // 変えない。ここが seat 側に漏れると、意図的に格上げ先を持たない最上位 profile の
    // レビュアーまで最終提示が代打へ移る。
    expect(resolveFindingEscalationTarget({
      seat: seats.escalationReviewer,
      escalation: undefined,
    })).toBeUndefined();
  });

  // WorkflowEngineSetup の escalationEnabled と同じ式。提示フェーズと report 名まで
  // 追って、seat 指定が発火条件を動かさないことを固定する。
  const escalationEnabledFor = (escalation: ProviderEscalationTarget | undefined): boolean => (
    resolveFindingEscalationTarget({ seat: seats.escalationReviewer, escalation }) !== undefined
  );

  it('keeps the last presentation on the owner when the profile has no escalate, even with a seat', () => {
    expect(escalationEnabledFor(undefined)).toBe(false);

    const phase = resolveRestatementPresentationPhase({
      presentedCount: 2,
      presentationLimit: 3,
      escalationEnabled: escalationEnabledFor(undefined),
    });

    expect(phase).toBe('restatement');
    expect(findingRestatementSlotReportName({
      ownerStepName: 'architecture-review',
      phase,
      presentationPass: 3,
    })).toBe('followup-architecture-review-3');
  });

  it('sends the last presentation to the seat when the profile declares escalate', () => {
    expect(escalationEnabledFor(escalation)).toBe(true);

    const phase = resolveRestatementPresentationPhase({
      presentedCount: 2,
      presentationLimit: 3,
      escalationEnabled: escalationEnabledFor(escalation),
    });

    expect(phase).toBe('escalation');
    expect(findingRestatementSlotReportName({
      ownerStepName: 'architecture-review',
      phase,
      presentationPass: 3,
    })).toBe('escalation-reviewer-architecture-review-3');
    expect(resolveFindingEscalationTarget({ seat: seats.escalationReviewer, escalation }))
      .toEqual({ provider: 'opencode', model: 'seat-escalation' });
  });
});
