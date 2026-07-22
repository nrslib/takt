import { describe, expect, it } from 'vitest';
import {
  describeFindingsReferencePath,
  type FindingsReferenceDescriptor,
} from '../core/models/workflow-findings-reference.js';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { parseWhenConditionExpression } from '../core/models/workflow-when-expression.js';

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
  it('should keep findings validation isolated from descriptor mutation attempts', () => {
    const descriptor = describeFindingsReferencePath(['open', 'count']);
    expect(descriptor).toBeDefined();

    const mutableDescriptor = descriptor as { kind: FindingsReferenceDescriptor['kind'] };
    let mutationError: unknown;
    try {
      mutableDescriptor.kind = 'string';
    } catch (error) {
      mutationError = error;
    }

    expect(mutationError).toBeInstanceOf(TypeError);
    expect(() => parseWhenConditionExpression('findings.open.count > 0')).not.toThrow();
  });

  it('should protect nested findings object and array descriptors at runtime', () => {
    const openDescriptor = describeFindingsReferencePath(['open']);
    const itemsDescriptor = describeFindingsReferencePath(['open', 'items']);
    const itemDescriptor = describeFindingsReferencePath(['open', 'items', '0']);
    const reviewersDescriptor = describeFindingsReferencePath(['open', 'items', 'reviewers']);
    expect(openDescriptor?.kind).toBe('object');
    expect(itemsDescriptor?.kind).toBe('array');
    expect(itemDescriptor?.kind).toBe('object');
    expect(reviewersDescriptor?.kind).toBe('array');
    if (
      openDescriptor?.kind !== 'object'
      || itemsDescriptor?.kind !== 'array'
      || itemDescriptor?.kind !== 'object'
      || reviewersDescriptor?.kind !== 'array'
    ) {
      throw new Error('Expected findings object and array descriptors');
    }

    expect(() => {
      (openDescriptor.properties as Record<string, FindingsReferenceDescriptor>).count = {
        kind: 'string',
      };
    }).toThrow(TypeError);
    expect(() => {
      (itemsDescriptor as { item: FindingsReferenceDescriptor }).item = { kind: 'string' };
    }).toThrow(TypeError);
    expect(() => {
      (itemDescriptor.properties as Record<string, FindingsReferenceDescriptor>).severity = {
        kind: 'number',
      };
    }).toThrow(TypeError);
    expect(() => {
      (reviewersDescriptor.item as { kind: FindingsReferenceDescriptor['kind'] }).kind =
        'number';
    }).toThrow(TypeError);

    expect(() => parseWhenConditionExpression('findings.open.count > 0')).not.toThrow();
    expect(() => parseWhenConditionExpression(
      'exists(findings.open.items, item.severity == "high")',
    )).not.toThrow();
  });

  it.each([
    ['boolean', 'true'],
    ['bare state operand', 'context.route_context.ready'],
    ['comparison', 'findings.open.count >= 1'],
    ['quoted operator', 'structured.scan.note == "a == b"'],
    [
      'logical clauses',
      'findings.open.count > 0 || findings.provisional.count > 0 && findings.conflicts.count == 0',
    ],
    [
      'exists predicate',
      'exists(findings.open.items, item.severity == "high" && item.title == "Example")',
    ],
  ])('should accept a valid %s expression', (_label, expression) => {
    expect(() => parseWhenConditionExpression(expression)).not.toThrow();
  });

  it.each([
    ['missing right operand', 'findings.open.count =='],
    ['missing left operand', '== findings.open.count'],
    ['empty logical clause', 'findings.open.count > 0 && && findings.conflicts.count == 0'],
    ['unbalanced parenthesis', 'exists(findings.open.items, item.severity == "high"'],
    ['unbalanced quote', 'structured.scan.note == "unfinished'],
    ['missing exists predicate', 'exists(findings.open.items)'],
    ['unsupported exists operator', 'exists(findings.open.items, item.severity != "high")'],
    ['multiple comparison operators', 'findings.open.count == 0 == true'],
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
    const expression = String.raw`exists(findings.open.items, item.title == "a\"b" && item.location == "C:\\tmp")`;

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
    'should reject non-boolean findings references as bare operands in a %s',
    (_label, createWorkflow) => {
      const references = [
        'findings.open',
        'findings.open.bySeverity',
        'findings.conflicts.unadjudicated',
        'findings.open.count',
        'findings.open.items',
        'findings.open.items[0].id',
        'findings.unknown',
      ];

      for (const reference of references) {
        const result = WorkflowConfigRawSchema.safeParse(
          createWorkflow(`when(${reference})`),
        );

        expect(result.success).toBe(false);
      }
    },
  );

  it.each(placements)(
    'should accept boolean findings references as bare operands in a %s',
    (_label, createWorkflow) => {
      const references = [
        'findings.provisional.fixpoint',
        'findings.rounds.budgetExhausted',
        'findings.reviewerAnomalies.budgetExhausted',
      ];

      for (const reference of references) {
        const result = WorkflowConfigRawSchema.safeParse(
          createWorkflow(`when(${reference})`),
        );

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should reject non-array findings references as exists lists in a %s',
    (_label, createWorkflow) => {
      const references = [
        'findings.open',
        'findings.open.bySeverity',
        'findings.conflicts.unadjudicated',
        'findings.open.count',
        'findings.provisional.fixpoint',
        'findings.open.items[0].id',
        'findings.unknown',
      ];

      for (const reference of references) {
        const result = WorkflowConfigRawSchema.safeParse(
          createWorkflow(`when(exists(${reference}, item.id == "F-1"))`),
        );

        expect(result.success).toBe(false);
      }
    },
  );

  it.each(placements)(
    'should accept array findings references as exists lists in a %s',
    (_label, createWorkflow) => {
      const references = [
        'findings.open.items',
        'findings.provisional.items',
        'findings.conflicts.items',
      ];

      for (const reference of references) {
        const result = WorkflowConfigRawSchema.safeParse(
          createWorkflow(`when(exists(${reference}, item.id == "F-1"))`),
        );

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should accept every known findings item field in a %s',
    (_label, createWorkflow) => {
      const references = [
        ['findings.open.items', [
          'id',
          'severity',
          'title',
          'location',
          'description',
          'suggestion',
          'reviewers',
          'reviewers.length',
          'reviewers.0',
        ]],
        ['findings.provisional.items', ['id', 'kind', 'reason']],
        ['findings.conflicts.items', [
          'id',
          'status',
          'findingIds',
          'findingIds.length',
          'findingIds.0',
          'rawFindingIds',
          'rawFindingIds.length',
          'rawFindingIds.0',
          'description',
        ]],
      ] as const;

      for (const [listReference, fields] of references) {
        for (const field of fields) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(
            `when(exists(${listReference}, item.${field} == item.${field}))`,
          ));

          expect(result.success).toBe(true);
        }
      }
    },
  );

  it.each(placements)(
    'should accept every optional findings item access form in a %s',
    (_label, createWorkflow) => {
      for (const field of ['location', 'description', 'suggestion']) {
        for (const expression of [
          `when(exists(findings.open.items, item.${field} == "value"))`,
          `when(findings.open.items[0].${field} == null)`,
          `when(findings.open.items.${field}.length == 2)`,
        ]) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

          expect(result.success).toBe(true);
        }
      }
    },
  );

  it.each(placements)(
    'should reject unknown fields for every findings item shape in a %s',
    (_label, createWorkflow) => {
      const invalidReferences = [
        ['findings.open.items', 'reviewed'],
        ['findings.open.items', 'constructor'],
        ['findings.open.items', 'id.value'],
        ['findings.open.items', 'reviewers.unknown'],
        ['findings.provisional.items', 'title'],
        ['findings.conflicts.items', 'severity'],
        ['findings.conflicts.items', 'findingIds.unknown'],
      ] as const;

      for (const [listReference, field] of invalidReferences) {
        for (const predicate of [
          `item.${field} == false`,
          `false == item.${field}`,
        ]) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(
            `when(exists(${listReference}, ${predicate}))`,
          ));

          expect(result.success).toBe(false);
        }
      }
    },
  );

  it.each(placements)(
    'should reject unknown findings comparison paths in a %s',
    (_label, createWorkflow) => {
      for (const expression of [
        'when(findings.unknown == 0)',
        'when(findings.constructor == 0)',
        'when(0 == findings.unknown)',
        'when(findings.open.missing == 0)',
        'when(findings.open.constructor == 0)',
        'when(findings.open.items[0].missing == "value")',
      ]) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

        expect(result.success).toBe(false);
      }
    },
  );

  it.each(placements)(
    'should accept known findings comparison paths in a %s',
    (_label, createWorkflow) => {
      const references = [
        'findings.open',
        'findings.open.items',
        'findings.provisional.fixpoint',
        'findings.open.items[0].id',
        'findings.open.items.id',
        'findings.open.items.length',
      ];

      for (const reference of references) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(
          `when(${reference} == ${reference})`,
        ));

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should reject every known non-number findings kind in ordering comparisons in a %s',
    (_label, createWorkflow) => {
      const nonNumericReferences = [
        'findings.open',
        'findings.open.items',
        'findings.provisional.fixpoint',
        'findings.open.items[0].id',
      ];

      for (const reference of nonNumericReferences) {
        for (const expression of [
          `when(${reference} > 0)`,
          `when(0 < ${reference})`,
        ]) {
          const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

          expect(result.success).toBe(false);
        }
      }
    },
  );

  it.each(placements)(
    'should accept number findings references in ordering comparisons in a %s',
    (_label, createWorkflow) => {
      for (const expression of [
        'when(findings.open.count >= 1)',
        'when(1 <= findings.open.bySeverity.high)',
      ]) {
        const result = WorkflowConfigRawSchema.safeParse(createWorkflow(expression));

        expect(result.success).toBe(true);
      }
    },
  );

  it.each(placements)(
    'should accept supported string escapes in a %s',
    (_label, createWorkflow) => {
      const expressions = [
        String.raw`when(structured.scan.note == "a\"b\\c")`,
        String.raw`when(exists(findings.open.items, item.title == "a\"b\\c"))`,
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
