import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowRule } from '../core/models/index.js';
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
          rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
            { condition: 'findings.open.count == 0', next: 'COMPLETE' },
            { condition: 'findings.conflicts.count > 0', returnValue: 'need_replan' },
          ],
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).not.toThrow();
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
          rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
          rules: [{ condition: 'findings.conflicts.count > 0', returnValue: 'needs_fix' }],
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
          rules: [{ condition: 'findings.conflicts.count > 0', next: 'fix' }],
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
            rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
              rules: [{ condition: 'findings.open.count == 0' }],
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
              rules: [{ condition: 'findings.open.count == 0' }],
            },
          ],
          rules: [
            { condition: 'findings.open.count == 0', next: 'COMPLETE' },
            { condition: 'findings.conflicts.count > 0', returnValue: 'need_replan' },
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
            rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
              rules: [{ condition: 'true', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
});
