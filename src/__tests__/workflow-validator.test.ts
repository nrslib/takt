import { describe, expect, it } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { NormalAgentWorkflowStep, WorkflowConfig, WorkflowRule } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';

function createFakeLedgerStore(): FindingLedgerStore {
  return {
    workflowName: 'fake',
    loadLedger: () => ({
      version: 1,
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    }),
    saveLedger: () => {},
    updateLedger: (mutator) => Promise.resolve(mutator({
      version: 1,
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    })),
    createRunCopy: () => '/tmp/fake-ledger-copy.json',
    saveRawFindings: () => '/tmp/fake-raw-findings.json',
    saveManagerValidationReport: () => '/tmp/fake-validation-report.json',
  };
}

function createWorkflow(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    name: 'validator-test',
    description: 'validator test workflow',
    maxSteps: 5,
    initialStep: 'plan',
    steps: [
      {
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
    ...overrides,
  };
}

function createPlanAgent(overrides: Partial<NormalAgentWorkflowStep> = {}): NormalAgentWorkflowStep {
  return {
    name: 'plan',
    persona: 'planner',
    personaDisplayName: 'planner',
    edit: false,
    instruction: '{task}',
    passPreviousResponse: true,
    rules: [{ condition: 'done', next: 'COMPLETE' }],
    ...overrides,
  };
}

function createFindingContractParallelWorkflow(
  rules: WorkflowRule[],
  extraSteps: WorkflowConfig['steps'] = [],
): WorkflowConfig {
  return createWorkflow({
    findingContract: {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    },
    steps: [
      {
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        parallel: [
          {
            name: 'review',
            persona: 'reviewer',
            personaDisplayName: 'reviewer',
            edit: false,
            instruction: 'review',
            passPreviousResponse: true,
            rules: [{ condition: 'approved' }],
          },
        ],
        rules,
      },
      ...extraSteps,
    ],
  });
}

function createValidatorAutoRouting(rules?: AutoRoutingConfig['rules']): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: { provider: 'claude-sdk', model: 'haiku' },
    candidates: [
      {
        name: 'claude',
        description: 'Claude candidate',
        provider: 'claude-sdk',
        model: 'sonnet',
        costTier: 'medium',
      },
      {
        name: 'codex',
        description: 'Codex candidate',
        provider: 'codex',
        model: 'gpt-5-codex',
        costTier: 'medium',
      },
    ],
    ...(rules !== undefined ? { rules } : {}),
  };
}

describe('validateWorkflowConfig', () => {
  it('accepts canonical workflow transitions', () => {
    expect(() => validateWorkflowConfig(createWorkflow(), { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when the resolved opencode provider has no model', () => {
    expect(() => validateWorkflowConfig(createWorkflow(), {
      projectCwd: process.cwd(),
      provider: 'opencode',
    })).toThrow(/provider 'opencode' requires model/);
  });

  it('fails fast when a static auto-routing rule combines a codex provider with an explicit Claude model', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({ model: 'sonnet' })],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { plan: 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast when any dynamic auto-routing candidate is incompatible with an explicit model', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({ model: 'sonnet' })],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting(),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast for incompatible auto-routing on a parallel sub-step', () => {
    const workflow = createWorkflow({
      steps: [{
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
        parallel: [createPlanAgent({ name: 'review', model: 'sonnet' })],
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { review: 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast for incompatible auto-routing on the finding manager', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          model: 'sonnet',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { 'findings-manager': 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast for incompatible auto-routing on the finding interpreter synthesized step', () => {
    // findings-interpreter は findings-manager と設定を共有するが名前が異なる
    // 合成ステップで、auto_routing.rules.steps で別々に routing され得る。
    // manager 側だけ検証すると、interpreter が実行時（曖昧指摘の解釈フェーズ）に
    // 初めて落ち、エラーは捕捉されてバッチ全体が provisional 化されてしまう。
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          model: 'sonnet',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { 'findings-interpreter': 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('validates the finding manager against the deterministic strategy default, not every auto-routing candidate', () => {
    // findings-manager は AI ルーターを通らず、実行時は rules → strategy デフォルト
    // へ決定的に解決される。rules 不一致時に全候補（ここでは実行時に到達しない
    // codex + sonnet の組み合わせ）を検証すると、有効な構成を拒否する偽陽性になる。
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          model: 'sonnet',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting(),
    })).not.toThrow();
  });

  it('fails fast when a loop judge overrides an auto-routed codex step with a Claude model', () => {
    const workflow = createWorkflow({
      loopMonitors: [{
        cycle: ['plan'],
        threshold: 1,
        judge: {
          model: 'sonnet',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { plan: 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast when a loop monitor judge points to an unknown step', () => {
    const workflow = createWorkflow({
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'continue', next: 'missing-step' }],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow('missing-step');
  });

  it('fails fast when findings rules are used without findingContract', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": findings.* conditions require finding_contract',
    );
  });

  it('fails fast when aggregate guard findings rules are used without findingContract', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              rules: [{ condition: 'approved' }],
            },
          ],
          rules: [
            {
              condition: 'all("approved")',
              next: 'COMPLETE',
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
              aggregateGuardCondition: 'findings.open.count == 0',
            },
          ],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": findings.* conditions require finding_contract',
    );
  });

  it('accepts findings rules when findingContract is configured', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          rules: [
            { condition: 'when(findings.open.count == 0)', next: 'COMPLETE' },
            { condition: 'when(findings.conflicts.count > 0)', returnValue: 'need_replan' },
          ],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  // 対策バッチ B1: `next: NEEDS_ADJUDICATION` は provisional fixpoint 判定に
  // findings ledger を要するため、finding-conflict-adjudication と同じ規則で
  // finding_contract を要求する（validateNeedsAdjudicationRuleContract）。
  it('fails fast when a rule routes to NEEDS_ADJUDICATION without findingContract', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          rules: [{ condition: 'fixpoint', next: 'NEEDS_ADJUDICATION' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": next: NEEDS_ADJUDICATION requires finding_contract',
    );
  });

  it('fails fast when a parallel sub-step rule routes to NEEDS_ADJUDICATION without findingContract', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              rules: [{ condition: 'fixpoint', next: 'NEEDS_ADJUDICATION' }],
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in parallel sub-step "review" of step "plan": next: NEEDS_ADJUDICATION requires finding_contract',
    );
  });

  it('fails fast when a loop_monitor judge rule routes to NEEDS_ADJUDICATION without findingContract', () => {
    const workflow = createWorkflow({
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'fixpoint', next: 'NEEDS_ADJUDICATION' }],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid loop_monitor judge rule: next: NEEDS_ADJUDICATION requires finding_contract',
    );
  });

  it('accepts a rule routing to NEEDS_ADJUDICATION when findingContract is configured', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          rules: [
            { condition: 'when(findings.provisional.fixpoint == true)', next: 'NEEDS_ADJUDICATION' },
            { condition: 'when(findings.open.count == 0)', next: 'COMPLETE' },
          ],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when a rule routes to finding-conflict-adjudication without findingContract', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({
        rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
      })],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": next: finding-conflict-adjudication requires finding_contract',
    );
  });

  it('fails fast when a parallel sub-step rule routes to finding-conflict-adjudication without findingContract', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({
        parallel: [createPlanAgent({
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
        })],
      })],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in parallel sub-step "review" of step "plan": next: finding-conflict-adjudication requires finding_contract',
    );
  });

  it('fails fast when a loop_monitor judge rule routes to finding-conflict-adjudication without findingContract', () => {
    const workflow = createWorkflow({
      loopMonitors: [{
        cycle: ['plan', 'plan'],
        threshold: 2,
        judge: {
          rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid loop_monitor judge rule: next: finding-conflict-adjudication requires finding_contract',
    );
  });

  it('accepts step, parallel sub-step, and loop monitor routes to finding-conflict-adjudication when findingContract is configured', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [createPlanAgent({
        rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
        parallel: [createPlanAgent({
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
        })],
      })],
      loopMonitors: [{
        cycle: ['plan', 'plan'],
        threshold: 2,
        judge: {
          rules: [{ condition: 'conflicts', next: 'finding-conflict-adjudication' }],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when finding_contract.manager uses opencode without a model', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          provider: 'opencode',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'claude',
      personaProviders: {
        'findings-manager': {
          provider: 'claude',
          model: 'claude/persona-model',
        },
      },
    })).toThrow(/provider 'opencode' requires model/);
  });

  it('validates finding_contract.manager through workflow provider fallback when manager provider is not direct', () => {
    const workflow = createWorkflow({
      provider: 'opencode',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'claude',
    })).toThrow(/provider 'opencode' requires model/);
  });

  it('validates finding_contract.manager through provider_routing.personas when manager provider is not direct', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          providerRoutingPersonaKey: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'claude',
      providerRouting: {
        personas: {
          'findings-manager': { provider: 'opencode' },
        },
      },
    })).toThrow(/provider 'opencode' requires model/);
  });

  it('prefers finding_contract.manager provider/model over provider_routing and persona_providers', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          providerRoutingPersonaKey: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'claude',
      providerRouting: {
        steps: {
          'findings-manager': { provider: 'opencode' },
        },
        personas: {
          'findings-manager': { provider: 'opencode' },
        },
      },
      personaProviders: {
        'findings-manager': { provider: 'opencode' },
      },
    })).not.toThrow();
  });

  it('v2 梯子設計: findingContract の parallel parent に迂回ルール（invalid manager output rule）はもう要求しない', () => {
    // 旧実装は run-level の invalid_manager_output を迂回ルール
    // （非AI return need_replan / needs_fix / next fix）へ自動選択で流していたため、
    // その存在を設定時に強制していた。v2 では manager の壊れた応答は provisional
    // として台帳へ着地し、run-level の失敗経路が無いため、この要求は撤去された
    // （custom workflow が provisional を処理しない場合はエンジンの COMPLETE
    // 最終不変条件が fail-fast する）。
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              rules: [{ condition: 'approved' }],
            },
          ],
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('accepts loop monitor judge findings rules when findingContract is configured', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when parallel sub-step findings rules are used without findingContract', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              rules: [{ condition: 'when(findings.open.count == 0)' }],
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in parallel sub-step "review" of step "plan": findings.* conditions require finding_contract',
    );
  });

  it('accepts parallel sub-step findings rules when findingContract is configured', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              rules: [{ condition: 'when(findings.open.count == 0)' }],
            },
          ],
          rules: [
            { condition: 'when(findings.open.count == 0)', next: 'COMPLETE' },
            { condition: 'when(findings.conflicts.count > 0)', returnValue: 'need_replan' },
          ],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when loop monitor judge findings rules are used without findingContract', () => {
    const workflow = createWorkflow({
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid loop_monitor judge rule: findings.* conditions require finding_contract',
    );
  });

  it('fails fast when findingContract parallel sub-steps already declare structuredOutput', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'review',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              edit: false,
              instruction: 'review',
              passPreviousResponse: true,
              structuredOutput: {
                schemaRef: 'existing.schema',
                schema: { type: 'object' },
              },
              rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid parallel sub-step "review" in step "plan": cannot combine finding_contract raw findings with structured_output',
    );
  });

  it('fails fast when a normal finding-contract producer also declares structuredOutput', () => {
    const workflow = createWorkflow({
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json', rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [createPlanAgent({
        outputContracts: [{ type: 'report', formatRef: 'review-finding-contract' }],
        structuredOutput: { schemaRef: 'schema', schema: { type: 'object' } },
      })],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid step "plan": cannot combine finding_contract raw findings with structured_output',
    );
  });

  it('fails fast when workflow_call is configured without workflowCallResolver', () => {
    const workflow = createWorkflow({
      initialStep: 'delegate',
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          personaDisplayName: 'delegate',
          instruction: '',
          passPreviousResponse: true,
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Configuration error: workflowCallResolver is required when workflow contains workflow_call steps',
    );
  });

  it('fails fast when parallel workflow_call is configured without workflowCallResolver', () => {
    const workflow = createWorkflow({
      initialStep: 'reviewers',
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'delegate',
              kind: 'workflow_call',
              call: 'takt/coding',
              personaDisplayName: 'delegate',
              instruction: '',
              passPreviousResponse: true,
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Configuration error: workflowCallResolver is required when workflow contains workflow_call steps',
    );
  });

  it('fails fast when a parallel step contains duplicate sibling sub-step names', () => {
    const workflow = createWorkflow({
      initialStep: 'reviewers',
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'delegate',
              persona: 'reviewer-a',
              personaDisplayName: 'reviewer-a',
              instruction: 'review api',
              passPreviousResponse: true,
              rules: [{ condition: 'approved', next: 'COMPLETE' }],
            },
            {
              name: 'delegate',
              persona: 'reviewer-b',
              personaDisplayName: 'reviewer-b',
              instruction: 'review ui',
              passPreviousResponse: true,
              rules: [{ condition: 'approved', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Configuration error: parallel step "reviewers" contains duplicate sub-step name "delegate"',
    );
  });

  it('accepts the same parallel sub-step name under different parent steps', () => {
    const workflow = createWorkflow({
      initialStep: 'api-reviewers',
      steps: [
        {
          name: 'api-reviewers',
          personaDisplayName: 'api-reviewers',
          instruction: 'review api',
          parallel: [
            {
              name: 'delegate',
              persona: 'api-reviewer',
              personaDisplayName: 'api-reviewer',
              instruction: 'review api',
              passPreviousResponse: true,
              rules: [{ condition: 'approved', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'all("approved")', next: 'ui-reviewers' }],
        },
        {
          name: 'ui-reviewers',
          personaDisplayName: 'ui-reviewers',
          instruction: 'review ui',
          parallel: [
            {
              name: 'delegate',
              persona: 'ui-reviewer',
              personaDisplayName: 'ui-reviewer',
              instruction: 'review ui',
              passPreviousResponse: true,
              rules: [{ condition: 'approved', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it.each([
    [
      'system step',
      {
        name: 'cleanup',
        kind: 'system',
        session: 'compact',
        personaDisplayName: 'cleanup',
        instruction: '',
        systemInputs: [],
        effects: [],
        passPreviousResponse: true,
      },
      'Configuration error: step "cleanup": session is only supported on agent steps and parallel sub-steps',
    ],
    [
      'workflow_call step',
      {
        name: 'delegate',
        kind: 'workflow_call',
        call: 'takt/coding',
        session: 'compact',
        personaDisplayName: 'delegate',
        instruction: '',
        passPreviousResponse: true,
      },
      'Configuration error: step "delegate": session is only supported on agent steps and parallel sub-steps',
    ],
    [
      'parallel parent step',
      {
        name: 'reviewers',
        persona: 'reviewer',
        personaDisplayName: 'reviewer',
        instruction: 'review',
        session: 'compact',
        parallel: [
          {
            name: 'api-review',
            persona: 'reviewer',
            personaDisplayName: 'reviewer',
            instruction: 'review api',
            passPreviousResponse: true,
          },
        ],
        passPreviousResponse: true,
      },
      'Configuration error: step "reviewers": session is only supported on normal agent steps and parallel sub-steps',
    ],
    [
      'empty parallel parent step',
      {
        name: 'reviewers',
        persona: 'reviewer',
        personaDisplayName: 'reviewer',
        instruction: 'review',
        session: 'compact',
        parallel: [],
        passPreviousResponse: true,
      },
      'Configuration error: step "reviewers": session is only supported on normal agent steps and parallel sub-steps',
    ],
    [
      'arpeggio parent step',
      {
        name: 'batch',
        persona: 'worker',
        personaDisplayName: 'worker',
        instruction: 'batch',
        session: 'compact',
        arpeggio: {},
        passPreviousResponse: true,
      },
      'Configuration error: step "batch": session is only supported on normal agent steps and parallel sub-steps',
    ],
    [
      'team_leader parent step',
      {
        name: 'split',
        persona: 'leader',
        personaDisplayName: 'leader',
        instruction: 'split',
        session: 'compact',
        teamLeader: {},
        passPreviousResponse: true,
      },
      'Configuration error: step "split": session is only supported on normal agent steps and parallel sub-steps',
    ],
  ])('rejects session compact on programmatic %s', (_label, step, message) => {
    const workflow = createWorkflow({
      initialStep: step.name,
      steps: [step as unknown as WorkflowConfig['steps'][number]],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      workflowCallResolver: () => null,
    })).toThrow(message);
  });

  describe('finding_contract scope for output_contracts and workflow_call inheritance', () => {
    it('fails fast when a step uses a *-finding-contract report format but the workflow has no finding_contract', () => {
      const workflow = createWorkflow({
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            personaDisplayName: 'planner',
            edit: false,
            instruction: '{task}',
            passPreviousResponse: true,
            rules: [{ condition: 'done', next: 'COMPLETE' }],
            outputContracts: [
              { name: 'plan.md', format: 'plan-review-body', formatRef: 'plan-review-finding-contract' },
            ],
          },
        ],
      });

      expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
        /has no finding_contract \(own or inherited via workflow_call\).*step "plan" uses format "plan-review-finding-contract"/s,
      );
    });

    it('fails fast when a parallel sub-step uses a *-finding-contract report format but the workflow has no finding_contract', () => {
      const workflow = createWorkflow({
        initialStep: 'reviewers',
        steps: [
          {
            name: 'reviewers',
            personaDisplayName: 'reviewers',
            instruction: 'review',
            parallel: [
              {
                name: 'final-gate',
                persona: 'merge-readiness-reviewer',
                personaDisplayName: 'merge-readiness-reviewer',
                edit: false,
                instruction: 'review',
                passPreviousResponse: true,
                rules: [{ condition: 'approved' }],
                outputContracts: [
                  { name: 'merge-readiness-review.md', format: 'body', formatRef: 'merge-readiness-review-finding-contract' },
                ],
              },
            ],
            rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
          },
        ],
      });

      expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
        /step "reviewers\.final-gate" uses format "merge-readiness-review-finding-contract"/,
      );
    });

  it('accepts a *-finding-contract report format when the workflow declares its own finding_contract', () => {
      const workflow = createWorkflow({
        findingContract: {
          ledgerPath: '.takt/findings/peer-review.json',
          rawFindingsPath: '.takt/findings/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            outputContract: 'findings-manager',
          },
        },
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            personaDisplayName: 'planner',
            edit: false,
            instruction: '{task}',
            passPreviousResponse: true,
            rules: [{ condition: 'done', next: 'COMPLETE' }],
            outputContracts: [
              { name: 'plan.md', format: 'plan-review-body', formatRef: 'plan-review-finding-contract' },
            ],
          },
        ],
      });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('accepts a *-finding-contract report format when a finding_contract is inherited from a workflow_call parent', () => {
      const workflow = createWorkflow({
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            personaDisplayName: 'planner',
            edit: false,
            instruction: '{task}',
            passPreviousResponse: true,
            rules: [{ condition: 'done', next: 'COMPLETE' }],
            outputContracts: [
              { name: 'plan.md', format: 'plan-review-body', formatRef: 'plan-review-finding-contract' },
            ],
          },
        ],
      });

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/peer-review.json',
            rawFindingsPath: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).not.toThrow();
    });

    it('accepts findings.* rules when a finding_contract is inherited from a workflow_call parent', () => {
      const workflow = createWorkflow({
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            personaDisplayName: 'planner',
            edit: false,
            instruction: '{task}',
            passPreviousResponse: true,
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
          },
        ],
      });

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/peer-review.json',
            rawFindingsPath: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).not.toThrow();
    });

    it('fails fast when a subworkflow requires an inherited Finding Contract but is run directly', () => {
      const workflow = createWorkflow({
        name: 'finding-contract-child',
        subworkflow: { callable: true, requiresFindingContract: true },
      });

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
      })).toThrow(
        /workflow "finding-contract-child" requires a finding_contract inherited from a workflow_call caller/,
      );
    });

    it('accepts a subworkflow requirement when the caller supplies the inherited Finding Contract', () => {
      const workflow = createWorkflow({
        name: 'finding-contract-child',
        subworkflow: { callable: true, requiresFindingContract: true },
      });

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/peer-review.json',
            rawFindingsPath: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).not.toThrow();
    });

    it('fails fast when a workflow declares its own finding_contract while also inheriting one from a workflow_call parent', () => {
      const workflow = createWorkflow({
        findingContract: {
          ledgerPath: '.takt/findings/own.json',
          rawFindingsPath: '.takt/findings/own/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            outputContract: 'findings-manager',
          },
        },
      });

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/parent.json',
            rawFindingsPath: '.takt/findings/parent/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).toThrow(
        /declares its own finding_contract while also being called as a workflow_call subworkflow that inherits/,
      );
    });

    it('fails fast when finding_contract.manager uses opencode without a model and the contract is inherited from a workflow_call parent', () => {
      const workflow = createWorkflow();

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        provider: 'claude',
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/peer-review.json',
            rawFindingsPath: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
              provider: 'opencode',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).toThrow(/provider 'opencode' requires model/);
    });

    it('accepts a valid finding_contract.manager provider/model inherited from a workflow_call parent', () => {
      const workflow = createWorkflow();

      expect(() => validateWorkflowConfig(workflow, {
        projectCwd: process.cwd(),
        provider: 'claude',
        inheritedFindingContract: {
          contract: {
            ledgerPath: '.takt/findings/peer-review.json',
            rawFindingsPath: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              outputContract: 'findings-manager',
              provider: 'codex',
              model: 'gpt-5.5',
            },
          },
          ledgerStore: createFakeLedgerStore(),
        },
      })).not.toThrow();
    });
  });
});
