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
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    });
    expect(workflow.steps[0]?.rules?.[0]).toEqual(
      expect.objectContaining({
        condition: 'findings.open.count == 0',
        next: 'COMPLETE',
      }),
    );
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
              rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
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
                rules: [{ condition: 'findings.open.count == 0' }],
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
            rules: [{ condition: 'all("approved") && findings.open.count == 0', next: 'COMPLETE' }],
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
              rules: [{ condition: 'findings.open.count == 0' }],
            },
          ],
          rules: [{ condition: 'all(\"approved\")', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project');

    expect(workflow.steps[0]?.parallel?.[0]?.rules?.[0]).toEqual(
      expect.objectContaining({
        condition: 'findings.open.count == 0',
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
          rules: [{ condition: 'all("approved") && findings.open.count == 0', next: 'COMPLETE' }],
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
            rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
          },
        },
      ],
    }, '/tmp/project');

    expect(workflow.loopMonitors?.[0]?.judge.rules[0]).toEqual(
      expect.objectContaining({
        condition: 'findings.open.count == 0',
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
