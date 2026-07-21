import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function makeWorkflowWithFindingContract(findingContract: unknown) {
  return {
    name: 'invalid-finding-contract-workflow',
    finding_contract: findingContract,
    initial_step: 'peer-review',
    max_steps: 2,
    steps: [
      {
        name: 'peer-review',
        persona: 'reviewer',
        instruction: 'Review the change.',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('workflow finding_contract schema', () => {
  it('should normalize top-level finding_contract without changing step definitions', () => {
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
      max_steps: 2,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract).toMatchObject({
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        personaDisplayName: 'findings-manager',
        providerRoutingPersonaKey: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    });
    expect(workflow.steps[0]?.rules?.[0]).toEqual(
      expect.objectContaining({
        condition: 'when(findings.open.count == 0)',
        next: 'COMPLETE',
      }),
    );
  });

  // 有限停止予算（codex 裁定・対策バッチ B1 の拡張）。
  it('should leave findingContract.stopBudget undefined when stop_budget is omitted (defaults are applied lazily by stop-budget.ts, not at normalization time)', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-no-stop-budget',
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
      max_steps: 2,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.stopBudget).toBeUndefined();
  });

  it('should normalize finding_contract.stop_budget with both max_rounds and max_minutes provided', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-stop-budget',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        stop_budget: {
          max_rounds: 5,
          max_minutes: 30,
        },
      },
      initial_step: 'peer-review',
      max_steps: 2,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.stopBudget).toEqual({ maxRounds: 5, maxMinutes: 30 });
  });

  it('should normalize finding_contract.stop_budget with only max_rounds provided (max_minutes stays unset — the time cap is opt-in)', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-partial-stop-budget',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
        stop_budget: {
          max_rounds: 5,
        },
      },
      initial_step: 'peer-review',
      max_steps: 2,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.stopBudget).toEqual({ maxRounds: 5 });
  });

  it('should reject unknown finding_contract.stop_budget fields instead of silently accepting contract drift', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-stop-budget-workflow',
        finding_contract: {
          ledger_path: '.takt/findings/peer-review.json',
          raw_findings_path: '.takt/findings/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            output_contract: 'findings-manager',
          },
          stop_budget: {
            max_rounds: 5,
            max_rounds_per_step: 5,
          },
        },
        initial_step: 'peer-review',
        max_steps: 2,
        steps: [
          {
            name: 'peer-review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow();
  });

  it('should reject invalid finding_contract.stop_budget raw shapes (non-positive or non-integer)', () => {
    const invalidStopBudgets: unknown[] = [
      { max_rounds: 0 },
      { max_rounds: -1 },
      { max_rounds: 1.5 },
      { max_rounds: 'five' },
      { max_minutes: 0 },
      { max_minutes: -1 },
      { max_minutes: 1.5 },
    ];

    for (const stopBudget of invalidStopBudgets) {
      expect(() =>
        normalizeWorkflowConfig({
          name: 'invalid-stop-budget-shape-workflow',
          finding_contract: {
            ledger_path: '.takt/findings/peer-review.json',
            raw_findings_path: '.takt/findings/raw',
            manager: {
              persona: 'findings-manager',
              instruction: 'findings-manager',
              output_contract: 'findings-manager',
            },
            stop_budget: stopBudget,
          },
          initial_step: 'peer-review',
          max_steps: 2,
          steps: [
            {
              name: 'peer-review',
              persona: 'reviewer',
              instruction: 'Review the change.',
              rules: [{ condition: 'done', next: 'COMPLETE' }],
            },
          ],
        }, '/tmp/project'),
      ).toThrow();
    }
  });

  it('should preserve finding manager provider and model through workflow normalization', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-manager-provider-workflow',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
      initial_step: 'peer-review',
      max_steps: 2,
      steps: [
        {
          name: 'peer-review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.manager).toMatchObject({
      persona: 'findings-manager',
      providerRoutingPersonaKey: 'findings-manager',
      instruction: 'findings-manager',
      outputContract: 'findings-manager',
      provider: 'codex',
      model: 'gpt-5.5',
    });
  });

  it('should resolve finding manager facets through the normal facet lookup path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-'));
    try {
      const projectDir = join(tempDir, 'project');
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(join(projectDir, '.takt', 'facets', 'personas'), { recursive: true });
      mkdirSync(join(projectDir, '.takt', 'facets', 'instructions'), { recursive: true });
      mkdirSync(join(projectDir, '.takt', 'facets', 'output-contracts'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'findings-manager.md'), 'Project findings manager persona');
      writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'findings-manager.md'), 'Project findings manager instruction');
      writeFileSync(join(projectDir, '.takt', 'facets', 'output-contracts', 'findings-manager.md'), 'Project findings manager output contract');

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
        max_steps: 2,
        steps: [
          {
            name: 'peer-review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
          },
        ],
      }, workflowDir, { projectDir, lang: 'ja', workflowDir });

      expect(workflow.findingContract?.manager).toMatchObject({
        persona: 'findings-manager',
        personaDisplayName: 'findings-manager',
        personaPath: join(projectDir, '.takt', 'facets', 'personas', 'findings-manager.md'),
        instruction: 'Project findings manager instruction',
        outputContract: 'Project findings manager output contract',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should leave workflows without finding_contract unchanged', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'legacy-workflow',
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract).toBeUndefined();
    expect(workflow.steps[0]?.rules?.[0]?.condition).toBe('approved');
  });

  it('should reject findings rules when finding_contract is not configured', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-findings-rule-workflow',
        initial_step: 'review',
        max_steps: 2,
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow('step "review" uses findings.* rule but finding_contract is not configured');
  });

  it('should defer findings rule validation for a callable subworkflow that requires an inherited Finding Contract', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-child',
      subworkflow: {
        callable: true,
        visibility: 'internal',
        requires_finding_contract: true,
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ when: 'findings.open.count == 0', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract).toBeUndefined();
    expect(workflow.subworkflow).toMatchObject({
      callable: true,
      visibility: 'internal',
      requiresFindingContract: true,
    });
  });

  it('should reject a subworkflow that both requires inheritance and declares its own Finding Contract', () => {
    expect(() => normalizeWorkflowConfig({
      name: 'ambiguous-finding-contract-child',
      subworkflow: {
        callable: true,
        requires_finding_contract: true,
      },
      finding_contract: {
        ledger_path: '.takt/findings/child.json',
        raw_findings_path: '.takt/findings/child/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project')).toThrow(
      'subworkflow.requires_finding_contract cannot be combined with a local finding_contract',
    );
  });

  it('should reject loop monitor judge findings rules when finding_contract is not configured', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-loop-monitor-findings-rule-workflow',
        initial_step: 'review',
        max_steps: 2,
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ condition: 'retry', next: 'review' }],
          },
        ],
        loop_monitors: [
          {
            cycle: ['review', 'review'],
            threshold: 2,
            judge: {
              rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
            },
          },
        ],
      }, '/tmp/project'),
    ).toThrow('loop_monitor judge uses findings.* rule but finding_contract is not configured');
  });

  it('should reject parallel sub-step findings rules when finding_contract is not configured', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-parallel-findings-rule-workflow',
        initial_step: 'reviewers',
        max_steps: 2,
        steps: [
          {
            name: 'reviewers',
            persona: 'reviewer',
            instruction: 'Review the change.',
            parallel: [
              {
                name: 'coding-review',
                persona: 'reviewer',
                instruction: 'Review the change.',
                rules: [{ condition: 'when(findings.open.count == 0)' }],
              },
            ],
            rules: [{ condition: 'all(\"approved\")', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow('parallel sub-step "coding-review" in step "reviewers" uses findings.* rule but finding_contract is not configured');
  });

  it('should reject aggregate findings guards when finding_contract is not configured', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-aggregate-findings-guard-workflow',
        initial_step: 'reviewers',
        max_steps: 2,
        steps: [
          {
            name: 'reviewers',
            persona: 'reviewer',
            instruction: 'Review the change.',
            parallel: [
              {
                name: 'coding-review',
                persona: 'reviewer',
                instruction: 'Review the change.',
                rules: [{ condition: 'approved' }],
              },
            ],
            rules: [{ condition: 'all("approved") && when(findings.open.count == 0)', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow('step "reviewers" uses findings.* rule but finding_contract is not configured');
  });

  it('should accept parallel sub-step findings rules when finding_contract is configured', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'parallel-findings-rule-workflow',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      },
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [
        {
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'Review the change.',
          parallel: [
            {
              name: 'coding-review',
              persona: 'reviewer',
              instruction: 'Review the change.',
              rules: [{ condition: 'when(findings.open.count == 0)' }],
            },
          ],
          rules: [{ condition: 'all(\"approved\")', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.steps[0]?.parallel?.[0]?.rules?.[0]).toEqual(
      expect.objectContaining({
        condition: 'when(findings.open.count == 0)',
      }),
    );
  });

  it('should accept aggregate findings guards when finding_contract is configured', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'aggregate-findings-guard-workflow',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      },
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [
        {
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'Review the change.',
          parallel: [
            {
              name: 'coding-review',
              persona: 'reviewer',
              instruction: 'Review the change.',
              rules: [{ condition: 'approved' }],
            },
          ],
          rules: [{ condition: 'all("approved") && when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.steps[0]?.rules?.[0]).toEqual(
      expect.objectContaining({
        isAggregateCondition: true,
        aggregateGuardCondition: 'findings.open.count == 0',
      }),
    );
  });

  it('should accept loop monitor judge findings rules when finding_contract is configured', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'loop-monitor-findings-rule-workflow',
      finding_contract: {
        ledger_path: '.takt/findings/peer-review.json',
        raw_findings_path: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      },
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review the change.',
          rules: [{ condition: 'retry', next: 'review' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['review', 'review'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
          },
        },
      ],
    }, '/tmp/project');

    expect(workflow.loopMonitors?.[0]?.judge.rules[0]).toEqual(
      expect.objectContaining({
        condition: 'when(findings.open.count == 0)',
        next: 'COMPLETE',
      }),
    );
  });

  it('should reject finding_contract when a required path is missing', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-finding-contract-workflow',
        finding_contract: {
          raw_findings_path: '.takt/findings/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            output_contract: 'findings-manager',
          },
        },
        initial_step: 'peer-review',
        max_steps: 2,
        steps: [
          {
            name: 'peer-review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow();
  });

  it('should reject unknown finding_contract fields instead of silently accepting contract drift', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-finding-contract-workflow',
        finding_contract: {
          ledger_path: '.takt/findings/peer-review.json',
          raw_findings_path: '.takt/findings/raw',
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            output_contract: 'findings-manager',
          },
          manager_session: 'continue',
        },
        initial_step: 'peer-review',
        max_steps: 2,
        steps: [
          {
            name: 'peer-review',
            persona: 'reviewer',
            instruction: 'Review the change.',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'),
    ).toThrow();
  });

  it('should reject invalid finding_contract raw shapes', () => {
    const validFindingContract = {
      ledger_path: '.takt/findings/peer-review.json',
      raw_findings_path: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        output_contract: 'findings-manager',
      },
    };
    const invalidFindingContracts: unknown[] = [
      null,
      { ...validFindingContract, ledger_path: null },
      { ...validFindingContract, ledger_path: {} },
      { ...validFindingContract, raw_findings_path: null },
      { ...validFindingContract, raw_findings_path: {} },
      { ...validFindingContract, manager: null },
      { ...validFindingContract, manager: { ...validFindingContract.manager, persona: null } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, instruction: {} } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, output_contract: null } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, provider: 'auto' } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, provider: 'unknown-provider' } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, model: null } },
      { ...validFindingContract, manager: { ...validFindingContract.manager, model: '' } },
    ];

    for (const findingContract of invalidFindingContracts) {
      expect(() =>
        normalizeWorkflowConfig(
          makeWorkflowWithFindingContract(findingContract),
          '/tmp/project',
        ),
      ).toThrow();
    }
  });
});
