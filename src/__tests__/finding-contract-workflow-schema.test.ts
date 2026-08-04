import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import type { WorkflowConfig } from '../core/models/index.js';

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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract).toMatchObject({
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
        condition: { kind: 'when', expression: 'findings.open.count == 0' },
        next: 'COMPLETE',
      }),
    );
  });

  it('should reject the removed workflow-level reviewer_output field', () => {
    expect(() => normalizeWorkflowConfig(
      makeWorkflowWithFindingContract({
        reviewer_output: 'plain_text_normalized',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      }),
      '/tmp/project',
    )).toThrow();
  });

  // 有限停止予算（codex 裁定・対策バッチ B1 の拡張）。
  it('should leave findingContract.stopBudget undefined when stop_budget is omitted (defaults are applied lazily by stop-budget.ts, not at normalization time)', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-no-stop-budget',
      finding_contract: {
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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.stopBudget).toBeUndefined();
  });

  it('should normalize finding_contract.stop_budget with both max_rounds and max_minutes provided', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-stop-budget',
      finding_contract: {
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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.findingContract?.stopBudget).toEqual({ maxRounds: 5, maxMinutes: 30 });
  });

  it('should normalize finding_contract.stop_budget with only max_rounds provided (max_minutes stays unset — the time cap is opt-in)', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'finding-contract-workflow-partial-stop-budget',
      finding_contract: {
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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
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
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
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
      name: 'workflow-without-finding-contract',
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
    expect(workflow.steps[0]?.rules?.[0]?.condition).toEqual({ kind: 'semantic', label: 'approved' });
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
            rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
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
          rules: [{ condition: 'when(findings.open.count == 0)', next: 'COMPLETE' }],
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

  it('should accept a subworkflow that both requires inheritance and declares its own Finding Contract', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'ambiguous-finding-contract-child',
      subworkflow: {
        callable: true,
        requires_finding_contract: true,
      },
      finding_contract: {
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
    }, '/tmp/project');

    expect(workflow.findingContract).toBeDefined();
    expect(workflow.subworkflow?.requiresFindingContract).toBe(true);
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
        condition: { kind: 'when', expression: 'findings.open.count == 0' },
      }),
    );
  });

  it('should accept aggregate findings guards when finding_contract is configured', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'aggregate-findings-guard-workflow',
      finding_contract: {
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
        condition: {
          kind: 'and',
          left: {
            kind: 'aggregate',
            aggregate: 'all',
            targetConditions: [{ kind: 'semantic', label: 'approved' }],
          },
          right: { kind: 'when', expression: 'findings.open.count == 0' },
        },
      }),
    );
  });

  it('should accept loop monitor judge findings rules when finding_contract is configured', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'loop-monitor-findings-rule-workflow',
      finding_contract: {
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
        condition: { kind: 'when', expression: 'findings.open.count == 0' },
        next: 'COMPLETE',
      }),
    );
  });

  it('should reject unknown finding_contract fields instead of silently accepting contract drift', () => {
    expect(() =>
      normalizeWorkflowConfig({
        name: 'invalid-finding-contract-workflow',
        finding_contract: {
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

  it('should resolve manager additions and an explicit adjudicator through normal facet lookup', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-additions-'));
    try {
      const projectDir = join(tempDir, 'project');
      const workflowDir = join(projectDir, '.takt', 'workflows');
      for (const kind of ['personas', 'instructions', 'output-contracts', 'policies', 'knowledge']) {
        mkdirSync(join(projectDir, '.takt', 'facets', kind), { recursive: true });
      }
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'findings-manager.md'), 'Manager persona');
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'terminal-supervisor.md'), 'Supervisor persona');
      writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'findings-manager.md'), 'Manager instruction');
      writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'adjudicate.md'), 'Adjudication guidance');
      writeFileSync(join(projectDir, '.takt', 'facets', 'output-contracts', 'findings-manager.md'), 'Manager output');
      writeFileSync(join(projectDir, '.takt', 'facets', 'policies', 'first.md'), 'First policy');
      writeFileSync(join(projectDir, '.takt', 'facets', 'policies', 'second.md'), 'Second policy');
      writeFileSync(join(projectDir, '.takt', 'facets', 'knowledge', 'domain.md'), 'Domain knowledge');

      const workflow = normalizeWorkflowConfig({
        name: 'finding-contract-additions',
        finding_contract: {
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            output_contract: 'findings-manager',
            policy: ['first', 'second'],
            knowledge: ['domain'],
          },
          adjudicator: {
            persona: 'terminal-supervisor',
            instruction: 'adjudicate',
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
      }, workflowDir, { projectDir, workflowDir, lang: 'ja' });

      expect(workflow.findingContract?.manager.policyContents).toEqual(['First policy', 'Second policy']);
      expect(workflow.findingContract?.manager.knowledgeContents).toEqual(['Domain knowledge']);
      expect(workflow.findingContract?.adjudicator).toMatchObject({
        persona: 'terminal-supervisor',
        providerRoutingPersonaKey: 'terminal-supervisor',
        instruction: 'Adjudication guidance',
        provider: 'codex',
        model: 'gpt-test',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the same project facet override layer for ordinary steps and both finding-contract roles', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-project-override-'));
    try {
      const projectDir = join(tempDir, 'project');
      const workflowDir = join(projectDir, '.takt', 'workflows');
      for (const kind of ['personas', 'instructions', 'output-contracts', 'policies', 'knowledge']) {
        mkdirSync(join(projectDir, '.takt', 'facets', kind), { recursive: true });
      }
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'shared.md'), 'Project persona override');
      writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'shared.md'), 'Project instruction override');
      writeFileSync(join(projectDir, '.takt', 'facets', 'output-contracts', 'shared.md'), 'Project output override');
      writeFileSync(join(projectDir, '.takt', 'facets', 'policies', 'shared.md'), 'Project policy override');
      writeFileSync(join(projectDir, '.takt', 'facets', 'knowledge', 'shared.md'), 'Project knowledge override');

      const workflow = normalizeWorkflowConfig({
        name: 'shared-project-overrides',
        finding_contract: {
          manager: {
            persona: 'shared',
            instruction: 'shared',
            output_contract: 'shared',
            policy: ['shared'],
            knowledge: ['shared'],
          },
          adjudicator: { persona: 'shared', instruction: 'shared' },
        },
        initial_step: 'review',
        max_steps: 2,
        steps: [{
          name: 'review',
          persona: 'shared',
          instruction: 'shared',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      }, workflowDir, { projectDir, workflowDir, lang: 'ja' });

      const expectedPersonaPath = join(projectDir, '.takt', 'facets', 'personas', 'shared.md');
      expect(workflow.steps[0]).toMatchObject({
        personaPath: expectedPersonaPath,
        instruction: 'Project instruction override',
      });
      expect(workflow.findingContract?.manager).toMatchObject({
        personaPath: expectedPersonaPath,
        instruction: 'Project instruction override',
        outputContract: 'Project output override',
        policyContents: ['Project policy override'],
        knowledgeContents: ['Project knowledge override'],
      });
      expect(workflow.findingContract?.adjudicator).toMatchObject({
        personaPath: expectedPersonaPath,
        instruction: 'Project instruction override',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('gives package facets the same priority for ordinary steps and finding-contract roles', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-package-override-'));
    try {
      const projectDir = join(tempDir, 'project');
      const repertoireDir = join(tempDir, 'repertoire');
      const packageRoot = join(repertoireDir, '@owner', 'repo');
      const workflowDir = join(packageRoot, 'workflows');
      for (const base of [join(projectDir, '.takt', 'facets'), join(packageRoot, 'facets')]) {
        for (const kind of ['personas', 'instructions', 'output-contracts']) {
          mkdirSync(join(base, kind), { recursive: true });
          writeFileSync(join(base, kind, 'shared.md'), `${base === join(packageRoot, 'facets') ? 'Package' : 'Project'} ${kind}`);
        }
      }
      mkdirSync(workflowDir, { recursive: true });

      const workflow = normalizeWorkflowConfig({
        name: 'shared-package-overrides',
        finding_contract: {
          manager: { persona: 'shared', instruction: 'shared', output_contract: 'shared' },
          adjudicator: { persona: 'shared', instruction: 'shared' },
        },
        initial_step: 'review',
        max_steps: 2,
        steps: [{
          name: 'review',
          persona: 'shared',
          instruction: 'shared',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      }, workflowDir, { projectDir, workflowDir, repertoireDir, lang: 'ja' });

      const packagePersonaPath = join(packageRoot, 'facets', 'personas', 'shared.md');
      expect(workflow.steps[0]).toMatchObject({
        personaPath: packagePersonaPath,
        instruction: 'Package instructions',
      });
      expect(workflow.findingContract?.manager).toMatchObject({
        personaPath: packagePersonaPath,
        instruction: 'Package instructions',
        outputContract: 'Package output-contracts',
      });
      expect(workflow.findingContract?.adjudicator).toMatchObject({
        personaPath: packagePersonaPath,
        instruction: 'Package instructions',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(['step', 'manager', 'adjudicator'] as const)(
    'applies the same project symlink safety boundary to %s persona resolution',
    (owner) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-symlink-safety-'));
      try {
        const projectDir = join(tempDir, 'project');
        const workflowDir = join(projectDir, '.takt', 'workflows');
        const personaDir = join(projectDir, '.takt', 'facets', 'personas');
        mkdirSync(workflowDir, { recursive: true });
        mkdirSync(personaDir, { recursive: true });
        const outside = join(tempDir, 'outside.md');
        writeFileSync(outside, 'Outside persona');
        symlinkSync(outside, join(personaDir, 'unsafe.md'));
        const personaFor = (candidate: typeof owner) => candidate === owner ? 'unsafe' : 'inline-safe-persona';

        let thrown: unknown;
        try {
          normalizeWorkflowConfig({
            name: `symlink-safety-${owner}`,
            finding_contract: {
              manager: {
                persona: personaFor('manager'),
                instruction: 'Inline manager instruction.',
                output_contract: 'Inline output contract.',
              },
              adjudicator: {
                persona: personaFor('adjudicator'),
                instruction: 'Inline adjudicator instruction.',
              },
            },
            initial_step: 'review',
            max_steps: 2,
            steps: [{
              name: 'review',
              persona: personaFor('step'),
              instruction: 'Inline review instruction.',
              rules: [{ condition: 'done', next: 'COMPLETE' }],
            }],
          }, workflowDir, { projectDir, workflowDir, lang: 'ja' });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const error = thrown as Error & { cause?: unknown };
        const causeMessage = error.cause instanceof Error ? error.cause.message : '';
        expect(`${error.message}\n${causeMessage}`).toMatch(
          /Project facet file must stay inside the project|must not use symlinks/,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { field: 'ordinary step policy', facetKind: 'policies', target: 'step_policy' },
    { field: 'manager policy', facetKind: 'policies', target: 'manager_policy' },
    { field: 'manager knowledge', facetKind: 'knowledge', target: 'manager_knowledge' },
    { field: 'adjudicator instruction', facetKind: 'instructions', target: 'adjudicator_instruction' },
  ] as const)(
    'applies facet symlink safety to $field',
    ({ facetKind, target }) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-field-safety-'));
      try {
        const projectDir = join(tempDir, 'project');
        const workflowDir = join(projectDir, '.takt', 'workflows');
        const facetDir = join(projectDir, '.takt', 'facets', facetKind);
        mkdirSync(workflowDir, { recursive: true });
        mkdirSync(facetDir, { recursive: true });
        const outside = join(tempDir, 'outside.md');
        writeFileSync(outside, 'Outside facet');
        symlinkSync(outside, join(facetDir, 'unsafe.md'));
        let thrown: unknown;
        try {
          normalizeWorkflowConfig({
            name: `field-safety-${target}`,
            finding_contract: {
              manager: {
                persona: 'inline-manager',
                instruction: 'Inline manager instruction.',
                output_contract: 'Inline manager output.',
                ...(target === 'manager_policy' ? { policy: ['unsafe'] } : {}),
                ...(target === 'manager_knowledge' ? { knowledge: ['unsafe'] } : {}),
              },
              adjudicator: {
                persona: 'inline-supervisor',
                instruction: target === 'adjudicator_instruction'
                  ? 'unsafe'
                  : 'Inline adjudicator instruction.',
              },
            },
            initial_step: 'review',
            max_steps: 2,
            steps: [{
              name: 'review',
              persona: 'inline-reviewer',
              instruction: 'Inline review instruction.',
              ...(target === 'step_policy' ? { policy: ['unsafe'] } : {}),
              rules: [{ condition: 'done', next: 'COMPLETE' }],
            }],
          }, workflowDir, { projectDir, workflowDir, lang: 'ja' });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const messages: string[] = [];
        let current: unknown = thrown;
        while (current instanceof Error) {
          messages.push(current.message);
          current = (current as Error & { cause?: unknown }).cause;
        }
        expect(messages.join('\n')).toMatch(
          /Project facet file must stay inside the project|must not use symlinks/,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('should preserve omitted manager additions', () => {
    const normalized = normalizeWorkflowConfig(
      makeWorkflowWithFindingContract({
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      }),
      '/tmp/project',
    );
    expect(normalized.findingContract?.manager).not.toHaveProperty('policyContents');
    expect(normalized.findingContract?.manager).not.toHaveProperty('knowledgeContents');
  });

  const validManager = {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    output_contract: 'findings-manager',
  };

  it.each([
    {
      label: 'empty manager policy list',
      findingContract: { manager: { ...validManager, policy: [] } },
      expectedError: /policy/,
    },
    {
      label: 'empty manager policy ref',
      findingContract: { manager: { ...validManager, policy: [''] } },
      expectedError: /policy/,
    },
    {
      label: 'empty manager knowledge list',
      findingContract: { manager: { ...validManager, knowledge: [] } },
      expectedError: /knowledge/,
    },
    {
      label: 'empty manager knowledge ref',
      findingContract: { manager: { ...validManager, knowledge: [''] } },
      expectedError: /knowledge/,
    },
    {
      label: 'adjudicator without persona and instruction',
      findingContract: { manager: validManager, adjudicator: {} },
      expectedError: /adjudicator.*persona|persona.*adjudicator/s,
    },
    {
      label: 'adjudicator without instruction',
      findingContract: { manager: validManager, adjudicator: { persona: 'supervisor' } },
      expectedError: /adjudicator.*instruction|instruction.*adjudicator/s,
    },
    {
      label: 'adjudicator without persona',
      findingContract: { manager: validManager, adjudicator: { instruction: 'adjudicate' } },
      expectedError: /adjudicator.*persona|persona.*adjudicator/s,
    },
    {
      label: 'empty adjudicator persona',
      findingContract: { manager: validManager, adjudicator: { persona: '', instruction: 'adjudicate' } },
      expectedError: /adjudicator.*persona|persona.*adjudicator/s,
    },
    {
      label: 'empty adjudicator instruction',
      findingContract: { manager: validManager, adjudicator: { persona: 'supervisor', instruction: '' } },
      expectedError: /adjudicator.*instruction|instruction.*adjudicator/s,
    },
    {
      label: 'unsupported adjudicator provider',
      findingContract: {
        manager: validManager,
        adjudicator: { persona: 'supervisor', instruction: 'adjudicate', provider: 'auto' },
      },
      expectedError: /adjudicator.*provider|provider.*adjudicator/s,
    },
    {
      label: 'adjudicator output contract',
      findingContract: {
        manager: validManager,
        adjudicator: {
          persona: 'supervisor',
          instruction: 'adjudicate',
          output_contract: 'forbidden',
        },
      },
      expectedError: /output_contract|unrecognized/i,
    },
  ])('should reject $label at its schema field', ({ findingContract, expectedError }) => {
    expect(() => normalizeWorkflowConfig(
      makeWorkflowWithFindingContract(findingContract),
      '/tmp/project',
    )).toThrow(expectedError);
  });

  it('should omit an empty adjudicator persona routing key after trimming', () => {
    const normalized = normalizeWorkflowConfig(
      makeWorkflowWithFindingContract({
        manager: validManager,
        adjudicator: {
          persona: '   ',
          instruction: 'adjudicate',
        },
      }),
      '/tmp/project',
    );

    expect(normalized.findingContract?.adjudicator)
      .not.toHaveProperty('providerRoutingPersonaKey');
  });

  it('should reject unresolved additions and explicit adjudicator facets with field paths', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-finding-contract-missing-facets-'));
    try {
      const projectDir = join(tempDir, 'project');
      const workflowDir = join(projectDir, '.takt', 'workflows');
      for (const kind of ['personas', 'instructions', 'output-contracts', 'policies']) {
        mkdirSync(join(projectDir, '.takt', 'facets', kind), { recursive: true });
      }
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'findings-manager.md'), 'Manager persona');
      writeFileSync(join(projectDir, '.takt', 'facets', 'personas', 'supervisor.md'), 'Supervisor persona');
      writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'findings-manager.md'), 'Manager instruction');
      writeFileSync(join(projectDir, '.takt', 'facets', 'output-contracts', 'findings-manager.md'), 'Manager output');
      const context = {
        projectDir,
        workflowDir,
        repertoireDir: join(tempDir, 'repertoire'),
        lang: 'ja' as const,
      };
      const base = {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      };
      expect(() => normalizeWorkflowConfig(
        makeWorkflowWithFindingContract({
          manager: { ...base.manager, policy: ['@missing/package/policy'] },
        }),
        workflowDir,
        context,
      )).toThrow(/finding_contract\.manager\.policy\[0\].*@missing\/package\/policy/);
      expect(() => normalizeWorkflowConfig(
        makeWorkflowWithFindingContract({
          ...base,
          adjudicator: {
            persona: '@missing/package/adjudicator',
            instruction: 'findings-manager',
          },
        }),
        workflowDir,
        context,
      )).toThrow(/finding_contract\.adjudicator\.persona.*@missing\/package\/adjudicator/);
      expect(() => normalizeWorkflowConfig(
        makeWorkflowWithFindingContract({
          ...base,
          adjudicator: {
            persona: 'supervisor',
            instruction: '@missing/package/adjudication-guidance',
          },
        }),
        workflowDir,
        context,
      )).toThrow(/finding_contract\.adjudicator\.instruction.*@missing\/package\/adjudication-guidance/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid finding_contract raw shapes', () => {
    const validFindingContract = {
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        output_contract: 'findings-manager',
      },
    };
    const invalidFindingContracts: unknown[] = [
      null,
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

describe('finding-conflict-adjudication reserved step name (WorkflowValidator)', () => {
  it('予約名: ユーザー定義の finding-conflict-adjudication ステップは設定エラー (codex B7)', () => {
    const workflow: WorkflowConfig = {
      name: 'reserved-name-test',
      maxSteps: 3,
      initialStep: 'finding-conflict-adjudication',
      steps: [
        {
          name: 'finding-conflict-adjudication',
          persona: 'someone',
          personaDisplayName: 'someone',
          edit: false,
          instruction: 'Impersonate the synthetic step.',
          passPreviousResponse: true,
          rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/tmp/project' })).toThrow(/reserved/);
  });
});
