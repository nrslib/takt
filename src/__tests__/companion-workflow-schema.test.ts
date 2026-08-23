import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function validRules() {
  return [
    { condition: 'done', next: 'COMPLETE' },
  ];
}

function workflowWithCompanion(rules = validRules()) {
  return normalizeWorkflowConfig({
    name: 'companion-schema',
    initial_step: 'implement',
    max_steps: 5,
    steps: [
      {
        name: 'implement',
        instruction: 'implement',
        companion: {
          fixed: ['security-reviewer'],
          pool: ['design-reviewer', 'frontend-reviewer'],
          moderator: 'adjudicator',
        },
        rules,
      },
      {
        name: 'needs-fix',
        instruction: 'fix',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  });
}

describe('CT-COMP-01 workflow companion schema', () => {
  it('should normalize the name-array shorthand as fixed companions', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'short-companion',
      initial_step: 'implement',
      steps: [{
        name: 'implement',
        instruction: 'implement',
        companion: ['security-reviewer', 'design-reviewer'],
        rules: validRules(),
      }, {
        name: 'needs-fix',
        instruction: 'fix',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });

    expect(workflow.steps[0]?.companion).toEqual({
      fixed: ['security-reviewer', 'design-reviewer'],
      pool: [],
    });
  });

  it('should reject a literal empty companion selection', () => {
    expect(WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'implement',
      companion: [],
      rules: validRules(),
    }).success).toBe(false);

    expect(WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'implement',
      companion: {},
      rules: validRules(),
    }).success).toBe(false);
  });

  it('should preserve fixed, pool, and moderator references in object form', () => {
    const workflow = workflowWithCompanion();

    expect(workflow.steps[0]?.companion).toEqual({
      fixed: ['security-reviewer'],
      pool: ['design-reviewer', 'frontend-reviewer'],
      moderator: 'adjudicator',
    });
  });

  it.each([
    ['fixed', { fixed: ['adjudicator'], pool: [], moderator: 'adjudicator' }],
    ['pool', { fixed: [], pool: ['adjudicator'], moderator: 'adjudicator' }],
  ])('should reject a moderator duplicated in the %s reviewers at load time', (_role, companion) => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'implement',
      companion,
      rules: validRules(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(['moderator']) }),
      ]));
    }
  });

  it('should reject inline companion definitions instead of treating them as named resources', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'implement',
      companion: [{ name: 'security-reviewer', description: 'inline' }],
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(['companion']) }),
      ]));
    }
  });

  it.each([
    ['parallel root', {
      name: 'parallel',
      parallel: [{ name: 'review', instruction: 'review' }],
    }],
    ['arpeggio root', {
      name: 'batch',
      arpeggio: { source: 'csv', source_path: 'input.csv', template: 'prompt.md' },
    }],
    ['system step', { name: 'system', kind: 'system' }],
    ['workflow call', {
      name: 'delegate',
      kind: 'workflow_call',
      call: 'child',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    }],
  ])('should reject companion on a %s', (_label, validIncompatibleStep) => {
    expect(WorkflowStepRawSchema.safeParse(validIncompatibleStep).success).toBe(true);

    const result = WorkflowStepRawSchema.safeParse({
      ...validIncompatibleStep,
      companion: ['security-reviewer'],
    });

    expect(result.success).toBe(false);
  });

  it('should accept companion on a team leader root', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'team',
      instruction: 'lead',
      team_leader: { max_parts: 2 },
      companion: ['security-reviewer'],
    });

    expect(result.success).toBe(true);
  });

  it('should reject companion on a parallel sub-step', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      parallel: [{
        name: 'review',
        instruction: 'review',
        companion: ['security-reviewer'],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('should accept a companion step without extra routing metadata', () => {
    expect(() => validateWorkflowConfig(workflowWithCompanion(), {
      projectCwd: process.cwd(),
    })).not.toThrow();
  });
});
