import { describe, expect, it } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { NormalAgentWorkflowStep, WorkflowConfig } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { getProviderValidationErrorSource } from '../core/workflow/provider-validation-error.js';
import { getWorkflowConfigErrorPath } from '../core/workflow/workflow-config-error.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

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
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    ...overrides,
  };
}

function createProgrammaticDynamicParallelWorkflow(
  fixed: readonly unknown[],
  pool: readonly unknown[],
): WorkflowConfig {
  return {
    ...createWorkflow(),
    initialStep: 'reviewers',
    steps: [{
      name: 'reviewers',
      personaDisplayName: 'reviewers',
      instruction: 'review',
      parallel: {
        kind: 'dynamic',
        fixed,
        pool,
        selection: { mode: 'replace' },
      },
    }],
  } as unknown as WorkflowConfig;
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
        routingTier: 'medium',
      },
      {
        name: 'codex',
        description: 'Codex candidate',
        provider: 'codex',
        model: 'gpt-5-codex',
        routingTier: 'medium',
      },
    ],
    defaultPool: 'general',
    candidatePools: { general: { candidates: ['claude', 'codex'], fallback: 'claude' } },
    ...(rules !== undefined ? { rules } : {}),
  };
}

function createPoolScopedValidatorAutoRouting(): AutoRoutingConfig {
  return {
    ...createValidatorAutoRouting(),
    defaultPool: 'claude-only',
    candidatePools: {
      'claude-only': { candidates: ['claude'], fallback: 'claude' },
      'codex-only': { candidates: ['codex'], fallback: 'codex' },
    },
    poolRules: {
      tags: {
        'claude-only': 'claude-only',
        'codex-only': 'codex-only',
      },
    },
  };
}

describe('validateWorkflowConfig', () => {
  it('accepts valid workflow transitions', () => {
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

  it('accepts a normal step when an incompatible candidate is outside the selected pool', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({ model: 'sonnet', tags: ['claude-only'] })],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createPoolScopedValidatorAutoRouting(),
    })).not.toThrow();
  });

  it('fails fast when a selected dynamic pool candidate is incompatible with an explicit model', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({ model: 'sonnet', tags: ['codex-only'] })],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createPoolScopedValidatorAutoRouting(),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('accepts a parallel sub-step when an incompatible candidate is outside the selected pool', () => {
    const workflow = createWorkflow({
      steps: [{
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        parallel: [createPlanAgent({ name: 'review', model: 'sonnet', tags: ['claude-only'] })],
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createPoolScopedValidatorAutoRouting(),
    })).not.toThrow();
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
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        parallel: [createPlanAgent({ name: 'review', model: 'sonnet' })],
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { review: 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('fails fast when a loop judge overrides an auto-routed codex step with a Claude model', () => {
    const workflow = createWorkflow({
      loopMonitors: [{
        cycle: ['plan'],
        threshold: 1,
        judge: {
          model: 'sonnet',
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createValidatorAutoRouting({ steps: { plan: 'codex' } }),
    })).toThrow(/auto_routing resolved model 'sonnet'.*provider is 'codex'/i);
  });

  it('accepts a loop monitor when an incompatible candidate is outside the triggering step pool', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({ tags: ['claude-only'] })],
      loopMonitors: [{
        cycle: ['plan'],
        threshold: 1,
        judge: {
          model: 'sonnet',
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createPoolScopedValidatorAutoRouting(),
    })).not.toThrow();
  });

  it('fails fast when a loop monitor judge points to an unknown step', () => {
    const workflow = createWorkflow({
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [normalizeRule({ condition: 'continue', next: 'missing-step' })],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow('missing-step');
  });

  it('treats removed terminal aliases as unknown step targets', () => {
    const workflow = createWorkflow({
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          personaDisplayName: 'planner',
          edit: false,
          instruction: '{task}',
          passPreviousResponse: true,
          rules: [normalizeRule({ condition: 'stalled', next: 'REMOVED_TERMINAL' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": target step "REMOVED_TERMINAL" does not exist',
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
          rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
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
              rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
            },
          ],
          rules: [normalizeRule({ condition: 'all("COMPLETE")', next: 'COMPLETE' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Configuration error: workflowCallResolver is required when workflow contains workflow_call steps',
    );
  });

  it.each([
    {
      label: 'system fixed participant',
      fixed: [{
        name: 'cleanup',
        kind: 'system',
        personaDisplayName: 'cleanup',
        instruction: 'cleanup',
      }],
      pool: [{
        name: 'frontend',
        description: 'Review frontend',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
      }],
      expectedMessage: 'dynamic parallel fixed sub-step "cleanup" of step "reviewers" must be a normal agent step',
      expectedPath: ['steps', 0, 'parallel', 'fixed', 0],
    },
    {
      label: 'workflow_call pool participant',
      fixed: [],
      pool: [{
        name: 'delegate',
        description: 'Delegate review',
        kind: 'workflow_call',
        call: 'child',
        personaDisplayName: 'delegate',
        instruction: '',
      }],
      expectedMessage: 'dynamic parallel pool sub-step "delegate" of step "reviewers" must be a normal agent step',
      expectedPath: ['steps', 0, 'parallel', 'pool', 0],
    },
    {
      label: 'delegated agent pool participant',
      fixed: [],
      pool: [{
        name: 'delegated',
        description: 'Delegate review',
        personaDisplayName: 'delegated',
        instruction: 'review',
        teamLeader: { maxParts: 2, mode: 'default' },
      }],
      expectedMessage: 'dynamic parallel pool sub-step "delegated" of step "reviewers" must be a normal agent step',
      expectedPath: ['steps', 0, 'parallel', 'pool', 0],
    },
    {
      label: 'missing pool description',
      fixed: [],
      pool: [{
        name: 'frontend',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
      }],
      expectedMessage: 'dynamic parallel pool sub-step "frontend" of step "reviewers" requires a non-empty description',
      expectedPath: ['steps', 0, 'parallel', 'pool', 0, 'description'],
    },
    {
      label: 'blank pool description',
      fixed: [],
      pool: [{
        name: 'frontend',
        description: '   ',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
      }],
      expectedMessage: 'dynamic parallel pool sub-step "frontend" of step "reviewers" requires a non-empty description',
      expectedPath: ['steps', 0, 'parallel', 'pool', 0, 'description'],
    },
  ])('fails fast for $label before resolving workflow calls or providers', ({
    fixed,
    pool,
    expectedMessage,
    expectedPath,
  }) => {
    const workflow = createProgrammaticDynamicParallelWorkflow(fixed, pool);

    let validationError: unknown;
    try {
      validateWorkflowConfig(workflow, { projectCwd: process.cwd() });
    } catch (error) {
      validationError = error;
    }

    expect(validationError).toBeInstanceOf(Error);
    expect((validationError as Error).message).toContain(expectedMessage);
    expect(getWorkflowConfigErrorPath(validationError)).toEqual(expectedPath);
  });

  it('accepts a valid programmatic dynamic parallel contract without pre-validating pool providers', () => {
    const workflow = createProgrammaticDynamicParallelWorkflow(
      [{
        name: 'architecture',
        personaDisplayName: 'architecture',
        instruction: 'review architecture',
      }],
      [{
        name: 'frontend',
        description: 'Review frontend',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
        provider: 'opencode',
      }],
    );

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it.each([
    {
      label: 'an empty pool',
      mutate: (parallel: Record<string, unknown>) => {
        parallel.pool = [];
      },
      expectedMessage: 'requires at least one pool sub-step',
      expectedPath: ['steps', 0, 'parallel', 'pool'],
    },
    {
      label: 'a missing selection mode',
      mutate: (parallel: Record<string, unknown>) => {
        parallel.selection = {};
      },
      expectedMessage: 'selection.mode must be "replace" or "cumulative"',
      expectedPath: ['steps', 0, 'parallel', 'selection', 'mode'],
    },
    {
      label: 'an unknown selection mode',
      mutate: (parallel: Record<string, unknown>) => {
        parallel.selection = { mode: 'adaptive' };
      },
      expectedMessage: 'selection.mode must be "replace" or "cumulative"',
      expectedPath: ['steps', 0, 'parallel', 'selection', 'mode'],
    },
  ])('rejects programmatic dynamic parallel with $label', ({
    mutate,
    expectedMessage,
    expectedPath,
  }) => {
    const workflow = createProgrammaticDynamicParallelWorkflow([], [{
      name: 'frontend',
      description: 'Review frontend',
      personaDisplayName: 'frontend',
      instruction: 'review frontend',
    }]);
    const parallel = workflow.steps[0]!.parallel as unknown as Record<string, unknown>;
    mutate(parallel);

    let validationError: unknown;
    try {
      validateWorkflowConfig(workflow, { projectCwd: process.cwd() });
    } catch (error) {
      validationError = error;
    }

    expect(validationError).toBeInstanceOf(Error);
    expect((validationError as Error).message).toContain(expectedMessage);
    expect(getWorkflowConfigErrorPath(validationError)).toEqual(expectedPath);
  });

  it('rejects a position-dependent aggregate in a programmatic dynamic parallel contract', () => {
    const workflow = createProgrammaticDynamicParallelWorkflow([], [{
      name: 'frontend',
      description: 'Review frontend',
      personaDisplayName: 'frontend',
      instruction: 'review frontend',
      rules: [normalizeRule({ condition: 'approved' })],
    }]);
    workflow.steps[0]!.rules = [
      normalizeRule({ condition: 'all("approved", "approved")', next: 'COMPLETE' }),
    ];

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Dynamic parallel aggregate conditions require exactly one bare result label',
    );
  });

  it('rejects a programmatic dynamic parallel participant missing a required aggregate label', () => {
    const workflow = createProgrammaticDynamicParallelWorkflow([], [{
      name: 'frontend',
      description: 'Review frontend',
      personaDisplayName: 'frontend',
      instruction: 'review frontend',
      rules: [normalizeRule({ condition: 'needs_fix' })],
    }]);
    workflow.steps[0]!.rules = [
      normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' }),
    ];

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'requires sub-step "frontend" to define result label "approved"',
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
              rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
            },
            {
              name: 'delegate',
              persona: 'reviewer-b',
              personaDisplayName: 'reviewer-b',
              instruction: 'review ui',
              passPreviousResponse: true,
              rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
            },
          ],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Configuration error: parallel step "reviewers" contains duplicate sub-step name "delegate"',
    );
  });

  it('accepts a parallel sub-step name that is also used at top level', () => {
    const workflow = createWorkflow({
      initialStep: 'delegate',
      steps: [
        createPlanAgent({ name: 'delegate' }),
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [{
            name: 'delegate',
            persona: 'reviewer',
            personaDisplayName: 'reviewer',
            instruction: 'review delegated work',
            rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
          }],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() }))
      .not.toThrow();
  });

  it('rejects conflicting appendices in normalized normal-step rules', () => {
    const workflow = createWorkflow({
      steps: [createPlanAgent({
        rules: [
          normalizeRule({
            condition: 'approved && when(false)',
            next: 'plan',
            appendix: 'FIRST',
          }),
          normalizeRule({ condition: 'approved', next: 'COMPLETE', appendix: 'SECOND' }),
        ],
      })],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": Rules sharing semantic label "approved" must use the same appendix',
    );
  });

  it('rejects conflicting appendices in normalized parallel sub-step rules', () => {
    const workflow = createWorkflow({
      initialStep: 'reviewers',
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'architecture',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              instruction: 'review architecture',
              passPreviousResponse: true,
              rules: [
                normalizeRule({
                  condition: 'approved && when(false)',
                  appendix: 'FIRST',
                }),
                normalizeRule({ condition: 'approved', appendix: 'SECOND' }),
              ],
            },
          ],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in parallel sub-step "architecture" of step "reviewers": '
      + 'Rules sharing semantic label "approved" must use the same appendix',
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
              rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
            },
          ],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'ui-reviewers' })],
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
              rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
            },
          ],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
  });

  it.each([
    ['normal agent', createPlanAgent()],
    [
      'system',
      {
        name: 'plan',
        kind: 'system',
        personaDisplayName: 'plan',
        instruction: '',
        passPreviousResponse: false,
      },
    ],
    ['arpeggio', { ...createPlanAgent(), arpeggio: {} }],
    ['team leader', { ...createPlanAgent(), teamLeader: {} }],
    ['empty parallel parent', { ...createPlanAgent(), parallel: [] }],
  ])('rejects aggregate rules on a programmatic %s step', (_label, step) => {
    const workflow = createWorkflow({
      steps: [{
        ...step,
        rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
      } as WorkflowConfig['steps'][number]],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in step "plan": aggregate conditions are only allowed on parallel parent steps with sub-steps',
    );
  });

  it('rejects aggregate rules on a programmatic parallel sub-step', () => {
    const workflow = createWorkflow({
      steps: [{
        ...createPlanAgent(),
        parallel: [{
          ...createPlanAgent(),
          name: 'review',
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        }],
        rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
      } as WorkflowConfig['steps'][number]],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid rule in parallel sub-step "review" of step "plan": aggregate conditions are only allowed on parallel parent steps with sub-steps',
    );
  });

  it('rejects aggregate rules on a programmatic loop monitor judge', () => {
    const workflow = createWorkflow({
      loopMonitors: [{
        cycle: ['plan', 'plan'],
        threshold: 2,
        judge: {
          persona: 'loop-judge',
          rules: [normalizeRule({ condition: 'any("approved")', next: 'COMPLETE' })],
        },
      }],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(
      'Invalid loop_monitor judge rule: aggregate conditions are only allowed on parallel parent steps with sub-steps',
    );
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
