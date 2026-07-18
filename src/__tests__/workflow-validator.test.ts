import { describe, expect, it } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { NormalAgentWorkflowStep, WorkflowConfig, WorkflowRule } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';

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

  it('fails fast when a findingContract parallel parent cannot route invalid manager output', () => {
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

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid finding_contract step "plan": parallel parent must declare an invalid manager output rule via non-AI return need_replan, non-AI return needs_fix, or non-AI next fix',
    );
  });

  it('accepts return needs_fix as the invalid manager output rule', () => {
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
          rules: [{ condition: 'when(findings.conflicts.count > 0)', returnValue: 'needs_fix' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('accepts non-AI next fix as the invalid manager output rule', () => {
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
          rules: [{ condition: 'when(findings.conflicts.count > 0)', next: 'fix' }],
        },
        {
          name: 'fix',
          persona: 'coder',
          personaDisplayName: 'coder',
          edit: true,
          instruction: 'fix',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it('rejects AI next fix as the only invalid manager output rule', () => {
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
          rules: [
            {
              condition: 'ai("Invalid manager output can be fixed by code changes")',
              next: 'fix',
              isAiCondition: true,
              aiConditionText: 'Invalid manager output can be fixed by code changes',
            },
          ],
        },
        {
          name: 'fix',
          persona: 'coder',
          personaDisplayName: 'coder',
          edit: true,
          instruction: 'fix',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid finding_contract step "plan": parallel parent must declare an invalid manager output rule via non-AI return need_replan, non-AI return needs_fix, or non-AI next fix',
    );
  });

  it.each(['need_replan', 'needs_fix'])(
    'rejects AI return %s as the only invalid manager output rule',
    (returnValue) => {
      const workflow = createFindingContractParallelWorkflow([
        {
          condition: 'ai("Invalid manager output should use this return")',
          returnValue,
          isAiCondition: true,
          aiConditionText: 'Invalid manager output should use this return',
        },
      ]);

      expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
        'Invalid finding_contract step "plan": parallel parent must declare an invalid manager output rule via non-AI return need_replan, non-AI return needs_fix, or non-AI next fix',
      );
    },
  );

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
});
