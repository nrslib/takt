import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import { getWorkflowConfigErrorPath } from '../core/workflow/workflow-config-error.js';
import { hasCompanionReference, parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { prepareCallableSubworkflowDiscoveryArgs } from '../infra/config/loaders/workflowCallableDiscoveryArgs.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function createWorkflowCallStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'delegate',
    kind: 'workflow_call',
    call: 'takt/review-loop',
    rules: [
      {
        condition: 'COMPLETE',
        next: 'COMPLETE',
      },
    ],
    ...overrides,
  };
}

function createDynamicPoolWorkflow(pool: unknown): Record<string, unknown> {
  return {
    name: 'invalid-dynamic-pool',
    steps: [{
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement',
      dynamic_facets: { pool },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

function createRootDynamicFacetPoolWorkflow(poolName: string): Record<string, unknown> {
  return {
    ...createDynamicPoolWorkflow(poolName),
    policies: { policy: 'Policy' },
    facet_pools: {
      available: {
        candidates: [{
          id: 'candidate',
          description: 'Candidate',
          policy: 'policy',
        }],
      },
    },
  };
}

function createCallableFacetPoolWorkflow(): Record<string, unknown> {
  return {
    name: 'invalid-callable-pool',
    subworkflow: {
      callable: true,
      params: {
        implementation_pool: { type: 'facet_pool_ref' },
      },
    },
    policies: { policy: 'Policy' },
    facet_pools: {
      available: {
        candidates: [{
          id: 'candidate',
          description: 'Candidate',
          policy: 'policy',
        }],
      },
    },
    steps: [{
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement',
      dynamic_facets: {
        pool: { $param: 'implementation_pool' },
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

function createCallableCompanionWorkflow(): Record<string, unknown> {
  return {
    name: 'callable-companion',
    subworkflow: {
      callable: true,
      params: {
        implementation_companions: {
          type: 'companion_ref[]',
          default: [],
        },
      },
    },
    steps: [{
      name: 'implement',
      instruction: 'Implement',
      companion: { $param: 'implementation_companions' },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }, {
      name: 'fix',
      instruction: 'Fix',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

function createCallableScalarFacetWorkflow(): Record<string, unknown> {
  return {
    name: 'callable-scalar-facets',
    subworkflow: {
      callable: true,
      params: {
        review_persona: { type: 'facet_ref', facet_kind: 'persona', default: 'reviewer' },
        review_policy: { type: 'facet_ref', facet_kind: 'policy', default: 'strict-review' },
        review_knowledge: { type: 'facet_ref', facet_kind: 'knowledge', default: 'architecture' },
        review_instruction: { type: 'facet_ref', facet_kind: 'instruction', default: 'review-instruction' },
        review_format: { type: 'facet_ref', facet_kind: 'report_format', default: 'summary' },
      },
    },
    personas: { reviewer: 'Reviewer persona content' },
    policies: { 'strict-review': 'Strict review policy content' },
    knowledge: { architecture: 'Architecture knowledge content' },
    instructions: { 'review-instruction': 'Review instruction content' },
    report_formats: { summary: 'Summary format content' },
    steps: [{
      name: 'review',
      persona: { $param: 'review_persona' },
      policy: { $param: 'review_policy' },
      knowledge: { $param: 'review_knowledge' },
      instruction: { $param: 'review_instruction' },
      output_contracts: {
        report: [{ name: 'summary', format: { $param: 'review_format' } }],
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

const workflowCallForbiddenFieldCases = [
  { field: 'persona', value: 'coder' },
  { field: 'persona_name', value: 'Coder' },
  { field: 'tags', value: ['review'] },
  { field: 'policy', value: 'secure-defaults' },
  { field: 'knowledge', value: 'architecture' },
  {
    field: 'mcp_servers',
    value: {
      local: {
        command: 'echo',
      },
    },
  },
  { field: 'provider', value: 'codex' },
  { field: 'model', value: 'gpt-5-codex' },
  {
    field: 'provider_options',
    value: {
      codex: {
        network_access: true,
      },
    },
  },
  { field: 'required_permission_mode', value: 'full' },
  { field: 'edit', value: false },
  { field: 'requires_user_input', value: true },
  { field: 'instruction', value: 'Do not allow inline instructions.' },
  { field: 'session', value: 'continue' },
  { field: 'delay_before_ms', value: 1000 },
  {
    field: 'structured_output',
    value: {
      schema_ref: 'review.schema.json',
    },
  },
  {
    field: 'system_inputs',
    value: [
      {
        type: 'task_context',
        source: 'current_task',
        as: 'task',
      },
    ],
  },
  {
    field: 'effects',
    value: [
      {
        type: 'merge_pr',
        pr: 42,
      },
    ],
  },
  {
    field: 'parallel',
    value: [
      {
        name: 'substep',
      },
    ],
  },
  { field: 'concurrency', value: 2 },
  {
    field: 'arpeggio',
    value: {
      source: 'items',
      source_path: 'items.json',
      template: 'Process {item}',
    },
  },
  {
    field: 'team_leader',
    value: {
      persona: 'leader',
    },
  },
  {
    field: 'output_contracts',
    value: {
      report: [
        {
          name: 'summary',
          format: 'markdown',
        },
      ],
    },
  },
  { field: 'quality_gates', value: ['Review before finishing'] },
  { field: 'pass_previous_response', value: false },
] as const;

describe('workflow_call schema', () => {
  it('should preserve an explicit max_steps on a root workflow', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'root',
      max_steps: 7,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp');

    expect(workflow.maxSteps).toBe(7);
  });

  it('should apply the default max_steps only to a root workflow', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'root',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp');

    expect(workflow.maxSteps).toBe(10);
  });

  it.each([3, 'infinite'] as const)('should preserve explicit max_steps %s on a callable workflow', (maxSteps) => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'shared/review',
      subworkflow: { callable: true },
      max_steps: maxSteps,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });

    expect(result.success).toBe(true);
    expect(normalizeWorkflowConfig(result.data!, '/tmp').maxSteps).toBe(maxSteps);
  });

  it('should retain the default max_steps when a callable workflow is run directly', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'shared/review',
      subworkflow: { callable: true },
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp');

    expect(workflow.maxSteps).toBe(10);
  });

  it('should omit an empty companion_ref[] while preserving ordinary rules', () => {
    const workflow = normalizeWorkflowConfig(createCallableCompanionWorkflow(), '/tmp');
    const implement = workflow.steps.find((step) => step.name === 'implement');

    expect(implement).toBeDefined();
    expect(implement?.companion).toBeUndefined();
    expect(implement?.rules).toHaveLength(1);
    expect(implement?.rules?.[0]?.next).toBe('COMPLETE');
  });

  it('should expand companion_ref[] to fixed companions without adding rules', () => {
    const workflow = normalizeWorkflowConfig(createCallableCompanionWorkflow(), '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, {
      callableArgs: {
        implementation_companions: ['first-reviewer', 'second-reviewer'],
      },
    });
    const implement = workflow.steps.find((step) => step.name === 'implement');

    expect(implement?.companion).toEqual({
      fixed: ['first-reviewer', 'second-reviewer'],
      pool: [],
    });
    expect(implement?.rules).toHaveLength(1);
    expect(implement?.rules?.[0]?.next).toBe('COMPLETE');
  });

  it('should preserve a companion selection object through callable arg expansion', () => {
    const workflow = normalizeWorkflowConfig(createCallableCompanionWorkflow(), '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, {
      callableArgs: {
        implementation_companions: {
          fixed: ['reviewer'],
          pool: [],
          moderator: 'review-adjudicator',
        },
      },
    });
    const implement = workflow.steps.find((step) => step.name === 'implement');

    expect(implement?.companion).toEqual({
      fixed: ['reviewer'],
      pool: [],
      moderator: 'review-adjudicator',
    });
  });

  it.each([
    {
      label: 'without a reviewer',
      value: { fixed: [], pool: [], moderator: 'review-adjudicator' },
      message: 'companion selection requires a fixed or pool reference',
    },
    {
      label: 'with a duplicate moderator',
      value: { fixed: ['review-adjudicator'], pool: [], moderator: 'review-adjudicator' },
      message: 'companion moderator cannot also be a reviewer',
    },
    {
      label: 'with a malformed reviewer list',
      value: { fixed: 'reviewer', pool: [], moderator: 'review-adjudicator' },
      message: 'must be a companion_ref[] array or selection object',
    },
  ])('should reject a malformed companion selection object: $label', ({ value, message }) => {
    expect(() => normalizeWorkflowConfig(createCallableCompanionWorkflow(), '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, {
      callableArgs: { implementation_companions: value },
    })).toThrow(message);
  });

  it('should preserve scalar facet params while expanding callable steps', () => {
    const workflow = normalizeWorkflowConfig(createCallableScalarFacetWorkflow(), '/tmp');
    const review = workflow.steps[0];

    expect(review.persona).toContain('Reviewer persona content');
    expect(review.policyContents?.map((facet) => facet.content)).toEqual(['Strict review policy content']);
    expect(review.knowledgeContents?.map((facet) => facet.content)).toEqual(['Architecture knowledge content']);
    expect(review.instruction).toContain('Review instruction content');
    expect(review.outputContracts?.[0]?.format).toContain('Summary format content');
  });

  it('should retain an unrelated first when rule instead of removing it', () => {
    const workflow = createCallableCompanionWorkflow();
    (workflow.steps as Array<Record<string, unknown>>)[0]!.rules = [
      { condition: 'when(true)', next: 'fix' },
      { condition: 'done', next: 'COMPLETE' },
    ];

    const normalized = normalizeWorkflowConfig(workflow, '/tmp');
    const implement = normalized.steps.find((step) => step.name === 'implement');

    expect(implement?.companion).toBeUndefined();
    expect(implement?.rules?.map((rule) => rule.next)).toEqual(['fix', 'COMPLETE']);
    expect(implement?.rules?.[0]?.condition).toMatchObject({
      kind: 'when',
      expression: 'true',
    });
  });

  it.each(['companion.escalated', 'companion.escalated == true'])
    ('should retain a semantic companion label when companions are empty: %s', (condition) => {
      const workflow = createCallableCompanionWorkflow();
      (workflow.steps as Array<Record<string, unknown>>)[0]!.rules = [
        { condition, next: 'fix' },
        { condition: 'done', next: 'COMPLETE' },
      ];

      const normalized = normalizeWorkflowConfig(workflow, '/tmp');
      const implement = normalized.steps.find((step) => step.name === 'implement');

      expect(implement?.companion).toBeUndefined();
      expect(implement?.rules?.[0]?.condition).toEqual({ kind: 'semantic', label: condition });
      expect(implement?.rules).toHaveLength(2);
    });

  it('should recurse through aggregate targets and ignore semantic or quoted companion text', () => {
    const aggregateRule = 'all("when(companion.openMustFixCount == 0)")';
    const schemaResult = WorkflowStepRawSchema.safeParse({
      name: 'parallel-review',
      parallel: [{
        name: 'review',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
      rules: [{ condition: aggregateRule, next: 'COMPLETE' }],
    });

    expect(schemaResult.success).toBe(false);
    expect(schemaResult.error?.issues[0]?.message)
      .toContain('Workflow transition rules cannot reference advisory companion state');
    expect(hasCompanionReference(parseWorkflowRuleCondition(aggregateRule))).toBe(true);
    expect(hasCompanionReference(parseWorkflowRuleCondition('companion.openMustFixCount'))).toBe(false);
    expect(hasCompanionReference(parseWorkflowRuleCondition('when(context.status == "companion.openMustFixCount")'))).toBe(false);
  });

  it('should reject companion state rules even when companions are non-empty', () => {
    const workflow = createCallableCompanionWorkflow();
    (workflow.steps as Array<Record<string, unknown>>)[0]!.rules = [
      { condition: 'when(companion.escalated)', next: 'fix' },
      { condition: 'when(companion.openMustFixCount == 0)', next: 'fix' },
      { condition: 'done', next: 'COMPLETE' },
    ];

    expect(() => normalizeWorkflowConfig(
      workflow,
      '/tmp',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { callableArgs: { implementation_companions: ['reviewer'] } },
    )).toThrow('Workflow transition rules cannot reference advisory companion state');
  });

  it('should not reject a quoted companion string in a remaining when rule', () => {
    const workflow = createCallableCompanionWorkflow();
    (workflow.steps as Array<Record<string, unknown>>)[0]!.rules = [
      { condition: 'when(true)', next: 'fix' },
      { condition: 'when(context.status == "companion.openMustFixCount")', next: 'fix' },
      { condition: 'done', next: 'COMPLETE' },
    ];

    const normalized = normalizeWorkflowConfig(workflow, '/tmp');
    const implement = normalized.steps.find((step) => step.name === 'implement');

    expect(implement?.companion).toBeUndefined();
    expect(implement?.rules).toHaveLength(3);
    expect(implement?.rules?.[1]?.condition).toMatchObject({
      kind: 'when',
      expression: 'context.status == "companion.openMustFixCount"',
    });
  });

  it('should reject a scalar companion_ref[] argument before expansion', () => {
    expect(() => normalizeWorkflowConfig(createCallableCompanionWorkflow(), '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, {
      callableArgs: {
        implementation_companions: 'first-reviewer',
      },
    })).toThrow('must be a companion_ref[] array');
  });

  it('should reject an undeclared companion parameter reference before schema validation', () => {
    const workflow = createCallableCompanionWorkflow();
    workflow.steps = [{
      name: 'implement',
      instruction: 'Implement',
      companion: { $param: 'undeclared_companions' },
      rules: [
        { condition: 'done', next: 'fix' },
        { condition: 'done', next: 'COMPLETE' },
      ],
    }, {
      name: 'fix',
      instruction: 'Fix',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }];

    expect(() => normalizeWorkflowConfig(workflow, '/tmp'))
      .toThrow(/undeclared_companions/);
  });

  it('should supply an empty discovery binding for a required companion_ref[] parameter', () => {
    const workflow = createCallableCompanionWorkflow();
    workflow.subworkflow = {
      callable: true,
      params: {
        implementation_companions: { type: 'companion_ref[]' },
      },
    };
    const raw = WorkflowConfigRawSchema.parse(workflow);

    expect(prepareCallableSubworkflowDiscoveryArgs(raw).callableArgs).toEqual({
      implementation_companions: [],
    });
  });

  it('should use a suffixed synthetic discovery pool when the default pool name collides', () => {
    const syntheticPoolName = '__takt_discovery_pool__implementation_pool';
    const raw = WorkflowConfigRawSchema.parse({
      name: 'pool-discovery',
      subworkflow: {
        callable: true,
        params: {
          implementation_pool: {
            type: 'facet_pool_ref',
          },
        },
      },
      policies: {
        policy: 'Discovery policy',
      },
      knowledge: {
        knowledge: 'Discovery knowledge',
      },
      facet_pools: {
        [syntheticPoolName]: {
          candidates: [{
            id: 'existing-candidate',
            description: 'Existing pool candidate',
            policy: 'policy',
          }],
        },
        first: {
          candidates: [{
            id: 'first-candidate',
            description: 'First candidate',
            policy: 'policy',
          }],
        },
        second: {
          candidates: [{
            id: 'second-candidate',
            description: 'Second candidate',
            knowledge: 'knowledge',
          }],
        },
      },
      steps: [{
        name: 'implement',
        persona: 'reviewer',
        instruction: 'Review',
        dynamic_facets: {
          pool: {
            $param: 'implementation_pool',
          },
        },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });

    const prepared = prepareCallableSubworkflowDiscoveryArgs(raw);
    const suffixedPoolName = `${syntheticPoolName}_1`;
    expect(prepared.callableArgs).toEqual({ implementation_pool: suffixedPoolName });
    expect(prepared.raw.facet_pools?.[syntheticPoolName]).toEqual({
      candidates: [{
        id: 'existing-candidate',
        description: 'Existing pool candidate',
        policy: 'policy',
      }],
    });
    expect(prepared.raw.facet_pools?.first).toBeDefined();
    expect(prepared.raw.facet_pools?.second).toBeDefined();
    expect(prepared.raw.facet_pools?.[suffixedPoolName]).toEqual({
      candidates: [{
        id: suffixedPoolName + '-candidate',
        description: '[discovery placeholder candidate for facet pool param "implementation_pool"]',
        policy: '__takt_discovery_param___policy_implementation_pool',
        knowledge: '__takt_discovery_param___knowledge_implementation_pool',
      }],
    });
    expect(prepared.raw.policies?.['__takt_discovery_param___policy_implementation_pool']).toBeDefined();
    expect(prepared.raw.knowledge?.['__takt_discovery_param___knowledge_implementation_pool']).toBeDefined();
  });

  it('should use the base synthetic pool name when the default name is inherited', () => {
    const poolName = '__takt_discovery_pool__implementation_pool';
    const raw = WorkflowConfigRawSchema.parse({
      name: 'inherited-pool-discovery',
      subworkflow: {
        callable: true,
        params: {
          implementation_pool: { type: 'facet_pool_ref' },
        },
      },
      policies: { policy: 'Discovery policy' },
      knowledge: { knowledge: 'Discovery knowledge' },
      steps: [{
        name: 'implement',
        persona: 'reviewer',
        instruction: 'Review',
        dynamic_facets: { pool: { $param: 'implementation_pool' } },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, poolName);

    try {
      Object.defineProperty(Object.prototype, poolName, {
        configurable: true,
        enumerable: false,
        value: { inherited: true },
        writable: true,
      });

      const prepared = prepareCallableSubworkflowDiscoveryArgs(raw);
      expect(prepared.callableArgs).toEqual({ implementation_pool: poolName });
      expect(Object.hasOwn(prepared.raw.facet_pools ?? {}, poolName)).toBe(true);
      expect(prepared.raw.facet_pools?.[poolName]?.candidates).toHaveLength(1);
    } finally {
      if (previousDescriptor === undefined) {
        delete Object.prototype[poolName];
      } else {
        Object.defineProperty(Object.prototype, poolName, previousDescriptor);
      }
    }
  });

  it('should report the dynamic pool field path when a non-string pool reaches normalization', () => {
    let thrown: unknown;
    try {
      normalizeWorkflowConfig({
        name: 'invalid-dynamic-pool',
        steps: [{
          name: 'implement',
          persona: 'coder',
          instruction: 'Implement',
          dynamic_facets: {
            pool: { $param: 'implementation_pool' },
          },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      }, '/tmp');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(getWorkflowConfigErrorPath(thrown)).toEqual([
      'steps',
      0,
      'dynamic_facets',
      'pool',
    ]);
    expect((thrown as Error).message).toContain('dynamic_facets.pool has an unresolved parameter reference');
  });

  it.each([
    { label: 'an array', value: ['available'] },
    { label: 'null', value: null },
  ])('should report the dynamic pool path when $label is supplied', ({ value }) => {
    let thrown: unknown;
    try {
      normalizeWorkflowConfig(createDynamicPoolWorkflow(value), '/tmp');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(getWorkflowConfigErrorPath(thrown)).toEqual([
      'steps',
      0,
      'dynamic_facets',
      'pool',
    ]);
    expect((thrown as { message: string }).message).toContain(
      `Invalid input: expected string, received ${value === null ? 'null' : 'array'}`,
    );
  });

  it.each([
    { label: 'an array', value: ['available'], expectedMessage: 'must be a scalar facet_pool_ref' },
    { label: 'null', value: null, expectedMessage: 'references unknown facet pool "null"' },
  ])('should report the callable argument path when $label is supplied', ({ value, expectedMessage }) => {
    let thrown: unknown;
    try {
      normalizeWorkflowConfig(
        createCallableFacetPoolWorkflow(),
        '/tmp',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          callableArgs: {
            implementation_pool: value as unknown as string | string[],
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(getWorkflowConfigErrorPath(thrown)).toEqual(['callableArgs', 'implementation_pool']);
    expect((thrown as Error).message).toContain(expectedMessage);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'should reject an undeclared facet pool when a callable arg uses the inherited key %s',
    (poolName) => {
      let thrown: unknown;
      try {
        normalizeWorkflowConfig(
          createCallableFacetPoolWorkflow(),
          '/tmp',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { callableArgs: { implementation_pool: poolName } },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        `workflow_call arg "implementation_pool" references unknown facet pool "${poolName}"`,
      );
      expect(getWorkflowConfigErrorPath(thrown)).toEqual(['callableArgs', 'implementation_pool']);
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'should reject an inherited root facet pool name when dynamic facets use %s',
    (poolName) => {
      let thrown: unknown;
      try {
        normalizeWorkflowConfig(createRootDynamicFacetPoolWorkflow(poolName), '/tmp');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        `Configuration error: step "implement" references unknown facet pool "${poolName}"`,
      );
      expect(getWorkflowConfigErrorPath(thrown)).toEqual([
        'steps',
        0,
        'dynamic_facets',
        'pool',
      ]);
    },
  );

  it('accepts scalar vars only on workflow_call steps and preserves them after normalization', () => {
    const raw = {
      name: 'parent',
      steps: [createWorkflowCallStep({
        vars: {
          review_mode: 'follow_up',
          attempt: 2,
          strict: true,
          disabled: false,
          offset: 0,
        },
      })],
    };

    expect(WorkflowConfigRawSchema.safeParse(raw).success).toBe(true);
    expect(normalizeWorkflowConfig(raw, '/tmp').steps[0]).toMatchObject({
      vars: {
        review_mode: 'follow_up',
        attempt: 2,
        strict: true,
        disabled: false,
        offset: 0,
      },
    });

    const agentResult = WorkflowStepRawSchema.safeParse({
      name: 'review',
      persona: 'reviewer',
      instruction: 'review',
      vars: { review_mode: 'initial' },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    expect(agentResult.success).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['1mode', 'leading digit'],
    ['review mode', 'whitespace'],
  ])('rejects a workflow_call var key at the parser boundary: %s (%s)', (key) => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      vars: { [key]: 'follow_up' },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('vars'))).toBe(true);
    }
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects a non-finite workflow_call var value: %s',
    (value) => {
      const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
        vars: { attempt: value },
      }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('vars'))).toBe(true);
      }
    },
  );

  it.each([
    ['Initial', 'case alias'],
    ['follow-up', 'hyphen alias'],
    ['', 'empty string'],
    [1, 'number'],
    [true, 'boolean'],
  ])('rejects reserved review_mode outside its exact domain: %j (%s)', (value, _label) => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      vars: { review_mode: value },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => (
        issue.path.includes('vars') && issue.path.includes('review_mode')
      ))).toBe(true);
    }
  });

  it.each(['initial', 'follow_up', 'unspecified'])(
    'accepts exact reserved review_mode value %s without narrowing other vars',
    (reviewMode) => {
      const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
        vars: { review_mode: reviewMode, generic_number: 2, generic_boolean: true },
      }));

      expect(result.success).toBe(true);
    },
  );

  it('rejects vars on system steps', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route',
      kind: 'system',
      vars: { review_mode: 'initial' },
      rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'vars')).toBe(true);
    }
  });

  it('accepts workflow_ref params and empty facet_ref array values', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'composer',
      subworkflow: {
        callable: true,
        params: {
          target: {
            type: 'workflow_ref',
          },
          additions: {
            type: 'facet_ref[]',
            facet_kind: 'policy',
            default: [],
          },
        },
      },
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: { $param: 'target' },
        args: {
          child_additions: [],
        },
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects param composition outside a callable workflow', () => {
    expect(() => normalizeWorkflowConfig({
      name: 'non-callable',
      policies: {
        base: 'Base policy',
      },
      steps: [{
        name: 'review',
        persona: 'reviewer',
        policy: [
          'base',
          { $param: 'additions' },
        ],
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp')).toThrow();
  });

  it('workflow_call v2 DSL を保持できる', () => {
    const callableResult = WorkflowConfigRawSchema.safeParse({
      name: 'shared/review-loop',
      subworkflow: {
        callable: true,
        visibility: 'internal',
        returns: ['ok', 'retry_plan'],
        params: {
          review_policy: {
            type: 'facet_ref[]',
            facet_kind: 'policy',
            default: ['strict-review'],
          },
          review_knowledge: {
            type: 'facet_ref[]',
            facet_kind: 'knowledge',
            default: ['architecture'],
          },
          fix_instruction: {
            type: 'facet_ref',
            facet_kind: 'instruction',
          },
          review_report_format: {
            type: 'facet_ref',
            facet_kind: 'report_format',
          },
        },
      },
      initial_step: 'review',
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          policy: {
            $param: 'review_policy',
          },
          knowledge: {
            $param: 'review_knowledge',
          },
          instruction: {
            $param: 'fix_instruction',
          },
          output_contracts: {
            report: [
              {
                name: 'summary',
                format: {
                  $param: 'review_report_format',
                },
              },
            ],
          },
          rules: [
            {
              condition: 'done',
              return: 'ok',
            },
          ],
        },
      ],
    });

    expect(callableResult.success).toBe(true);
    if (!callableResult.success) {
      return;
    }

    const parentResult = WorkflowConfigRawSchema.safeParse({
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          args: {
            fix_instruction: 'fix-child',
          },
          rules: [
            {
              condition: 'ok',
              next: 'COMPLETE',
            },
            {
              condition: 'retry_plan',
              next: 'plan',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    expect(parentResult.success).toBe(true);
  });

  it('subworkflow callable と workflow_call step の DSL を保持できる', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'takt/coding',
      subworkflow: {
        callable: true,
      },
      initial_step: 'delegate',
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/review-loop',
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const config = result.data as Record<string, unknown>;
    const steps = config.steps as Array<Record<string, unknown>>;

    expect(config.subworkflow).toEqual({ callable: true });
    expect(steps[0]).toMatchObject({
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {
        provider: 'codex',
        model: 'gpt-5-codex',
        provider_options: {
          codex: {
            network_access: true,
          },
        },
      },
    });
  });

  it.each(['COMPLETE', 'ABORT'])('subworkflow.returns で予約語 %s を reject する', (reservedResult) => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'shared/review-loop',
      subworkflow: {
        callable: true,
        returns: [reservedResult],
      },
      initial_step: 'review',
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['subworkflow', 'returns', 0],
        }),
      ]));
    }
  });

  it.each([
    'when(true)',
    'all("approved")',
    'any("needs_fix")',
    'approved && when(true)',
    'ai("approved")',
  ])('subworkflow.returns でcondition予約構文 %s を reject する', (reservedResult) => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'shared/review-loop',
      subworkflow: {
        callable: true,
        returns: [reservedResult],
      },
      initial_step: 'review',
      max_steps: 3,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['subworkflow', 'returns', 0] }),
      ]));
    }
  });

  it.each([
    'when(true)',
    'all("COMPLETE")',
    'any("ABORT")',
    'approved && when(true)',
  ])('workflow全体のworkflow_callで非semantic condition %s をrejectする', (condition) => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          rules: [{ condition, next: 'COMPLETE' }],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['steps', 0, 'rules', 0, 'condition'] }),
      ]));
    }
  });

  it.each(workflowCallForbiddenFieldCases)(
    'workflow_call step で $field を reject する',
    ({ field, value }) => {
      const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
        [field]: value,
      }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    },
  );

  it('workflow_call step で call 欠落を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['call'],
      }));
    }
  });

  it('workflow_call step で COMPLETE と ABORT の rules を許可する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'COMPLETE',
          next: 'plan',
        },
        {
          condition: 'ABORT',
          next: 'ABORT',
        },
      ],
    }));

    expect(result.success).toBe(true);
  });

  it('workflow_call step で when rule を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'when(true)',
          next: 'COMPLETE',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'condition'],
        }),
      ]));
    }
  });

  it('workflow_call step で ai() condition を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'ai("route to plan")',
          next: 'plan',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'condition'],
        }),
      ]));
    }
  });

  it('workflow_call step で COMPLETE と ABORT 以外の condition を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'condition'],
        }),
      ]));
    }
  });

  it('output_contracts.report.order で $param を reject する', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'shared/review-loop',
      subworkflow: {
        callable: true,
        params: {
          review_report_format: {
            type: 'facet_ref',
            facet_kind: 'report_format',
          },
        },
      },
      initial_step: 'review',
      max_steps: 3,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review the child workflow',
          output_contracts: {
            report: [
              {
                name: 'summary',
                format: 'summary',
                order: {
                  $param: 'review_report_format',
                },
              },
            ],
          },
          rules: [
            {
              condition: 'done',
              return: 'ok',
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['steps', 0, 'output_contracts', 'report', 0, 'order'],
        }),
      ]));
    }
  });

  const reportProducer = (name: string, reportName: string) => ({
    name,
    persona: 'reviewer',
    output_contracts: {
      report: [{ name: reportName, format: 'markdown' }],
    },
  });

  it('異なる step が同一 report identity を継続更新することを許可する', () => {
    expect(WorkflowConfigRawSchema.safeParse({
      name: 'report-identity',
      steps: [
        reportProducer('first', 'review.md'),
        reportProducer('second', 'review.md'),
      ],
    }).success).toBe(true);
  });

  it.each([
    ['Unicode full case-fold', 'Straße.md', 'STRASSE.md'],
    ['NFC/NFD', 'réview.md', 're\u0301view.md'],
  ])('%s の portable identity 衝突を reject する', (_label, firstName, secondName) => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'report-identity',
      steps: [
        reportProducer('first', firstName),
        {
          name: 'parallel',
          parallel: [reportProducer('nested', secondName)],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('collides with'),
        }),
      ]));
    }
  });

  it('非canonicalな Windows separator を書き換えず reject する', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'report-separator',
      steps: [reportProducer('review', 'nested\\review.md')],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['steps', 0, 'output_contracts', 'report', 0, 'name'],
          message: expect.stringContaining('non-canonical path separator'),
        }),
      ]));
    }
  });

  it('同一 step 内の同名 report を reject する', () => {
    const producer = reportProducer('review', 'review.md');
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'report-identity',
      steps: [{
        ...producer,
        output_contracts: {
          report: [
            ...producer.output_contracts.report,
            { name: 'review.md', format: 'markdown' },
          ],
        },
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['steps', 0, 'output_contracts', 'report', 1, 'name'],
          message: expect.stringContaining('collides with'),
        }),
      ]));
    }
  });

  it('同時実行可能な parallel sibling 間の同名 report を reject する', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'report-identity',
      steps: [{
        name: 'parallel',
        parallel: [
          reportProducer('first', 'review.md'),
          reportProducer('second', 'review.md'),
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('parallel block と外側の逐次 step 間では同一 report の継続更新を許可する', () => {
    expect(WorkflowConfigRawSchema.safeParse({
      name: 'report-identity',
      steps: [
        reportProducer('before', 'review.md'),
        {
          name: 'parallel',
          parallel: [reportProducer('nested', 'review.md')],
        },
        reportProducer('after', 'review.md'),
      ],
    }).success).toBe(true);
  });

  it('return と next の同時指定を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'shared/review-loop',
        subworkflow: {
          callable: true,
          returns: ['ok'],
        },
        initial_step: 'review',
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the child workflow',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
                return: 'ok',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/return/i);
  });

  it('callable subworkflow 外の return を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'review',
        max_steps: 3,
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the parent workflow',
            rules: [
              {
                condition: 'done',
                return: 'ok',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/return/i);
  });

  it('callable subworkflow で未宣言の return を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'shared/review-loop',
        subworkflow: {
          callable: true,
          returns: ['ok'],
        },
        initial_step: 'review',
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review child workflow',
            rules: [
              {
                condition: 'done',
                return: 'retry_plan',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/undeclared value/i);
  });

  it.each(['COMPLETE', 'ABORT'])('callable subworkflow で予約語 return %s を reject する', (reservedResult) => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'shared/review-loop',
        subworkflow: {
          callable: true,
          returns: ['ok'],
        },
        initial_step: 'review',
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review child workflow',
            rules: [
              {
                condition: 'done',
                return: reservedResult,
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/reserved value/i);
  });

  it.each([
    {
      label: 'ai() condition',
      rule: {
        condition: 'ai("route to plan")',
        next: 'plan',
      },
    },
  ])('workflow 全体の正規化で不正な workflow_call $label を reject する', ({ rule }) => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            rules: [rule],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it.each(['agent', 'system'] as const)('%s step で call を reject する', (kind) => {
    const baseStep = kind === 'agent'
      ? {
          name: 'implement',
          kind,
          persona: 'coder',
          instruction: 'Implement the task',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        }
      : {
          name: 'route_context',
          kind,
          rules: [
            {
              condition: 'when(true)',
              next: 'COMPLETE',
            },
          ],
        };
    const result = WorkflowStepRawSchema.safeParse({
      ...baseStep,
      call: 'takt/review-loop',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['call'],
      }));
    }
  });

  it('workflow_call step は step-local execution fields を internal model に積まない', () => {
    const normalized = normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        workflow_config: {
          provider: 'codex',
          model: 'gpt-5-codex',
          provider_options: {
            codex: {
              network_access: true,
            },
          },
        },
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    const delegate = normalized.steps[0] as Record<string, unknown>;

    expect('delayBeforeMs' in delegate).toBe(false);
    expect('passPreviousResponse' in delegate).toBe(false);
    expect('provider' in delegate).toBe(false);
    expect('model' in delegate).toBe(false);
    expect('providerOptions' in delegate).toBe(false);
  });

  it('agent step で overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement the task',
      overrides: {
        provider: 'codex',
      },
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'overrides')).toBe(true);
    }
  });

  it('workflow_call step で空の overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {},
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.message.includes('workflow_call overrides require at least one of'),
      )).toBe(true);
    }
  });

  it('workflow_call step で未知キーを含む overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {
        provider: 'codex',
        foo: 'bar',
      },
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.code === 'unrecognized_keys'
        && issue.path[0] === 'overrides',
      )).toBe(true);
    }
  });

  it('call を持つ step を workflow_call として正規化する', () => {
    const normalized = normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            instruction: 'Plan the task',
            rules: [
              {
                condition: 'done',
                next: 'delegate',
              },
            ],
          },
          {
            name: 'delegate',
            call: 'takt/review-loop',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
          {
            name: 'route_context',
            mode: 'system',
            rules: [
              {
                condition: 'when(true)',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    const plan = normalized.steps[0] as Record<string, unknown>;
    const delegate = normalized.steps[1] as Record<string, unknown>;
    const routeContext = normalized.steps[2] as Record<string, unknown>;

    expect(plan.kind).toBe('agent');
    expect(delegate.kind).toBe('workflow_call');
    expect(delegate.call).toBe('takt/review-loop');
    expect(routeContext.kind).toBe('system');
    expect('provider' in delegate).toBe(false);
    expect('persona' in routeContext).toBe(false);
  });

  it('mode: agent を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      mode: 'agent',
      persona: 'coder',
      instruction: 'Implement the task',
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'mode')).toBe(true);
    }
  });

  it('kind と mode の併存を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      kind: 'system',
      mode: 'system',
      rules: [
        {
          condition: 'when(true)',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['kind'],
        message: 'Step kind must be expressed with either "kind" or "mode", not both',
      }));
    }
  });

  it('callable subworkflow で workflow-level provider 設定を保持する', () => {
    const workflow = normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          provider: 'codex',
          model: 'gpt-5-codex',
          provider_options: {
            codex: {
              network_access: true,
            },
          },
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    expect(workflow.provider).toBe('codex');
    expect(workflow.model).toBe('gpt-5-codex');
    expect(workflow.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('callable subworkflow で workflow-level runtime を保持する', () => {
    const workflow = normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          runtime: {
            prepare: ['node'],
          },
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    expect(workflow.runtime).toEqual({
      prepare: ['node'],
    });
  });

  it('callable subworkflow で step-level provider 設定と overrides を保持する', () => {
    const workflow = normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            provider: 'codex',
            model: 'gpt-5-codex',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'delegate',
              },
            ],
          },
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            overrides: {
              provider: 'codex',
              model: 'gpt-5-codex',
              provider_options: {
                codex: {
                  network_access: true,
                },
              },
            },
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    expect(workflow.steps[0]).toMatchObject({
      name: 'review',
      provider: 'codex',
      model: 'gpt-5-codex',
      providerOptions: {
        codex: {
          networkAccess: true,
        },
      },
    });
    expect(workflow.steps[1]).toMatchObject({
      name: 'delegate',
      overrides: {
        provider: 'codex',
        model: 'gpt-5-codex',
        providerOptions: {
          codex: {
            networkAccess: true,
          },
        },
      },
    });
  });

  it('callable subworkflow で parallel substep の return を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
          returns: ['ok'],
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            parallel: [
              {
                name: 'security',
                persona: 'security-reviewer',
                instruction: 'Security review',
                rules: [
                  {
                    condition: 'done',
                    return: 'ok',
                  },
                ],
              },
            ],
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/parallel sub-step rules do not allow/);
  });

  it('callable subworkflow で parallel substep と loop monitor judge の provider 設定を保持する', () => {
    const workflow = normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            parallel: [
              {
                name: 'security',
                persona: 'security-reviewer',
                provider: 'codex',
                model: 'gpt-5-codex',
                provider_options: {
                  codex: {
                    network_access: true,
                  },
                },
                instruction: 'Security review',
              },
            ],
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
        loop_monitors: [
          {
            cycle: ['review', 'review'],
            judge: {
              provider: {
                type: 'codex',
                network_access: true,
              },
              model: 'gpt-5-codex',
              rules: [
                {
                  condition: 'stop',
                  next: 'ABORT',
                },
              ],
            },
          },
        ],
      },
      process.cwd(),
    );

    expect(workflow.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'security',
      provider: 'codex',
      model: 'gpt-5-codex',
      providerOptions: {
        codex: {
          networkAccess: true,
        },
      },
    });
    expect(workflow.loopMonitors?.[0]?.judge).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-codex',
      providerOptions: {
        codex: {
          networkAccess: true,
        },
      },
    });
  });
});
