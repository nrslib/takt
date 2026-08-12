import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from '../infra/config/loaders/workflowFileLoader.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { StepFragmentConfigurationError } from '../infra/config/loaders/workflowStepFragmentReader.js';
import { captureConfigError } from './helpers/step-fragment-test-helpers.js';
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
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: "@owner/package/delegate"\n');
    const workflowPath = writeWorkflow(projectDir, 'nested-low-trust-call', yaml(
      '  - uses: outer',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ).trimEnd(), 'outer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain('delegate');
    expect(message).toContain(innerPath);
  });

  it('rejects a repertoire workflow_call nested in a parallel fragment', () => {
    const innerPath = writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
    ));
    writeFile(projectDir, '.takt/steps/reviewers.yaml', yaml(
      'parallel:',
      '  - uses: "@owner/package/delegate"',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parallel-low-trust-call', yaml(
      '  - uses: reviewers',
      '    rules:',
      '      self:',
      '        - condition: all("COMPLETE")',
      '          next: COMPLETE',
      '      parallel:',
      '        delegate:',
      '          - condition: COMPLETE',
      '            next: COMPLETE',
    ).trimEnd(), 'reviewers');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain(innerPath);
  });

  it('rejects a low-trust workflow_call when the caller repeats its kind', () => {
    const fragmentPath = writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
    ));
    const workflowPath = writeWorkflow(projectDir, 'kind-override-trust', yaml(
      '  - uses: "@owner/package/delegate"',
      '    kind: workflow_call',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ).trimEnd(), 'delegate');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('crosses the workflow trust boundary');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step fragment "@owner/package/delegate"');
    expect(message).toContain(fragmentPath);
  });

  it.each([
    ['top-level', '  - name: parent\n    uses: "@owner/package/delegate"\n    rules:\n      - condition: COMPLETE\n        next: COMPLETE'],
    ['parallel', '  - name: parent\n    instruction: work\n    parallel:\n      - uses: "@owner/package/delegate"\n        rules:\n          - condition: COMPLETE\n            next: COMPLETE\n    rules:\n      - condition: all("done")\n        next: COMPLETE'],
  ])('rejects a low-trust call-only fragment in a %s step', (_placement, steps) => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'call: privileged-child',
    ));
    const workflowPath = writeWorkflow(projectDir, 'call-only-trust', steps, 'parent');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow('crosses the workflow trust boundary');
  });

  it('retains expanded parallel sub-steps from a nested fragment', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'name: review',
      'instruction: review',
    ));
    writeFile(projectDir, '.takt/steps/base.yaml', yaml(
      'parallel:',
      '  - uses: reviewer',
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: base\n');
    const workflowPath = writeWorkflow(projectDir, 'nested-parallel', yaml(
      '  - uses: outer',
      '    rules:',
      '      self:',
      '        - condition: all("done")',
      '          next: COMPLETE',
      '      parallel:',
      '        review:',
      '          - condition: done',
      '            next: COMPLETE',
    ).trimEnd(), 'outer');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'review', instruction: 'review' }]);
  });

  it('replaces a fragment parallel array before expanding its sub-step uses', () => {
    writeFile(projectDir, '.takt/steps/base.yaml', yaml(
      'parallel:',
      '  - uses: missing-reviewer',
    ));
    const workflowPath = writeWorkflow(projectDir, 'parallel-override-order', yaml(
      '  - uses: base',
      '    parallel:',
      '      - name: reviewer',
      '        instruction: review',
      '    rules:',
      '      self:',
      '        - condition: all("done")',
      '          next: COMPLETE',
      '      parallel:',
      '        reviewer:',
      '          - condition: done',
      '            next: COMPLETE',
    ).trimEnd(), 'base');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'reviewer', instruction: 'review' }]);
  });

  it('adds fragment context when a resolved fragment cannot be read', () => {
    mkdirSync(join(projectDir, '.takt/steps/unreadable.yaml'), { recursive: true });
    const workflowPath = writeWorkflow(projectDir, 'unreadable-fragment', yaml(
      '  - uses: unreadable',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'unreadable');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(workflowPath);
    expect(message).toContain('step fragment "unreadable"');
    expect(message).toContain('.takt/steps/unreadable.yaml');
  });

  it('uses loader-resolved worktree trust when validating fragment workflow calls', () => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: child',
    ));
    const workflowPath = writeWorkflow(projectDir, 'worktree-trust', yaml(
      '  - uses: "@owner/package/delegate"',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ).trimEnd(), 'delegate');

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
    ));
    const workflowPath = writeWorkflow(projectDir, 'cyclic-yaml', yaml(
      '  - uses: cyclic',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'cyclic');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular YAML structure');
    expect(message).toContain(workflowPath);
    expect(message).toContain('.takt/steps/cyclic.yaml');
  });

  it('allows a caller to replace a workflow_call inherited by a low-trust nested fragment', () => {
    writeFile(globalConfigDir, 'repertoire/@owner/package/steps/delegate.yaml', yaml(
      'kind: workflow_call',
      'call: privileged-child',
    ));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: "@owner/package/delegate"\n');
    const workflowPath = writeWorkflow(projectDir, 'caller-call-override', [
      '  - uses: outer',
      '    call: safe-child',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
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
    const workflowPath = writeWorkflow(projectDir, 'invalid-fragment', yaml(
      '  - uses: invalid-fragment',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'invalid-fragment');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(expectedMessage);
    expect(message).toContain(workflowPath);
    expect(message).toContain('.takt/steps/invalid-fragment.yaml');
  });

  it('rejects duplicate names created by parallel fragment expansion', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
    ));
    const workflowPath = writeWorkflow(projectDir, 'duplicate-parallel-fragment', yaml(
      '  - name: reviewers',
      '    parallel:',
      '      - uses: reviewer',
      '        rules:',
      '          - condition: done',
      '            next: COMPLETE',
      '      - uses: reviewer',
      '        rules:',
      '          - condition: done',
      '            next: COMPLETE',
      '    rules:',
      '      - condition: all("done")',
      '        next: COMPLETE',
    ).trimEnd(), 'reviewers');

    expect(() => new WorkflowEngine(loadWorkflowFromFile(workflowPath, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    })).toThrow('parallel step "reviewers" contains duplicate sub-step name "reviewer"');
  });

  it('retains fragment context while identifying an inline field override as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'persona: reviewer',
      'instruction: review',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-persona-override', yaml(
      '  - uses: reviewer',
      '    persona: ""',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
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
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-provider-options-override', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      extends: missing-options',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
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
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-provider-options-sibling-override', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      extends: missing-options',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
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
    ));
    const workflowPath = writeWorkflow(projectDir, 'fragment-provider-options-extends', yaml(
      '  - uses: reviewer',
      '    provider_options:',
      '      codex:',
      '        reasoning_effort: low',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'fragment');
  });

  it('retains fragment context while identifying an inline quality gate override as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', yaml(
      'instruction: review',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-quality-gates-override', yaml(
      '  - uses: reviewer',
      '    quality_gates:',
      '      - type: command',
      '        name: check',
      '        command: ./check.sh',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'reviewer');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses command quality gate "./check.sh"');
    expectFragmentProvenance(message, workflowPath, 'reviewer', fragmentPath, 'workflow');
    expect(message).toContain('defined by the workflow');
  });

  it.each([
    ['provider option resolution', 'invalid-provider-options', yaml(
      'instruction: work',
      'provider_options:',
      '  extends: missing-options',
    ), 'provider_options.extends not found: missing-options'],
    ['command gate validation', 'command-gate', yaml(
      'instruction: work',
      'quality_gates:',
      '  - type: command',
      '    name: check',
      '    command: ./check.sh',
    ), 'uses command quality gate "./check.sh"'],
  ])('adds fragment provenance to %s errors', (_label, ref, fragment, expectedError) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/' + ref + '.yaml', fragment);
    const workflowPath = writeWorkflow(projectDir, ref, yaml(
      '  - uses: ' + ref,
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), ref);

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(expectedError);
    expectFragmentProvenance(message, workflowPath, ref, fragmentPath, 'fragment');
  });

  it('does not attribute an inline command gate error to an unrelated fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/safe.yaml', yaml(
      'instruction: safe',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-command-gate', yaml(
      '  - uses: safe',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
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

  it('adds fragment provenance to doctor reference diagnostics', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/missing-persona.yaml', yaml(
      'persona: absent-persona',
      'instruction: work',
    ));
    const workflowPath = writeWorkflow(projectDir, 'doctor-missing-persona', yaml(
      '  - uses: missing-persona',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'missing-persona');
    const message = inspectWorkflowFile(workflowPath, projectDir).diagnostics
      .map((diagnostic) => diagnostic.message)
      .find((diagnostic) => diagnostic.includes('absent-persona'));

    expect(message).toBeDefined();
    expectFragmentProvenance(message!, workflowPath, 'missing-persona', fragmentPath, 'fragment');
  });

  it('does not attribute an inline doctor graph error to an unrelated fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/safe.yaml', yaml(
      'instruction: safe',
    ));
    const workflowPath = writeWorkflow(projectDir, 'inline-doctor-route', yaml(
      '  - uses: safe',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
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
    ));
    const workflowPath = writeWorkflow(projectDir, 'fragment-preview', yaml(
      '  - uses: preview-step',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ).trimEnd(), 'preview-step');
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

  it.each([
    ['top-level step', '  - name: review\n    uses: "@owner/repo/unsafe"\n    rules:\n      - condition: done\n        next: COMPLETE', 'instruction: review\nallow_git_commit: true\n'],
    ['parallel parent', '  - name: reviewers\n    uses: "@owner/repo/unsafe"\n    rules:\n      self:\n        - condition: done\n          next: COMPLETE\n      parallel:\n        review:\n          - condition: done', 'allow_git_commit: true\nparallel:\n  - name: review\n    instruction: review\n'],
    ['parallel sub-step', '  - name: reviewers\n    parallel:\n      - name: review\n        uses: "@owner/repo/unsafe"\n        rules:\n          - condition: done\n    rules:\n      - condition: all("done")\n        next: COMPLETE', 'instruction: review\nallow_git_commit: true\n'],
    ['dynamic fixed sub-step', '  - name: reviewers\n    parallel:\n      fixed:\n        - name: architecture\n          uses: "@owner/repo/unsafe"\n          rules:\n            - condition: done\n      pool:\n        - name: frontend\n          description: Review frontend\n          instruction: Review frontend\n          rules:\n            - condition: done\n    rules:\n      - condition: all("done")\n        next: COMPLETE', 'instruction: review\nallow_git_commit: true\n'],
    ['dynamic pool sub-step', '  - name: reviewers\n    parallel:\n      fixed:\n        - name: architecture\n          instruction: Review architecture\n          rules:\n            - condition: done\n      pool:\n        - name: frontend\n          description: Review frontend\n          uses: "@owner/repo/unsafe"\n          rules:\n            - condition: done\n    rules:\n      - condition: all("done")\n        next: COMPLETE', 'instruction: review\nallow_git_commit: true\n'],
  ])('rejects low-trust allow_git_commit from a %s', (_placement, steps, fragment) => {
    const fragmentPath = writeFile(globalConfigDir, 'repertoire/@owner/repo/steps/unsafe.yaml', fragment);
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      steps,
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow('allow_git_commit from step fragment "@owner/repo/unsafe"');
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(fragmentPath);
  });

  it('allows a project workflow to override a low-trust allow_git_commit value', () => {
    writeFile(globalConfigDir, 'repertoire/@owner/repo/steps/unsafe.yaml', [
      'instruction: review',
      'allow_git_commit: true',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: "@owner/repo/unsafe"',
      '    allow_git_commit: false',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]).toMatchObject({ allowGitCommit: false });
  });

  it('rejects allow_git_commit inherited through nested low-trust fragments', () => {
    const fragmentPath = writeFile(globalConfigDir, 'repertoire/@owner/repo/steps/base.yaml', 'instruction: review\nallow_git_commit: true\n');
    writeFile(globalConfigDir, 'repertoire/@owner/repo/steps/unsafe.yaml', 'uses: "@owner/repo/base"\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: "@owner/repo/unsafe"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(`allow_git_commit from step fragment "@owner/repo/base" at ${fragmentPath}`);
  });

  it.each([
    ['workflow_call', 'kind: workflow_call\ncall: child\n', 'workflow_call'],
    ['allow_git_commit', 'instruction: review\nallow_git_commit: true\n', 'allow_git_commit'],
  ])('fails closed for fragment-derived %s without projectDir', (_field, fragment, expected) => {
    const stepsDir = join(projectDir, '.takt', 'steps');
    writeFile(projectDir, '.takt/steps/unsafe.yaml', fragment);

    const error = captureConfigError(() => resolveWorkflowStepFragments({
      steps: [{ uses: 'unsafe', rules: [{ condition: 'done', next: 'COMPLETE' }] }],
    }, {
      workflowPath: join(projectDir, '.takt', 'workflows', 'default.yaml'),
      candidateDirs: [stepsDir],
      context: { lang: 'en' },
      trustInfo: {
        source: 'project',
        sourcePath: join(projectDir, '.takt', 'workflows', 'default.yaml'),
        isProjectTrustRoot: true,
        isProjectWorkflowRoot: true,
      },
    }));

    expect(error).toBeInstanceOf(StepFragmentConfigurationError);
    expect(error.message).toContain(expected);
    expect(error.message).toContain('without projectDir');
  });
});
