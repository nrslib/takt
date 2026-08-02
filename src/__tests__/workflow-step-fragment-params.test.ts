import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  StepFragmentConfigurationError,
} from '../infra/config/loaders/workflowStepFragmentReader.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import {
  captureConfigError,
  isolateStepFragmentTestConfig,
  writeStepFragmentTestFile as write,
} from './helpers/step-fragment-test-helpers.js';

const RULES = [{ condition: 'done', next: 'COMPLETE' }];

function caller(
  uses: string,
  withValues: Record<string, unknown>,
  overlay: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'run',
    uses,
    with: withValues,
    rules: RULES,
    ...overlay,
  };
}

describe('workflow step fragment facet params', () => {
  let projectDir: string;
  let stepsDir: string;
  let workflowPath: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    restoreConfig = isolateStepFragmentTestConfig('takt-step-fragment-params-config-');
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-params-'));
    stepsDir = join(projectDir, '.takt/steps');
    workflowPath = join(projectDir, '.takt/workflows/default.yaml');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    restoreConfig();
  });

  function resolve(raw: Record<string, unknown>): ReturnType<typeof resolveWorkflowStepFragments> {
    return resolveWorkflowStepFragments(raw, {
      candidateDirs: [stepsDir],
      context: {
        lang: 'en',
        projectDir,
        repertoireDir: join(projectDir, 'repertoire'),
        workflowDir: dirname(workflowPath),
      },
      workflowPath,
    });
  }

  it('binds all supported facet kinds into their typed fields', () => {
    write(projectDir, '.takt/steps/typed.yaml', `params:
  policies:
    type: facet_ref[]
    facet_kind: policy
  knowledge:
    type: facet_ref[]
    facet_kind: knowledge
  persona:
    type: facet_ref
    facet_kind: persona
  instruction:
    type: facet_ref
    facet_kind: instruction
  report:
    type: facet_ref
    facet_kind: report_format
policy:
  $param: policies
knowledge:
  $param: knowledge
persona:
  $param: persona
instruction:
  $param: instruction
output_contracts:
  report:
    - name: result.md
      format:
        $param: report
`);

    const result = resolve({
      steps: [caller('typed', {
        policies: ['strict'],
        knowledge: ['architecture'],
        persona: 'reviewer',
        instruction: 'implement',
        report: 'implementation',
      })],
    });

    expect(result.raw).toMatchObject({
      steps: [{
        policy: ['strict'],
        knowledge: ['architecture'],
        persona: 'reviewer',
        instruction: 'implement',
        output_contracts: {
          report: [{ name: 'result.md', format: 'implementation' }],
        },
      }],
    });
    expect(result.raw).not.toHaveProperty('steps.0.params');
    expect(result.raw).not.toHaveProperty('steps.0.with');
    expect(result.provenance).not.toContainEqual(expect.objectContaining({
      stepPath: ['steps', 0, 'instruction'],
    }));
  });

  it('binds params recursively in parallel children', () => {
    write(projectDir, '.takt/steps/parallel.yaml', `params:
  child_knowledge:
    type: facet_ref[]
    facet_kind: knowledge
parallel:
  - name: review
    instruction: review
    knowledge:
      $param: child_knowledge
`);

    const result = resolve({
      steps: [{
        ...caller('parallel', { child_knowledge: ['reviewing'] }),
        rules: {
          self: RULES,
          parallel: { review: [{ condition: 'done' }] },
        },
      }],
    });

    expect(result.raw).toHaveProperty('steps.0.parallel.0.knowledge', ['reviewing']);
  });

  it('splices empty and populated facet_ref arrays into mixed facet lists', () => {
    write(projectDir, '.takt/steps/composed.yaml', `params:
  policy_additions:
    type: facet_ref[]
    facet_kind: policy
  knowledge_additions:
    type: facet_ref[]
    facet_kind: knowledge
policy:
  - base-policy
  - $param: policy_additions
  - final-policy
knowledge:
  - base-knowledge
  - $param: knowledge_additions
  - final-knowledge
`);

    const result = resolve({
      steps: [caller('composed', {
        policy_additions: [],
        knowledge_additions: ['domain-a', 'domain-b'],
      })],
    });

    expect(result.raw).toHaveProperty('steps.0.policy', ['base-policy', 'final-policy']);
    expect(result.raw).toHaveProperty(
      'steps.0.knowledge',
      ['base-knowledge', 'domain-a', 'domain-b', 'final-knowledge'],
    );
  });

  it('passes a bound value through an explicitly mapped nested fragment scope', () => {
    write(projectDir, '.takt/steps/inner.yaml', `params:
  inner_instruction:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: inner_instruction
`);
    write(projectDir, '.takt/steps/outer.yaml', `params:
  outer_instruction:
    type: facet_ref
    facet_kind: instruction
uses: inner
with:
  inner_instruction:
    $param: outer_instruction
`);

    const result = resolve({
      steps: [caller('outer', { outer_instruction: 'review' })],
    });

    expect(result.raw).toHaveProperty('steps.0.instruction', 'review');
    expect(result.raw).not.toHaveProperty('steps.0.with');
  });

  it('rejects a nested pass-through when the outer and child facet kinds differ', () => {
    write(projectDir, '.takt/steps/inner.yaml', `params:
  child_policy:
    type: facet_ref
    facet_kind: policy
policy:
  $param: child_policy
`);
    const outerPath = write(projectDir, '.takt/steps/outer.yaml', `params:
  outer_instruction:
    type: facet_ref
    facet_kind: instruction
uses: inner
with:
  child_policy:
    $param: outer_instruction
`);

    const error = captureConfigError(() => resolve({
      steps: [caller('outer', { outer_instruction: 'review' })],
    })) as StepFragmentConfigurationError;

    expect(error).toBeInstanceOf(StepFragmentConfigurationError);
    expect(error.sourcePath).toBe(outerPath);
    expect(error.path).toEqual(['with', 'child_policy']);
  });

  it.each([
    {
      name: 'unknown',
      inner: 'instruction: review\n',
      outerWith: 'with:\n  unknown: review\n',
      path: ['with', 'unknown'],
    },
    {
      name: 'missing',
      inner: `params:
  required:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: required
`,
      outerWith: '',
      path: ['with', 'required'],
    },
  ])('attributes a nested $name binding error to the outer fragment caller', ({
    inner,
    outerWith,
    path,
  }) => {
    write(projectDir, '.takt/steps/inner.yaml', inner);
    const outerPath = write(
      projectDir,
      '.takt/steps/outer.yaml',
      `uses: inner\n${outerWith}`,
    );

    const error = captureConfigError(() => resolve({
      steps: [caller('outer', {})],
    })) as StepFragmentConfigurationError;

    expect(error).toBeInstanceOf(StepFragmentConfigurationError);
    expect(error.sourcePath).toBe(outerPath);
    expect(error.path).toEqual(path);
  });

  it('retains an explicitly passed callable param for the callable resolver', () => {
    write(projectDir, '.takt/steps/typed.yaml', `params:
  fragment_instruction:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: fragment_instruction
`);

    const result = resolve({
      subworkflow: {
        callable: true,
        params: {
          callable_instruction: {
            type: 'facet_ref',
            facet_kind: 'instruction',
          },
        },
      },
      steps: [caller('typed', {
        fragment_instruction: { $param: 'callable_instruction' },
      })],
    });

    expect(result.raw).toHaveProperty('steps.0.instruction', { $param: 'callable_instruction' });
  });

  it('resolves a callable workflow param passed explicitly into a fragment', () => {
    write(projectDir, '.takt/facets/instructions/supplied.md', 'supplied instruction');
    write(projectDir, '.takt/steps/typed.yaml', `params:
  fragment_instruction:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: fragment_instruction
`);
    const path = write(projectDir, '.takt/workflows/callable.yaml', `name: callable
initial_step: run
subworkflow:
  callable: true
  params:
    callable_instruction:
      type: facet_ref
      facet_kind: instruction
instructions:
  supplied: ../facets/instructions/supplied.md
steps:
  - name: run
    uses: typed
    with:
      fragment_instruction:
        $param: callable_instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    const loaded = loadWorkflowFromFile(path, projectDir, {
      callableArgs: { callable_instruction: 'supplied' },
    });

    expect(loaded.steps[0]).toMatchObject({
      instruction: 'supplied instruction',
      rules: [{ next: 'COMPLETE' }],
    });
  });

  it('preserves workflow_call args while consuming fragment with bindings', () => {
    write(projectDir, '.takt/steps/delegate.yaml', `kind: workflow_call
call: child
args:
  instruction: review
`);

    const result = resolve({
      steps: [caller('delegate', {})],
    });

    expect(result.raw).toHaveProperty('steps.0.args', {
      instruction: 'review',
    });
    expect(result.raw).not.toHaveProperty('steps.0.with');
  });

  it('binds typed fragment params into workflow_call args', () => {
    write(projectDir, '.takt/steps/delegate.yaml', `params:
  child_knowledge:
    type: facet_ref[]
    facet_kind: knowledge
kind: workflow_call
call: child
args:
  knowledge:
    $param: child_knowledge
`);

    const result = resolve({
      steps: [caller('delegate', { child_knowledge: ['architecture'] })],
    });

    expect(result.raw).toHaveProperty('steps.0.args', {
      knowledge: ['architecture'],
    });
  });

  it('resolves a callable param passed through a fragment workflow_call arg', () => {
    write(projectDir, '.takt/facets/knowledge/domain.md', 'domain knowledge');
    write(projectDir, '.takt/steps/delegate.yaml', `params:
  child_knowledge:
    type: facet_ref[]
    facet_kind: knowledge
kind: workflow_call
call: child
args:
  knowledge:
    $param: child_knowledge
`);
    const path = write(projectDir, '.takt/workflows/callable.yaml', `name: callable
initial_step: delegate
subworkflow:
  callable: true
  params:
    workflow_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
knowledge:
  domain: ../facets/knowledge/domain.md
steps:
  - name: delegate
    uses: delegate
    with:
      child_knowledge:
        $param: workflow_knowledge
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const loaded = loadWorkflowFromFile(path, projectDir, {
      callableArgs: { workflow_knowledge: ['domain'] },
    });

    expect(loaded.steps[0]).toMatchObject({
      kind: 'workflow_call',
      args: { knowledge: ['domain'] },
    });
  });

  it('passes a callable workflow_ref param through a fragment call field', () => {
    write(projectDir, '.takt/steps/delegate.yaml', `params:
  target:
    type: workflow_ref
kind: workflow_call
call:
  $param: target
`);
    const path = write(projectDir, '.takt/workflows/callable.yaml', `name: callable
initial_step: delegate
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
steps:
  - name: delegate
    uses: delegate
    with:
      target:
        $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const loaded = loadWorkflowFromFile(path, projectDir, {
      callableArgs: { target: 'implementation' },
    });

    expect(loaded.steps[0]).toMatchObject({
      kind: 'workflow_call',
      call: 'implementation',
    });
  });

  it('applies caller overlay after param expansion', () => {
    write(projectDir, '.takt/steps/typed.yaml', `params:
  fragment_instruction:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: fragment_instruction
`);

    const result = resolve({
      steps: [caller('typed', { fragment_instruction: 'fragment' }, { instruction: 'caller' })],
    });

    expect(result.raw).toHaveProperty('steps.0.instruction', 'caller');
  });

  it.each([
    {
      name: 'unknown binding',
      fragment: 'instruction: review\n',
      step: caller('invalid', { unknown: 'review' }),
      path: ['steps', 0, 'with', 'unknown'],
      source: 'caller',
    },
    {
      name: 'missing binding',
      fragment: 'params:\n  required:\n    type: facet_ref\n    facet_kind: instruction\ninstruction:\n  $param: required\n',
      step: caller('invalid', {}),
      path: ['steps', 0, 'with', 'required'],
      source: 'caller',
    },
    {
      name: 'cardinality mismatch',
      fragment: 'params:\n  required:\n    type: facet_ref[]\n    facet_kind: knowledge\nknowledge:\n  $param: required\n',
      step: caller('invalid', { required: 'knowledge' }),
      path: ['steps', 0, 'with', 'required'],
      source: 'caller',
    },
    {
      name: 'kind mismatch',
      fragment: 'params:\n  wrong:\n    type: facet_ref\n    facet_kind: instruction\npolicy:\n  $param: wrong\n',
      step: caller('invalid', { wrong: 'strict' }),
      path: ['policy'],
      source: 'fragment',
    },
    {
      name: 'undeclared reference',
      fragment: 'instruction:\n  $param: missing\n',
      step: caller('invalid', {}),
      path: ['instruction'],
      source: 'fragment',
    },
    {
      name: 'unsupported field',
      fragment: 'params:\n  forbidden:\n    type: facet_ref\n    facet_kind: instruction\nmodel:\n  $param: forbidden\n',
      step: caller('invalid', { forbidden: 'model' }),
      path: ['model'],
      source: 'fragment',
    },
    {
      name: 'nested workflow_call arg reference',
      fragment: 'params:\n  forbidden:\n    type: facet_ref\n    facet_kind: instruction\nkind: workflow_call\ncall: child\nargs:\n  nested:\n    value:\n      $param: forbidden\n',
      step: caller('invalid', { forbidden: 'review' }),
      path: ['args', 'nested', 'value'],
      source: 'fragment',
    },
    {
      name: 'non-object caller bindings',
      fragment: 'instruction: review\n',
      step: caller('invalid', {}, { with: 'review' }),
      path: ['steps', 0, 'with'],
      source: 'caller',
    },
    {
      name: 'non-object fragment params',
      fragment: 'params: invalid\ninstruction: review\n',
      step: caller('invalid', {}),
      path: ['params'],
      source: 'fragment',
    },
    {
      name: 'params on a parallel child',
      fragment: 'parallel:\n  - name: review\n    params: []\n    instruction: review\n',
      step: caller('invalid', {}),
      path: ['parallel', 0, 'params'],
      source: 'fragment',
    },
  ])('rejects $name with a structured source path', ({ fragment, step, path, source }) => {
    const fragmentPath = write(projectDir, '.takt/steps/invalid.yaml', fragment);

    let thrown: unknown;
    try {
      resolve({ steps: [step] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StepFragmentConfigurationError);
    const configurationError = thrown as StepFragmentConfigurationError;
    expect(configurationError.path).toEqual(path);
    expect(configurationError.sourcePath).toBe(source === 'caller' ? workflowPath : fragmentPath);
  });

  it('rejects parameter references below a non-array output_contracts.report', () => {
    const fragmentPath = write(projectDir, '.takt/steps/invalid-report.yaml', `params:
  report:
    type: facet_ref
    facet_kind: report_format
output_contracts:
  report:
    format:
      $param: report
`);

    const error = captureConfigError(() => resolve({
      steps: [caller('invalid-report', { report: 'implementation' })],
    })) as StepFragmentConfigurationError;

    expect(error).toBeInstanceOf(StepFragmentConfigurationError);
    expect(error.path).toEqual(['output_contracts', 'report', 'format']);
    expect(error.sourcePath).toBe(fragmentPath);
  });

  it('keeps rules owned by the concrete caller', () => {
    write(projectDir, '.takt/steps/typed.yaml', `params:
  instruction:
    type: facet_ref
    facet_kind: instruction
instruction:
  $param: instruction
`);

    const result = resolve({
      steps: [caller('typed', { instruction: 'review' })],
    });

    expect(result.raw).toHaveProperty('steps.0.rules', RULES);
  });
});
