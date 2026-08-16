import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';

type RawStep = Record<string, unknown>;

type RawWorkflow = {
  steps: RawStep[];
  [key: string]: unknown;
};

function readBuiltinWorkflow(language: 'ja' | 'en', name: string): RawWorkflow {
  const parsed: unknown = parse(readFileSync(
    join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`),
    'utf-8',
  ));
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    throw new Error(`Invalid builtin workflow: ${language}/${name}`);
  }
  return parsed as RawWorkflow;
}

function findStep(workflow: RawWorkflow, name: string): RawStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Step not found: ${name}`);
  }
  return step;
}

function readBuiltinInstruction(language: 'ja' | 'en', name: string): string {
  const content = resolveRefToContent(
    name,
    undefined,
    process.cwd(),
    'instructions',
    { projectDir: process.cwd(), lang: language },
  );
  if (content === undefined) {
    throw new Error(`Instruction not found: ${language}/${name}`);
  }
  return content;
}

function removeLocalizedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeLocalizedFields);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'description' && key !== 'condition')
        .map(([key, nested]) => [key, removeLocalizedFields(nested)]),
    );
  }
  return value;
}

describe('takt-experimental-team builtin workflows', () => {
  it('keeps the Japanese and English workflow graphs structurally identical', () => {
    for (const name of [
      'takt-experimental-team',
      'development-implement-team',
      'development-remediation-team',
    ]) {
      expect(removeLocalizedFields(readBuiltinWorkflow('ja', name)))
        .toEqual(removeLocalizedFields(readBuiltinWorkflow('en', name)));
    }
  });

  it.each(['ja', 'en'] as const)('preserves takt-experimental core arguments in %s', (language) => {
    const baseArgs = findStep(
      readBuiltinWorkflow(language, 'takt-experimental'),
      'develop',
    ).args as Record<string, unknown>;
    const teamArgs = findStep(
      readBuiltinWorkflow(language, 'takt-experimental-team'),
      'develop',
    ).args as Record<string, unknown>;

    const intentionallyOmittedArgs = ['implementation_pool', 'implementation_companions'];
    const preservedArgs = Object.fromEntries(
      Object.entries(baseArgs).filter(([key]) => !intentionallyOmittedArgs.includes(key)),
    );

    expect(teamArgs).toEqual({
      ...preservedArgs,
      implementation_workflow: 'development-implement-team',
      remediation_workflow: 'development-remediation-team',
    });
    expect(teamArgs).not.toHaveProperty('implementation_pool');
    expect(teamArgs).not.toHaveProperty('implementation_companions');
  });

  it.each(['ja', 'en'] as const)('routes only coder execution steps through Team Leader in %s', (language) => {
    const root = readBuiltinWorkflow(language, 'takt-experimental-team');
    const rootStep = findStep(root, 'develop');
    const args = rootStep.args as Record<string, unknown>;

    expect(args.implementation_workflow).toBe('development-implement-team');
    expect(args.remediation_workflow).toBe('development-remediation-team');
    expect(args.plan_instruction).toBe('scenario-based-plan');
    expect(args.testing_instruction).toBe('scenario-based-write-tests-first');
    expect(args.fix_plan_instruction).toBe('scenario-based-fix-plan-from-review-resolution');
    expect(args.final_gate_instruction).toBe('scenario-based-supervise-review-resolution');

    const implementation = readBuiltinWorkflow(language, 'development-implement-team');
    const implementationStep = findStep(implementation, 'implement');
    expect(implementationStep.team_leader).toMatchObject({
      max_concurrency: 2,
      initial_max_parts: 2,
      fail_on_part_error: false,
      part_tags: ['coding'],
      part_persona: 'coder',
      part_edit: true,
      part_permission_mode: 'edit',
    });
    expect(implementationStep).toMatchObject({
      uses: 'development-core-implement',
      instruction: 'team-leader-implement',
    });
    expect(implementationStep).not.toHaveProperty('dynamic_facets');
    expect(implementationStep).not.toHaveProperty('companion');

    const remediation = readBuiltinWorkflow(language, 'development-remediation-team');
    for (const [stepName, instruction] of [
      ['fix', 'team-leader-fix-plan'],
      ['fix-retry', 'team-leader-fix-verification'],
    ] as const) {
      const step = findStep(remediation, stepName);
      expect(step.team_leader).toMatchObject({
        max_concurrency: 2,
        initial_max_parts: 2,
        fail_on_part_error: false,
        part_tags: ['coding'],
        part_persona: 'coder',
        part_edit: true,
        part_permission_mode: 'edit',
      });
      expect(step).toMatchObject({
        uses: 'peer-review-fix',
        instruction,
      });
      expect(step.with).toMatchObject({ fix_instruction: instruction });
      expect(step).not.toHaveProperty('dynamic_facets');
      expect(step).not.toHaveProperty('companion');
    }
    expect(findStep(remediation, 'fix-plan')).not.toHaveProperty('team_leader');
    expect(findStep(remediation, 'fix-verifier')).not.toHaveProperty('team_leader');
  });

  it.each(['ja', 'en'] as const)('keeps the fix-plan and retry report contracts after instruction expansion in %s', (language) => {
    const fixPlan = readBuiltinInstruction(language, 'team-leader-fix-plan');
    const fixVerification = readBuiltinInstruction(language, 'team-leader-fix-verification');

    expect(fixPlan).toContain('{report:fix-plan.md}');
    expect(fixVerification).toContain('{report:fix-plan.md}');
    expect(fixVerification).toContain('{report:fix-verification.md}');
    expect(fixVerification).toContain('{report:fix-report.md}');
    const conflictingPrimarySource = language === 'ja'
      ? '最新レビューレポート'
      : 'latest reviewer reports';
    expect(fixPlan).not.toContain(conflictingPrimarySource);
    expect(fixVerification).not.toContain(conflictingPrimarySource);
    const decompositionMarker = language === 'ja'
      ? '親 Team Leader 自身はツールを使わず'
      : 'Without using tools itself';
    expect(fixPlan).toContain(decompositionMarker);
    expect(fixVerification).toContain(decompositionMarker);
    expect(fixPlan).not.toContain('{{include:');
    expect(fixVerification).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('exposes the Team Leader variant in the %s builtin category', (language) => {
    const categories = parse(readFileSync(
      join(process.cwd(), 'builtins', language, 'workflow-categories.yaml'),
      'utf-8',
    )) as { workflow_categories: Record<string, { workflows: string[] }> };

    const category = Object.values(categories.workflow_categories).find(({ workflows }) => (
      workflows.includes('takt-experimental-team')
    ));
    expect(category).toBeDefined();
  });
});
