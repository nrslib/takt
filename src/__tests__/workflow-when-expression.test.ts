import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { parseWhenConditionExpression } from '../core/models/workflow-when-expression.js';
import {
  formatWorkflowRuleCondition,
  parseWorkflowRuleCondition,
  semanticLabelsOf,
} from '../core/models/workflow-rule-condition.js';
import type { WorkflowRule } from '../core/models/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { normalizeArpeggio } from '../infra/config/loaders/workflowStepFeaturesNormalizer.js';

function workflowWithStepRule(condition: string): unknown {
  return {
    name: 'when-validation',
    initial_step: 'judge',
    steps: [{
      name: 'judge',
      persona: 'reviewer',
      instruction: 'Judge',
      rules: [{ condition, next: 'COMPLETE' }],
    }],
  };
}

function workflowWithAggregateTarget(condition: string): unknown {
  return {
    name: 'when-validation',
    initial_step: 'judge',
    steps: [{
      name: 'judge',
      persona: 'reviewer',
      instruction: 'Judge',
      parallel: [{ name: 'worker', persona: 'worker', instruction: 'Work' }],
      rules: [{ condition: `all(${JSON.stringify(condition)})`, next: 'COMPLETE' }],
    }],
  };
}

function workflowWithLoopMonitorRule(condition: string): unknown {
  return {
    name: 'when-validation',
    initial_step: 'first',
    steps: [
      { name: 'first', persona: 'worker', instruction: 'First' },
      { name: 'second', persona: 'worker', instruction: 'Second' },
    ],
    loop_monitors: [{
      cycle: ['first', 'second'],
      judge: { rules: [{ condition, next: 'ABORT' }] },
    }],
  };
}

describe('parseWhenConditionExpression', () => {
  it.each([
    ['boolean', 'true'],
    ['bare state operand', 'context.route_context.ready'],
    ['comparison', 'context.review.count >= 1'],
    ['quoted operator', 'structured.scan.note == "a == b"'],
    [
      'logical clauses',
      'context.review.count > 0 || context.review.pending > 0 && context.review.blocked == 0',
    ],
    [
      'exists predicate',
      'exists(context.review.items, item.severity == "high" && item.title == "Example")',
    ],
    [
      'contains predicate',
      'exists(context.review.items, contains(item.familyTags, "provider-e2e"))',
    ],
    [
      'top-level contains',
      'contains(context.review.items[0].familyTags, "provider-e2e")',
    ],
  ])('should accept a valid %s expression', (_label, expression) => {
    expect(() => parseWhenConditionExpression(expression)).not.toThrow();
  });

  it.each([
    ['missing right operand', 'context.review.count =='],
    ['missing left operand', '== context.review.count'],
    ['empty logical clause', 'context.review.count > 0 && && context.review.blocked == 0'],
    ['unbalanced parenthesis', 'exists(context.review.items, item.severity == "high"'],
    ['unbalanced quote', 'structured.scan.note == "unfinished'],
    ['missing exists predicate', 'exists(context.review.items)'],
    ['unsupported exists operator', 'exists(context.review.items, item.severity != "high")'],
    ['missing contains value', 'contains(context.review.items[0].familyTags)'],
    ['too many contains arguments', 'contains(context.review.items[0].familyTags, "a", "b")'],
    ['multiple comparison operators', 'context.review.count == 0 == true'],
    ['unsupported bare operand', 'unknown'],
    ['unsupported comparison operand', 'unknown == true'],
    ['non-boolean bare number', '1'],
    ['non-boolean bare string', '"text"'],
    ['non-boolean bare null', 'null'],
    ['item operand outside exists', 'item.ok == true'],
    ['unsupported exists list', 'exists(unknown, item.ok == true)'],
    ['scope-only bare state', 'context.route_context'],
    ['scope-only exists list', 'exists(context.route_context, item.ok == true)'],
    ['string ordering comparison', '"a" > "b"'],
    ['boolean ordering comparison', 'true >= false'],
    ['null ordering comparison', 'null < 1'],
    ['empty state scope', 'context. == true'],
    ['empty array index', 'context.route_context.items[] == true'],
    ['unclosed array index', 'context.route_context.items[0 == true'],
    ['missing property delimiter after array index', 'context.route_context.items[0]id == 42'],
    ['non-numeric adjacent array index', 'context.route_context.items[0][id] == 42'],
    ['non-numeric array index', 'context.route_context.items[id] == 42'],
  ])('should reject an invalid expression with %s', (_label, expression) => {
    expect(() => parseWhenConditionExpression(expression)).toThrow();
  });

  it('should accept adjacent numeric array indexes', () => {
    expect(() => parseWhenConditionExpression(
      'context.route_context.matrix[0][1] == 42',
    )).not.toThrow();
  });

  it('should decode supported escapes in comparison string literals', () => {
    const expression = String.raw`structured.scan.note == "a\"b\\c"`;

    expect(parseWhenConditionExpression(expression)).toMatchObject({
      alternatives: [[{
        kind: 'comparison',
        right: { kind: 'literal', value: 'a"b\\c' },
      }]],
    });
  });

  it('should decode supported escapes in exists predicate string literals', () => {
    const expression = String.raw`exists(context.review.items, item.title == "a\"b" && item.description == "C:\\tmp")`;

    expect(parseWhenConditionExpression(expression)).toMatchObject({
      alternatives: [[{
        kind: 'exists',
        predicate: [
          { right: { kind: 'literal', value: 'a"b' } },
          { right: { kind: 'literal', value: 'C:\\tmp' } },
        ],
      }]],
    });
  });

  it('should decode supported escapes in contains() string literals', () => {
    const expression = String.raw`exists(context.review.items, contains(item.familyTags, "a\"b\\c"))`;

    expect(parseWhenConditionExpression(expression)).toMatchObject({
      alternatives: [[{
        kind: 'exists',
        predicate: [{
          kind: 'contains',
          valueExpression: { kind: 'literal', value: 'a"b\\c' },
        }],
      }]],
    });
  });

  it.each([
    String.raw`structured.scan.note == "line\nbreak"`,
    String.raw`structured.scan.note == "tab\tvalue"`,
    String.raw`structured.scan.note == "path\/value"`,
    String.raw`structured.scan.note == "\u0061"`,
  ])('should reject unsupported string escape in %s', (expression) => {
    expect(() => parseWhenConditionExpression(expression)).toThrow(
      'Invalid escape sequence in when operand',
    );
  });
});

describe('WorkflowConfigRawSchema when operand validation', () => {
  const placements = [
    ['step rule', (condition: string) => workflowWithStepRule(condition)],
    ['semantic compound', (condition: string) => workflowWithStepRule(`approved && ${condition}`)],
    ['aggregate target', (condition: string) => workflowWithAggregateTarget(condition)],
    ['loop monitor rule', (condition: string) => workflowWithLoopMonitorRule(condition)],
  ] as const;

  it.each(placements)(
    'should accept supported state operands in a %s',
    (_label, createWorkflow) => {
      const result = WorkflowConfigRawSchema.safeParse(
        createWorkflow('when(context.judge.ready == true)'),
      );

      expect(result.success).toBe(true);
    },
  );

  it.each(placements)(
    'should reject unsupported operands in a %s',
    (_label, createWorkflow) => {
      const result = WorkflowConfigRawSchema.safeParse(createWorkflow('when(unknown)'));

      expect(result.success).toBe(false);
    },
  );

  it.each(placements)(
    'should reject invalid array reference delimiters in a %s',
    (_label, createWorkflow) => {
      const invalidReferences = [
        'context.route_context.items[0]id',
        'context.route_context.items[0][id]',
        'context.route_context.items[id]',
      ];

      for (const reference of invalidReferences) {
        const result = WorkflowConfigRawSchema.safeParse(
          createWorkflow(`when(${reference} == 42)`),
        );

        expect(result.success).toBe(false);
      }
    },
  );

  it.each(placements)(
    'should reject statically non-boolean bare literals in a %s',
    (_label, createWorkflow) => {
      for (const expression of ['when(1)', 'when("text")', 'when(null)']) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

        expect(result.success).toBe(false);
      }
    },
  );

  it.each(placements)(
    'should reject non-numeric literal ordering operands in a %s',
    (_label, createWorkflow) => {
      const operators = ['>', '<', '>=', '<='];
      const nonNumericLiterals = ['"text"', 'true', 'null'];

      for (const operator of operators) {
        for (const literal of nonNumericLiterals) {
          const expressions = [
            `when(${literal} ${operator} 1)`,
            `when(1 ${operator} ${literal})`,
          ];
          for (const expression of expressions) {
            const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

            expect(result.success).toBe(false);
          }
        }
      }
    },
  );

  it.each(placements)(
    'should preserve scalar equality comparisons in a %s',
    (_label, createWorkflow) => {
      for (const expression of [
        'when("text" == "text")',
        'when(true != false)',
        'when(null == null)',
      ]) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should preserve dynamic state ordering comparisons in a %s',
    (_label, createWorkflow) => {
      const result = WorkflowConfigRawSchema.safeParse(
        createWorkflow('when(context.judge.score >= structured.judge.threshold)'),
      );

      expect(result.success).toBe(true);
    },
  );

  it.each(placements)(
    'should reject scope-only state operands in a %s',
    (_label, createWorkflow) => {
      const scopeOnlyReferences = [
        'context.route_context',
        'structured.judge',
        'effect.worker',
      ];

      for (const reference of scopeOnlyReferences) {
        for (const expression of [
          `when(${reference})`,
          `when(exists(${reference}, item.ok == true))`,
        ]) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

          expect(result.success).toBe(false);
        }
      }
    },
  );

  it.each(placements)(
    'should accept path-bearing state operands in a %s',
    (_label, createWorkflow) => {
      const references = [
        'context.route_context',
        'structured.judge',
        'effect.worker.command',
      ];

      for (const reference of references) {
        for (const expression of [
          `when(${reference}.ready)`,
          `when(exists(${reference}.items, item.ok == true))`,
        ]) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

          expect(result.success).toBe(true);
        }
      }
    },
  );

  it.each(placements)(
    'should accept supported string escapes in a %s',
    (_label, createWorkflow) => {
      const expressions = [
        String.raw`when(structured.scan.note == "a\"b\\c")`,
        String.raw`when(exists(context.review.items, item.title == "a\"b\\c"))`,
        String.raw`when(exists(context.review.items, contains(item.familyTags, "a\"b\\c")))`,
      ];

      for (const expression of expressions) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should reject unsupported string escapes in a %s',
    (_label, createWorkflow) => {
      const result = WorkflowConfigRawSchema.safeParse(
        createWorkflow(String.raw`when(structured.scan.note == "line\nbreak")`),
      );

      expect(result.success).toBe(false);
    },
  );

  it.each(placements)(
    'should reject malformed state references in a %s',
    (_label, createWorkflow) => {
      const result = WorkflowConfigRawSchema.safeParse(
        createWorkflow('when(context. == true)'),
      );

      expect(result.success).toBe(false);
    },
  );
});

function interactiveRule(condition: string, interactiveOnly = false): WorkflowRule {
  return normalizeRule({ condition, next: 'COMPLETE', ...(interactiveOnly ? { interactiveOnly } : {}) });
}

describe('workflow rule condition parsing', () => {
  it('keeps condition AST public operations recursive over an and condition', () => {
    const condition = parseWorkflowRuleCondition('approved && when(context.review.count == 0)');

    expect(condition).toEqual({
      kind: 'and',
      left: { kind: 'semantic', label: 'approved' },
      right: { kind: 'when', expression: 'context.review.count == 0' },
    });
    expect(formatWorkflowRuleCondition(condition)).toBe('approved && when(context.review.count == 0)');
    expect(semanticLabelsOf(condition)).toEqual(['approved']);
  });

  it('rejects empty when expressions at the normalization boundary', () => {
    expect(() => parseWorkflowRuleCondition('when()')).toThrow('empty when() expression');
    expect(() => parseWorkflowRuleCondition('approved && when(  )')).toThrow('empty when() expression');
    expect(() => parseWorkflowRuleCondition('all("approved") && when()')).toThrow('empty when() expression');
  });
});

describe('generateStatusRulesComponents interactive default', () => {
  const rules = [interactiveRule('approved'), interactiveRule('ユーザー入力が必要', true)];

  it('should exclude interactive-only rules from the criteria table when interactive is unspecified', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', [{ label: 'approved' }], 'ja');

    expect(components.criteriaTable).toContain('approved');
    expect(components.criteriaTable).not.toContain('ユーザー入力が必要');
  });

  it('should include interactive-only rules in the criteria table when interactive is true', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', [
      { label: 'approved' },
      { label: 'ユーザー入力が必要' },
    ], 'ja');

    expect(components.criteriaTable).toContain('ユーザー入力が必要');
  });
});

describe('workflow rule normalization', () => {
  it.each([
    ['required', 'required'],
    ['skip', 'skip'],
  ] as const)('normalizes command_gates %s to %s', (commandGates, expected) => {
    const normalized = normalizeRule({
      condition: 'approved',
      next: 'COMPLETE',
      command_gates: commandGates,
    });

    expect(normalized.commandGates).toBe(expected);
  });

  it('rejects the removed when alias instead of translating it into a condition', () => {
    expect(() => normalizeRule({
      when: 'context.review.count == 0',
      next: 'COMPLETE',
    })).toThrow(/condition/i);
  });

  it('rejects workflow rule ai() expressions', () => {
    expect(() => normalizeRule({
      condition: 'ai("all reviewers approved")',
      next: 'COMPLETE',
    })).toThrow(/ai\(\)|workflow rule/i);
  });

  it.each([
    'needs_fix && when(context.review.pending > 0)',
    'all("approved") && when(context.review.blocked == 0)',
    'any("needs_fix") && when(context.review.count > 0)',
  ])('keeps %s in the single condition AST without hidden guard fields', (condition) => {
    const normalized = normalizeRule({ condition, next: 'next-step' });

    expect(typeof normalized.condition).not.toBe('string');
    expect(normalized).not.toHaveProperty('guardCondition');
    expect(normalized).not.toHaveProperty('aggregateGuardCondition');
    expect(normalized).not.toHaveProperty('isAggregateCondition');
  });

  it('formats normalized condition ASTs for observability output', () => {
    const normalized = normalizeRule({
      condition: 'all("approved", "needs_fix") && when(context.review.count == 0)',
      next: 'next-step',
    });

    expect(formatWorkflowRuleCondition(normalized.condition))
      .toBe('all("approved", "needs_fix") && when(context.review.count == 0)');
  });

  it('omits next when normalizing a return-only rule', () => {
    const normalized = normalizeRule({ condition: 'needs_fix', return: 'need_replan' });

    expect(normalized).not.toHaveProperty('next');
    expect(normalized.returnValue).toBe('need_replan');
  });

  it.each([
    'all("x") extra',
    'approved && && when(context.review.count == 0)',
    'when(context.review.count == 0) && when(context.review.blocked == 0)',
  ])('rejects malformed reserved condition %s without treating it as a semantic label', (condition) => {
    expect(() => normalizeRule({ condition, next: 'COMPLETE' })).toThrow();
  });

  it('should reject an invalid when predicate before creating the condition AST', () => {
    expect(() => normalizeRule({
      condition: 'when(context.review.count ==)',
      next: 'COMPLETE',
    })).toThrow('Invalid when operand');
  });
});

describe('workflow step feature normalization', () => {
  it('normalizes arpeggio paths in the extracted helper', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const normalized = normalizeArpeggio(
      {
        source: 'files',
        source_path: 'fixtures/input.txt',
        batch_size: 5,
        concurrency: 2,
        template: 'fixtures/template.md',
        merge: {
          strategy: 'concat',
          separator: '\n',
        },
      },
      workflowDir,
    );

    expect(normalized).toMatchObject({
      source: 'files',
      batchSize: 5,
      concurrency: 2,
      sourcePath: join(workflowDir, 'fixtures/input.txt'),
      templatePath: join(workflowDir, 'fixtures/template.md'),
    });
  });
});
