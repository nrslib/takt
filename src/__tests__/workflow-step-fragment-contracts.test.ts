import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from '../infra/config/loaders/workflowFileLoader.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { previewPrompts } from '../features/prompt/preview.js';
import { WorkflowEngine } from '../core/workflow/index.js';

const NL = String.fromCharCode(10);

function yaml(...lines: string[]): string {
  return lines.join(NL) + NL;
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeWorkflow(root: string, name: string, steps: string, initialStep: string): string {
  return writeFile(root, '.takt/workflows/' + name + '.yaml', yaml(
    'name: ' + name,
    'initial_step: ' + initialStep,
    'max_steps: 3',
    'steps:',
    steps,
  ));
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

function expectFragmentProvenance(
  message: string,
  workflowPath: string,
  ref: string,
  fragmentPath: string,
  origin: 'fragment' | 'workflow',
): void {
  expect(message).toContain(workflowPath);
  expect(message).toContain(origin === 'fragment'
    ? 'from step fragment "' + ref + '"'
    : 'step uses fragment "' + ref + '"');
  expect(message).toContain(fragmentPath);
}

describe('workflow step fragment contracts', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-contract-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-contract-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('rejects a nested repertoire workflow_call inherited by a project workflow', () => {
    const innerPath = writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: "@owner/package/delegate"\n');
    const workflowPath = writeWorkflow(projectDir, 'nested-low-trust-call', '  - uses: outer', 'outer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain('delegate');
    expect(message).toContain(innerPath);
  });

  it('rejects a repertoire workflow_call nested in a parallel fragment', () => {
    const innerPath = writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    writeFile(projectDir, '.takt/steps/reviewers.yaml', yaml(
      'parallel:',
      '  - uses: "@owner/package/delegate"',
      'rules:',
      '  - condition: all("COMPLETE")',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parallel-low-trust-call', '  - uses: reviewers', 'reviewers');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain(innerPath);
  });

  it('rejects a low-trust workflow_call when the caller repeats its kind', () => {
    const fragmentPath = writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'kind-override-trust', yaml(
      '  - uses: "@owner/package/delegate"',
      '    kind: workflow_call',
    ).trimEnd(), 'delegate');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step fragment "@owner/package/delegate"');
    expect(message).toContain(fragmentPath);
  });

  it.each([
    ['top-level', '  - uses: "@owner/package/delegate"'],
    ['parallel', '  - name: parent\n    instruction: work\n    parallel:\n      - uses: "@owner/package/delegate"\n    rules:\n      - condition: all("done")\n        next: COMPLETE'],
  ])('rejects a low-trust call-only fragment in a %s step', (_placement, steps) => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'call: privileged-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'call-only-trust', steps, 'parent');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow('crosses the workflow trust boundary');
  });

  it('retains expanded parallel sub-steps from a nested fragment', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'name: review',
      'instruction: review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    writeFile(projectDir, '.takt/steps/base.yaml', yaml(
      'parallel:',
      '  - uses: reviewer',
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: base\n');
    const workflowPath = writeWorkflow(projectDir, 'nested-parallel', '  - uses: outer', 'outer');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'review', instruction: 'review' }]);
  });

  it('replaces a fragment parallel array before expanding its sub-step uses', () => {
    writeFile(projectDir, '.takt/steps/base.yaml', yaml(
      'parallel:',
      '  - uses: missing-reviewer',
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parallel-override-order', yaml(
      '  - uses: base',
      '    parallel:',
      '      - name: reviewer',
      '        instruction: review',
      '        rules:',
      '          - condition: done',
      '            next: COMPLETE',
    ).trimEnd(), 'base');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'reviewer', instruction: 'review' }]);
  });

  it('adds fragment context when a resolved fragment cannot be read', () => {
    mkdirSync(join(projectDir, '.takt/steps/unreadable.yaml'), { recursive: true });
    const workflowPath = writeWorkflow(projectDir, 'unreadable-fragment', '  - uses: unreadable', 'unreadable');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(workflowPath);
    expect(message).toContain('step fragment "unreadable"');
    expect(message).toContain('.takt/steps/unreadable.yaml');
  });

  it('uses loader-resolved worktree trust when validating fragment workflow calls', () => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'worktree-trust', '  - uses: "@owner/package/delegate"', 'delegate');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir, {
      trustInfo: {
        source: 'worktree',
        sourcePath: workflowPath,
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      },
    })).not.toThrow();
  });

  it('rejects circular YAML aliases in a fragment as a configuration error', () => {
    writeFile(projectDir, '.takt/steps/cyclic.yaml', yaml(
      'instruction: &instruction',
      '  nested: *instruction',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'cyclic-yaml', '  - uses: cyclic', 'cyclic');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular YAML structure');
    expect(message).toContain(workflowPath);
    expect(message).toContain('.takt/steps/cyclic.yaml');
  });

  it('allows a caller to replace a workflow_call inherited by a low-trust nested fragment', () => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: "@owner/package/delegate"\n');
    const workflowPath = writeWorkflow(projectDir, 'caller-call-override', [
      '  - uses: outer',
      '    call: safe-child',
    ].join(NL), 'outer');

    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]).toMatchObject({
      kind: 'workflow_call',
      call: 'safe-child',
    });
  });

  it.each(['uses: 0', 'uses: ""', 'uses: " "'])(
    'rejects invalid uses values before schema validation: %s',
    (uses) => {
      const workflowPath = writeWorkflow(projectDir, 'invalid-uses', '  - ' + uses, 'invalid');

      const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

      expect(message).toContain(workflowPath);
      expect(message).toContain('step fragment uses must be a non-empty string');
    },
  );

  it.each([
    ['empty document', '', 'must contain one step object'],
    ['malformed document', 'instruction: [', 'failed to parse step fragment'],
    ['ordered mapping', '!!omap\n- instruction: work', 'must contain one step object'],
  ])('rejects a %s step fragment', (_label, fragment, expectedMessage) => {
    writeFile(projectDir, '.takt/steps/invalid-fragment.yaml', fragment);
    const workflowPath = writeWorkflow(projectDir, 'invalid-fragment', '  - uses: invalid-fragment', 'invalid-fragment');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(expectedMessage);
    expect(message).toContain(workflowPath);
    expect(message).toContain('.takt/steps/invalid-fragment.yaml');
  });

  it('rejects duplicate names created by parallel fragment expansion', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'duplicate-parallel-fragment', yaml(
      '  - name: reviewers',
      '    parallel:',
      '      - uses: reviewer',
      '      - uses: reviewer',
      '    rules:',
      '      - condition: all("done")',
      '        next: COMPLETE',
    ).trimEnd(), 'reviewers');

    expect(() => new WorkflowEngine(loadWorkflowFromFile(workflowPath, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    })).toThrow('parallel step "reviewers" contains duplicate sub-step name "reviewer"');
  });

  it('adds fragment provenance to callable argument expansion errors', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/parameterized.yaml', yaml(
      'instruction:',
      '  $param: required_instruction',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parameterized.yaml', yaml(
      'name: parameterized',
      'subworkflow:',
      '  callable: true',
      '  params:',
      '    required_instruction:',
      '      type: facet_ref',
      '      facet_kind: instruction',
      'initial_step: parameterized',
      'max_steps: 1',
      'steps:',
      '  - uses: parameterized',
    ));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('requires workflow_call arg "required_instruction"');
    expectFragmentProvenance(message, workflowPath, 'parameterized', fragmentPath, 'fragment');
  });

  it('adds fragment provenance to non-callable param validation errors', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/parameterized.yaml', yaml(
      'instruction:',
      '  $param: required_instruction',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'non-callable-parameterized', '  - uses: parameterized', 'parameterized');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('cannot use $param in instruction outside a callable subworkflow');
    expectFragmentProvenance(message, workflowPath, 'parameterized', fragmentPath, 'fragment');
  });

  it('retains fragment context while identifying an inline field override as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'persona: reviewer',
      'instruction: review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-persona-override', yaml(
      '  - uses: reviewer',
      '    persona: ""',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('empty persona value');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it('retains fragment context while identifying an inline provider_options override as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
      'provider_options:',
      '  extends: default-options',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-provider-options-override', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      extends: missing-options',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it('retains fragment context for a sibling provider_options override defined by the workflow', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
      'provider_options:',
      '  codex:',
      '    reasoning_effort: low',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-provider-options-sibling-override', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      extends: missing-options',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it('attributes an inherited provider_options.extends error after a partial inline override', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
      'provider_options:',
      '  extends: missing-options',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'fragment-provider-options-extends', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      codex:',
      '        reasoning_effort: low',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'fragment');
  });

  it('retains fragment context while identifying an inline quality gate override as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-quality-gates-override', yaml(
      '  - uses: reviewer',
      '    quality_gates:',
      '      - type: command',
      '        name: check',
      '        command: ./check.sh',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses command quality gate "./check.sh"');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it('retains fragment context while identifying an inline workflow_call override as workflow-defined', () => {
    writeFile(projectDir, '.takt/workflows/requires-contract.yaml', yaml(
      'name: requires-contract',
      'subworkflow:',
      '  callable: true',
      '  requires_finding_contract: true',
      'initial_step: child',
      'max_steps: 1',
      'steps:',
      '  - name: child',
      '    instruction: child',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ));
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: safe-child',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-call-override', yaml(
      '  - uses: delegate',
      '    call: requires-contract',
    ).trimEnd(), 'delegate');

    const message = errorMessage(() => loadWorkflowByIdentifier('inline-call-override', projectDir));

    expect(message).toContain('requires a finding_contract inherited from its caller');
    expectFragmentProvenance(message, workflowPath, 'delegate', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it('adds fragment provenance to workflow_call return contract errors', () => {
    writeFile(projectDir, '.takt/workflows/child.yaml', yaml(
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns: [done]',
      'initial_step: child',
      'max_steps: 1',
      'steps:',
      '  - name: child',
      '    instruction: child',
      '    rules:',
      '      - condition: done',
      '        return: done',
    ));
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: child',
      'rules:',
      '  - condition: retry',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parent', '  - uses: delegate', 'delegate');

    const message = errorMessage(() => loadWorkflowByIdentifier('parent', projectDir));

    expect(message).toContain('cannot route on unsupported child result "retry"');
    expectFragmentProvenance(message, workflowPath, 'delegate', fragmentPath, 'fragment');
  });

  it('adds fragment provenance to findings rule contract errors', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/findings-rule.yaml', yaml(
      'instruction: review',
      'rules:',
      '  - condition: when(findings.open.count == 0)',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'findings-rule', '  - uses: findings-rule', 'findings-rule');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses findings.* rule but finding_contract is not configured');
    expectFragmentProvenance(message, workflowPath, 'findings-rule', fragmentPath, 'fragment');
  });

  it('adds fragment provenance to parallel doctor diagnostics without parsing the step name', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewers.yaml', yaml(
      'parallel:',
      '  - name: parallel-ref',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        next: nowhere',
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parallel-doctor', '  - uses: reviewers', 'reviewers');
    const message = inspectWorkflowFile(workflowPath, projectDir).diagnostics
      .map((diagnostic) => diagnostic.message)
      .find((diagnostic) => diagnostic.includes('unknown next step "nowhere"'));

    expect(message).toBeDefined();
    expectFragmentProvenance(message!, workflowPath, 'reviewers', fragmentPath, 'fragment');
  });

  it.each([
    ['provider option resolution', 'invalid-provider-options', yaml(
      'instruction: work',
      'provider_options:',
      '  extends: missing-options',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ), 'provider_options.extends not found: missing-options'],
    ['command gate validation', 'command-gate', yaml(
      'instruction: work',
      'quality_gates:',
      '  - type: command',
      '    name: check',
      '    command: ./check.sh',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ), 'uses command quality gate "./check.sh"'],
  ])('adds fragment provenance to %s errors', (_label, ref, fragment, expectedError) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/' + ref + '.yaml', fragment);
    const workflowPath = writeWorkflow(projectDir, ref, '  - uses: ' + ref, ref);

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(expectedError);
    expectFragmentProvenance(message, workflowPath, ref, fragmentPath, 'fragment');
  });

  it('does not attribute an inline command gate error to an unrelated fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/safe.yaml', yaml(
      'instruction: safe',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-command-gate', yaml(
      '  - uses: safe',
      '  - name: inline-gate',
      '    instruction: gated',
      '    quality_gates:',
      '      - type: command',
      '        name: check',
      '        command: ./check.sh',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'safe');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses command quality gate "./check.sh"');
    expect(message).not.toContain('from step fragment "safe"');
    expect(message).not.toContain(fragmentPath);
  });

  it.each([
    ['reference', 'missing-persona', yaml(
      'persona: absent-persona',
      'instruction: work',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ), 'absent-persona'],
    ['graph', 'invalid-route', yaml(
      'instruction: work',
      'rules:',
      '  - condition: done',
      '    next: nowhere',
    ), 'unknown next step "nowhere"'],
  ])('adds fragment provenance to doctor %s diagnostics', (_label, ref, fragment, expectedMessage) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/' + ref + '.yaml', fragment);
    const workflowPath = writeWorkflow(projectDir, 'doctor-' + ref, '  - uses: ' + ref, ref);
    const message = inspectWorkflowFile(workflowPath, projectDir).diagnostics
      .map((diagnostic) => diagnostic.message)
      .find((diagnostic) => diagnostic.includes(expectedMessage));

    expect(message).toBeDefined();
    expectFragmentProvenance(message!, workflowPath, ref, fragmentPath, 'fragment');
  });

  it('does not attribute an inline doctor graph error to an unrelated fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/safe.yaml', yaml(
      'instruction: safe',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-doctor-route', yaml(
      '  - uses: safe',
      '  - name: inline-route',
      '    instruction: route',
      '    rules:',
      '      - condition: done',
      '        next: nowhere',
    ).trimEnd(), 'safe');
    const message = inspectWorkflowFile(workflowPath, projectDir).diagnostics
      .map((diagnostic) => diagnostic.message)
      .find((diagnostic) => diagnostic.includes('unknown next step "nowhere"'));

    expect(message).toBeDefined();
    expect(message).not.toContain('from step fragment "safe"');
    expect(message).not.toContain(fragmentPath);
  });

  it('uses the same expanded step through runtime, discovery, and prompt preview loaders', async () => {
    writeFile(projectDir, '.takt/steps/preview-step.yaml', yaml(
      'instruction: fragment instruction',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
    ));
    const workflowPath = writeWorkflow(projectDir, 'fragment-preview', '  - uses: preview-step', 'preview-step');
    const runtime = loadWorkflowFromFile(workflowPath, projectDir);
    const discovery = loadWorkflowFromFileForDiscovery(workflowPath, projectDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await previewPrompts(projectDir, 'fragment-preview');
      const output = log.mock.calls.flat().join(NL);
      expect(output).toContain('preview-step');
      expect(output).toContain('fragment instruction');
    } finally {
      log.mockRestore();
    }

    expect(discovery.steps).toEqual(runtime.steps);
  });
});
