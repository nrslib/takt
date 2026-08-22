import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { getBuiltinLanguageStepsDir, getBuiltinSharedStepsDir, getGlobalStepsDir } from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { getWorkflowDescription } from '../infra/config/loaders/workflowPreview.js';
import { WorkflowEngine } from '../core/workflow/index.js';

const COMPLETE_CALLER_RULES = `
    rules:
      - condition: done
        next: COMPLETE`;

const COMPLETE_PARALLEL_CALLER_RULES = `
        rules:
          - condition: done
            next: COMPLETE`;

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeWorkflow(root: string, name: string, steps: string, initialStep: string): string {
  return writeFile(root, `.takt/workflows/${name}.yaml`, `name: ${name}
initial_step: ${initialStep}
max_steps: 3
steps:
${steps}
`);
}

function writeProjectFragment(root: string, name: string, content: string): string {
  return writeFile(root, `.takt/steps/${name}.yaml`, content);
}

function writeGlobalFragment(root: string, name: string, content: string): string {
  return writeFile(root, `steps/${name}.yaml`, content);
}

function writePackageFragment(root: string, owner: string, repo: string, name: string, content: string): string {
  return writeFile(root, `repertoire/@${owner}/${repo}/steps/${name}.yaml`, content);
}

function writeCallableWorkflow(root: string): void {
  writeFile(root, '.takt/workflows/called.yaml', `name: called
subworkflow:
  callable: true
  returns: [done]
initial_step: child
max_steps: 1
steps:
  - name: child
    instruction: child
    rules:
      - condition: done
        return: done
`);
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

describe('workflow step fragments', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('should expand a top-level agent step from a project fragment', () => {
    writeProjectFragment(projectDir, 'implement', 'instruction: implement the task\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'agent-fragment',
      `  - uses: implement${COMPLETE_CALLER_RULES}`,
      'implement',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]).toMatchObject({ name: 'implement', instruction: 'implement the task' });
    expect(workflow.steps[0]?.rules).toMatchObject([
      { condition: { kind: 'semantic', label: 'done' }, next: 'COMPLETE' },
    ]);
  });

  it('should expand a top-level workflow_call step from a project fragment', () => {
    writeCallableWorkflow(projectDir);
    writeProjectFragment(projectDir, 'delegate', `kind: workflow_call
call: called
`);
    const workflowPath = writeWorkflow(
      projectDir,
      'workflow-call-fragment',
      `  - uses: delegate${COMPLETE_CALLER_RULES}`,
      'delegate',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({ name: 'delegate', kind: 'workflow_call', call: 'called' });
  });

  it('should expand a parallel parent step from a project fragment', () => {
    writeProjectFragment(projectDir, 'reviewers', `parallel:
  - name: review
    instruction: review the task
`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-parent-fragment', `  - uses: reviewers
    rules:
      self:
        - condition: all("done")
          next: COMPLETE
      parallel:
        review:
          - condition: done
            next: COMPLETE`, 'reviewers');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({
      name: 'reviewers',
      parallel: [{ name: 'review', instruction: 'review the task' }],
    });
  });

  it('should expand an agent parallel sub-step from a project fragment', () => {
    writeProjectFragment(projectDir, 'review', 'instruction: review the task\n');
    const workflowPath = writeWorkflow(projectDir, 'parallel-agent-fragment', `  - name: reviewers
    parallel:
      - uses: review${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`, 'reviewers');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'review', instruction: 'review the task' }]);
  });

  it('should expand a workflow_call parallel sub-step from a project fragment', () => {
    writeCallableWorkflow(projectDir);
    writeProjectFragment(projectDir, 'delegate', `kind: workflow_call
call: called
`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-call-fragment', `  - name: delegates
    parallel:
      - uses: delegate${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`, 'delegates');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel).toMatchObject([{ name: 'delegate', kind: 'workflow_call', call: 'called' }]);
  });

  it.each([
    ['description', 'description: review'],
    ['delay_before_ms', 'delay_before_ms: 1'],
    ['structured_output', 'structured_output: {}'],
    ['system_inputs', 'system_inputs: []'],
    ['effects', 'effects: []'],
    ['parallel', 'parallel:\n  - name: nested\n    instruction: nested'],
    ['concurrency', 'concurrency: 1'],
    ['arpeggio', 'arpeggio: {}'],
    ['team_leader', 'team_leader: {}'],
  ])('should reject unsupported agent parallel sub-step field %s supplied by a fragment', (field, value) => {
    writeProjectFragment(projectDir, 'review', `${value}\ninstruction: review\n`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-agent-invalid-field', `  - name: reviewers
    parallel:
      - uses: review${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`, 'reviewers');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(`"${field}"`);
  });

  it.each([
    ['session', 'session: compact'],
    ['delay_before_ms', 'delay_before_ms: 1'],
    ['structured_output', 'structured_output: {}'],
    ['system_inputs', 'system_inputs: []'],
    ['effects', 'effects: []'],
    ['parallel', 'parallel:\n  - name: nested\n    instruction: nested'],
    ['concurrency', 'concurrency: 1'],
    ['arpeggio', 'arpeggio: {}'],
    ['team_leader', 'team_leader: {}'],
  ])('should reject unsupported workflow_call parallel sub-step field %s supplied by a fragment', (field, value) => {
    writeCallableWorkflow(projectDir);
    writeProjectFragment(projectDir, 'delegate', `kind: workflow_call\ncall: called\n${value}\n`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-call-invalid-field', `  - name: delegates
    parallel:
      - uses: delegate${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`, 'delegates');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(`"${field}"`);
  });

  it.each([
    ['agent', 'instruction: review'],
    ['workflow_call', 'kind: workflow_call\ncall: called'],
  ])('should reject a rule tree on a %s parallel sub-step fragment caller', (_kind, fragment) => {
    if (fragment.includes('workflow_call')) writeCallableWorkflow(projectDir);
    writeProjectFragment(projectDir, 'nested-rules', `${fragment}\n`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-sub-step-rule-tree', `  - name: reviewers
    parallel:
      - uses: nested-rules
        rules:
          self:
            - condition: all("done")
          parallel:
            nested:
              - condition: done
    rules:
      - condition: all("done")
        next: COMPLETE`, 'reviewers');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('should prefer a project fragment over the global fragment with the same name', () => {
    writeGlobalFragment(globalConfigDir, 'shared', 'instruction: global instruction\n');
    writeProjectFragment(projectDir, 'shared', 'instruction: project instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'project-precedence',
      `  - uses: shared${COMPLETE_CALLER_RULES}`,
      'shared',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.instruction).toBe('project instruction');
  });

  it('should use a global fragment when the project has no matching fragment', () => {
    writeGlobalFragment(globalConfigDir, 'shared', 'instruction: global instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'global-fallback',
      `  - uses: shared${COMPLETE_CALLER_RULES}`,
      'shared',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.instruction).toBe('global instruction');
  });

  it('should prefer a package-local fragment for a repertoire workflow', () => {
    writeProjectFragment(projectDir, 'shared', 'instruction: project instruction\n');
    writePackageFragment(globalConfigDir, 'owner', 'package', 'shared', 'instruction: package instruction\n');
    const workflowPath = writeFile(globalConfigDir, 'repertoire/@owner/package/workflows/package-workflow.yaml', `name: package-workflow
initial_step: shared
max_steps: 1
steps:
  - uses: shared${COMPLETE_CALLER_RULES}
`);

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.instruction).toBe('package instruction');
  });

  it('should resolve a scoped fragment from the named repertoire package', () => {
    writePackageFragment(globalConfigDir, 'owner', 'package', 'shared', 'instruction: package instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'scoped-fragment',
      `  - uses: "@owner/package/shared"${COMPLETE_CALLER_RULES}`,
      'shared',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({ name: 'shared', instruction: 'package instruction' });
  });

  it('should reject an incomplete scoped reference before it can resolve another package fragment', () => {
    writePackageFragment(globalConfigDir, 'owner', 'rep', 'repo', 'instruction: wrong package\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'incomplete-scoped-fragment',
      `  - uses: "@owner/repo"${COMPLETE_CALLER_RULES}`,
      'repo',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('incomplete-scoped-fragment.yaml');
    expect(message).toContain('@owner/repo');
    expect(message).toContain('expected @owner/repo/name');
  });

  it.each(['en', 'ja'] as const)('should use the selected %s builtin steps directory', (lang) => {
    expect(buildStepFragmentLookupDirs({ lang })).toEqual([
      getGlobalStepsDir(),
      getBuiltinLanguageStepsDir(lang),
      getBuiltinSharedStepsDir(),
    ]);
  });

  it.each(['en', 'ja'] as const)('should resolve a fragment from the selected %s builtin directory', (lang) => {
    const workflowPath = join(getBuiltinLanguageStepsDir(lang), 'fixture-workflow.yaml');
    const resolution = resolveWorkflowStepFragments({
      steps: [{
        uses: 'request-replan',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, {
      workflowPath,
      candidateDirs: [getBuiltinLanguageStepsDir(lang)],
      context: {
        lang,
        projectDir,
        workflowDir: getBuiltinLanguageStepsDir(lang),
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      },
      trustInfo: {
        source: 'builtin',
        sourcePath: workflowPath,
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      },
    });

    expect(resolution.dependencies).toContainEqual(expect.objectContaining({
      ref: 'request-replan',
      sourceRoot: getBuiltinLanguageStepsDir(lang),
    }));
  });

  it('should retain the resolved source layer for nested bare fragment references', () => {
    writeProjectFragment(projectDir, 'inner', 'instruction: project instruction\n');
    writeGlobalFragment(globalConfigDir, 'outer', 'uses: inner\n');
    writeGlobalFragment(globalConfigDir, 'inner', 'instruction: global instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'nested-layer',
      `  - uses: outer${COMPLETE_CALLER_RULES}`,
      'inner',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.instruction).toBe('global instruction');
  });

  it('should deep merge object overrides and use rules from the workflow', () => {
    writeFile(projectDir, '.takt/config.yaml', `workflow_mcp_servers:
  http: true
`);
    writeProjectFragment(projectDir, 'base', `name: fragment-name
instruction: fragment instruction
mcp_servers:
  docs:
    type: http
    url: https://example.com/mcp
    headers:
      X-Base: fragment
`);
    const workflowPath = writeWorkflow(projectDir, 'merge-overrides', `  - uses: base
    name: caller-name
    mcp_servers:
      docs:
        headers:
          X-Caller: workflow
    rules:
      - condition: caller
        next: COMPLETE`, 'caller-name');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({
      name: 'caller-name',
      instruction: 'fragment instruction',
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { 'X-Base': 'fragment', 'X-Caller': 'workflow' },
        },
      },
      rules: [{ condition: { kind: 'semantic', label: 'caller' }, next: 'COMPLETE' }],
    });
  });

  it('should use the fragment name before the uses name when the caller omits name', () => {
    writeProjectFragment(projectDir, 'reference-name', `name: fragment-name
instruction: fragment instruction
`);
    const workflowPath = writeWorkflow(
      projectDir,
      'fragment-name-default',
      `  - uses: reference-name${COMPLETE_CALLER_RULES}`,
      'fragment-name',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.name).toBe('fragment-name');
  });

  it('should use the uses name when neither caller nor fragment declares a name', () => {
    writeProjectFragment(projectDir, 'reference-name', 'instruction: fragment instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'uses-name-default',
      `  - uses: reference-name${COMPLETE_CALLER_RULES}`,
      'reference-name',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.name).toBe('reference-name');
  });

  it('should expand a fragment that uses another fragment', () => {
    writeProjectFragment(projectDir, 'base', 'instruction: fragment instruction\n');
    writeProjectFragment(projectDir, 'derived', 'uses: base\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'nested-fragment',
      `  - uses: derived${COMPLETE_CALLER_RULES}`,
      'derived',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({ name: 'derived', instruction: 'fragment instruction' });
  });

  it('should apply a changed fragment definition on the next workflow load', () => {
    const fragmentPath = writeProjectFragment(projectDir, 'changeable', 'instruction: before\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'fragment-reload',
      `  - uses: changeable${COMPLETE_CALLER_RULES}`,
      'changeable',
    );

    const firstLoad = loadWorkflowFromFile(workflowPath, projectDir);
    writeFileSync(fragmentPath, 'instruction: after\n', 'utf-8');
    const secondLoad = loadWorkflowFromFile(workflowPath, projectDir);

    expect(firstLoad.steps[0]?.instruction).toBe('before');
    expect(secondLoad.steps[0]?.instruction).toBe('after');
  });

  it('should normalize a fragment-backed step identically to its inline definition', () => {
    const fragmentDefinition = `name: plan
instruction: plan the task
`;
    const stepDefinition = `${fragmentDefinition}rules:
  - condition: done
    next: COMPLETE
`;
    writeProjectFragment(projectDir, 'plan', fragmentDefinition);
    const inlineWorkflowPath = writeFile(projectDir, '.takt/workflows/inline.yaml', `name: inline
initial_step: plan
max_steps: 3
loop_monitors:
  - cycle: [plan, plan]
    threshold: 2
    judge:
      rules:
        - condition: stop
          next: ABORT
steps:
  - ${stepDefinition.replaceAll('\n', '\n    ').trimEnd()}
`);
    const fragmentWorkflowPath = writeFile(projectDir, '.takt/workflows/fragment.yaml', `name: fragment
initial_step: plan
max_steps: 3
loop_monitors:
  - cycle: [plan, plan]
    threshold: 2
    judge:
      rules:
        - condition: stop
          next: ABORT
steps:
  - uses: plan${COMPLETE_CALLER_RULES}
`);

    const inlineWorkflow = loadWorkflowFromFile(inlineWorkflowPath, projectDir);
    const fragmentWorkflow = loadWorkflowFromFile(fragmentWorkflowPath, projectDir);

    expect(fragmentWorkflow.initialStep).toBe(inlineWorkflow.initialStep);
    expect(fragmentWorkflow.steps).toEqual(inlineWorkflow.steps);
    expect(fragmentWorkflow.loopMonitors).toEqual(inlineWorkflow.loopMonitors);
  });

  it('should reject an unknown fragment with workflow and uses context', () => {
    const workflowPath = writeWorkflow(
      projectDir,
      'unknown-fragment',
      `  - uses: missing-fragment${COMPLETE_CALLER_RULES}`,
      'missing-fragment',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('unknown-fragment.yaml');
    expect(message).toContain('missing-fragment');
    expect(message).toContain('steps');
  });

  it('should report only the scoped package steps directory when a scoped fragment is missing', () => {
    const workflowPath = writeWorkflow(
      projectDir,
      'missing-scoped-fragment',
      `  - uses: "@owner/missing/review"${COMPLETE_CALLER_RULES}`,
      'review',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain(join(globalConfigDir, 'repertoire', '@owner', 'missing', 'steps'));
    expect(message).not.toContain(join(projectDir, '.takt', 'steps'));
    expect(message).not.toContain(join(globalConfigDir, 'steps'));
  });

  it('should retain schema-allowed record keys when no step uses a fragment', () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/record-key.yaml', `name: record-key
personas:
  constructor: coder.md
initial_step: run
max_steps: 1
steps:
  - name: run
    instruction: run
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).not.toThrow();
  });

  it('should retain fragment context when rejecting forbidden object keys in a caller step', () => {
    const fragmentPath = writeProjectFragment(projectDir, 'safe', 'instruction: safe\n');
    const workflowPath = writeWorkflow(projectDir, 'forbidden-key', `  - uses: safe
    provider_options:
      codex:
        __proto__:
          instruction: injected${COMPLETE_CALLER_RULES}`, 'safe');

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('forbidden-key.yaml');
    expect(message).toContain('forbidden key "__proto__"');
    expect(message).toContain('step fragment "safe"');
    expect(message).toContain(fragmentPath);
  });

  it('should retain schema-allowed constructor and prototype keys in fragment-backed MCP records', () => {
    writeFile(projectDir, '.takt/config.yaml', `workflow_mcp_servers:
  sse: true
  stdio: true
`);
    writeProjectFragment(projectDir, 'mcp-records', `instruction: safe
mcp_servers:
  constructor:
    type: sse
    url: https://example.com/sse
    headers:
      constructor: fragment-header
  prototype:
    type: stdio
    command: node
    env:
      constructor: fragment-env
`);
    const workflowPath = writeWorkflow(projectDir, 'mcp-record-keys', `  - uses: mcp-records
    mcp_servers:
      constructor:
        headers:
          prototype: caller-header
      prototype:
        env:
          prototype: caller-env${COMPLETE_CALLER_RULES}`, 'mcp-records');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.mcpServers).toEqual({
      constructor: {
        type: 'sse',
        url: 'https://example.com/sse',
        headers: { constructor: 'fragment-header', prototype: 'caller-header' },
      },
      prototype: {
        type: 'stdio',
        command: 'node',
        env: { constructor: 'fragment-env', prototype: 'caller-env' },
      },
    });
  });

  it('should retain schema-allowed constructor and prototype keys in parallel workflow_call args', () => {
    writeCallableWorkflow(projectDir);
    writeProjectFragment(projectDir, 'delegate-with-args', `kind: workflow_call
call: called
args:
  constructor: fragment-value
`);
    const workflowPath = writeWorkflow(projectDir, 'parallel-args-record-keys', `  - name: delegates
    parallel:
      - uses: delegate-with-args
        args:
          prototype: caller-value${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`, 'delegates');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]?.parallel?.[0]).toMatchObject({
      kind: 'workflow_call',
      args: { constructor: 'fragment-value', prototype: 'caller-value' },
    });
  });

  it('should reject circular fragment references with the complete reference chain', () => {
    writeProjectFragment(projectDir, 'first', 'uses: second\n');
    writeProjectFragment(projectDir, 'second', 'uses: first\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'circular-fragment',
      `  - uses: first${COMPLETE_CALLER_RULES}`,
      'first',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular-fragment.yaml');
    expect(message).toContain('first');
    expect(message).toContain('second');
  });

  it.each(['../outside', '/tmp/fragment', 'nested/fragment', 'nested\\fragment'])(
    'should reject unsafe uses reference %s before loading a fragment',
    (uses) => {
      const workflowPath = writeWorkflow(
        projectDir,
        'unsafe-fragment',
        `  - uses: ${uses}${COMPLETE_CALLER_RULES}`,
        'unsafe',
      );

      const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

      expect(message).toContain('unsafe-fragment.yaml');
      expect(message).toContain(uses);
    },
  );

  it.each(['a scalar', '- name: not-a-step'])(
    'should reject a fragment YAML document that is not a single object: %s',
    (fragment) => {
      writeProjectFragment(projectDir, 'invalid-shape', `${fragment}\n`);
      const workflowPath = writeWorkflow(
        projectDir,
        'invalid-fragment-shape',
        `  - uses: invalid-shape${COMPLETE_CALLER_RULES}`,
        'invalid-shape',
      );

      const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

      expect(message).toContain('invalid-fragment-shape.yaml');
      expect(message).toContain('invalid-shape');
      expect(message).toContain(join('.takt', 'steps', 'invalid-shape.yaml'));
    },
  );

  it('should reject a fragment symlink that resolves outside the steps root', () => {
    const outsidePath = writeFile(projectDir, 'outside.yaml', 'instruction: outside\n');
    const stepsDir = join(projectDir, '.takt', 'steps');
    mkdirSync(stepsDir, { recursive: true });
    symlinkSync(outsidePath, join(stepsDir, 'linked.yaml'));
    const workflowPath = writeWorkflow(
      projectDir,
      'symlink-fragment',
      `  - uses: linked${COMPLETE_CALLER_RULES}`,
      'linked',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('symlink-fragment.yaml');
    expect(message).toContain('linked');
  });

  it('should reject an empty symlinked project steps directory before resolving a global fragment', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-empty-steps-outside-'));
    try {
      writeGlobalFragment(globalConfigDir, 'gather', 'instruction: global\n');
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      symlinkSync(outsideDir, join(projectDir, '.takt', 'steps'));
      const workflowPath = writeWorkflow(
        projectDir,
        'symlinked-steps-root',
        `  - uses: gather${COMPLETE_CALLER_RULES}`,
        'gather',
      );

      const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

      expect(message).toContain('candidate directory must not be a symlink');
      expect(message).toContain('gather');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should preserve existing schema validation for an invalid expanded step', () => {
    writeProjectFragment(projectDir, 'invalid-step', 'kind: workflow_call\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'invalid-expanded-step',
      `  - uses: invalid-step${COMPLETE_CALLER_RULES}`,
      'invalid-step',
    );

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues[0]!;
    expect(issue.path).toEqual(['steps', 0, 'call']);
    expect(issue.message).toContain('workflow_call step requires');
    expect(issue.message).toContain(workflowPath);
    expect(issue.message).toContain('step uses fragment "invalid-step"');
    expect(issue.message).toContain(join('.takt', 'steps', 'invalid-step.yaml'));
  });

  it('should retain fragment provenance for a missing workflow_call field after a caller renames the step', () => {
    writeProjectFragment(projectDir, 'invalid-step', 'kind: workflow_call\n');
    const workflowPath = writeWorkflow(projectDir, 'renamed-invalid-expanded-step', `  - uses: invalid-step
    name: renamed${COMPLETE_CALLER_RULES}`, 'renamed');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path.join('.') === 'steps.0.call')!;
    expect(issue.message).toContain('step uses fragment "invalid-step"');
  });

  it('should leave inline step schema errors unannotated when another step uses a fragment', () => {
    writeProjectFragment(projectDir, 'valid-step', 'instruction: valid\n');
    const workflowPath = writeWorkflow(projectDir, 'inline-schema-error', `  - uses: valid-step
    rules:
      - condition: done
        next: COMPLETE
  - name: invalid
    kind: workflow_call`, 'valid-step');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path[1] === 1)!;
    expect(issue.path).toEqual(['steps', 1, 'call']);
    expect(issue.message).toContain('workflow_call step requires');
    expect(issue.message).not.toContain('step fragment');
  });

  it('should retain fragment context for schema errors from caller overrides', () => {
    writeProjectFragment(projectDir, 'valid-step', 'instruction: valid\n');
    const workflowPath = writeWorkflow(projectDir, 'override-schema-error', `  - uses: valid-step
    instruction:
      - 123${COMPLETE_CALLER_RULES}`, 'valid-step');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path.join('.') === 'steps.0.instruction')!;
    expect(issue.message).toContain('step uses fragment "valid-step"');
    expect(issue.message).toContain('defined by the workflow');
  });

  it('should retain fragment context for nested schema errors from caller overrides', () => {
    writeProjectFragment(projectDir, 'valid-options', `instruction: valid
provider_options:
  codex:
    reasoning_effort: low
`);
    const workflowPath = writeWorkflow(projectDir, 'nested-override-schema-error', `  - uses: valid-options
    provider_options:
      codex:
        reasoning_effort: 42${COMPLETE_CALLER_RULES}`, 'valid-options');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path.join('.') === 'steps.0.provider_options')!;
    expect(issue.message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(issue.message).toContain('runtime.yaml');
    expect(issue.message).toContain('step uses fragment "valid-options"');
    expect(issue.message).toContain('defined by the workflow');
  });

  it('should retain fragment provenance for an unmodified leaf in an overridden object', () => {
    writeProjectFragment(projectDir, 'invalid-options', `instruction: valid
provider_options:
  codex:
    reasoning_effort: 42
    network_access: false
`);
    const workflowPath = writeWorkflow(projectDir, 'fragment-leaf-provenance', `  - uses: invalid-options
    provider_options:
      codex:
        network_access: true${COMPLETE_CALLER_RULES}`, 'invalid-options');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path.join('.') === 'steps.0.provider_options')!;
    expect(issue.message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(issue.message).toContain('runtime.yaml');
    expect(issue.message).toContain('step uses fragment "invalid-options"');
  });

  it('should reject a workflow model override with runtime.yaml migration guidance', () => {
    writeProjectFragment(projectDir, 'modelled', `instruction: valid
model: gpt-5
`);
    const workflowPath = writeWorkflow(projectDir, 'null-model-override', `  - uses: modelled
    model: null${COMPLETE_CALLER_RULES}`, 'modelled');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/runtime\.yaml/);
  });

  it('should reject a fragment chain before recursive stack exhaustion', () => {
    let containingFragmentPath = '';
    for (let index = 0; index <= 65; index += 1) {
      const fragmentPath = writeProjectFragment(projectDir, `depth-${index}`, index === 65
        ? 'instruction: valid\n'
        : `uses: depth-${index + 1}\n`);
      if (index === 63) {
        containingFragmentPath = fragmentPath;
      }
    }
    const workflowPath = writeWorkflow(
      projectDir,
      'depth-limit',
      `  - uses: depth-0${COMPLETE_CALLER_RULES}`,
      'depth-0',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('maximum expansion depth');
    expect(message).toContain('step fragment "depth-63"');
    expect(message).toContain(containingFragmentPath);
  });

  it('should expand a fragment chain at the maximum supported depth', () => {
    for (let index = 0; index < 64; index += 1) {
      writeProjectFragment(projectDir, `depth-${index}`, index === 63
        ? 'instruction: valid\n'
        : `uses: depth-${index + 1}\n`);
    }
    const workflowPath = writeWorkflow(
      projectDir,
      'depth-boundary',
      `  - uses: depth-0${COMPLETE_CALLER_RULES}`,
      'depth-0',
    );

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.steps[0]).toMatchObject({ name: 'depth-0', instruction: 'valid' });
  });

  it('should accept a one-megabyte fragment and reject one byte beyond the limit', () => {
    const maxBytes = 1024 * 1024;
    const prefix = 'instruction: ';
    const suffix = '\n';
    const exactContent = prefix + 'x'.repeat(maxBytes - prefix.length - suffix.length) + suffix;
    writeProjectFragment(projectDir, 'at-byte-limit', exactContent);
    const exactWorkflowPath = writeWorkflow(
      projectDir,
      'at-byte-limit',
      `  - uses: at-byte-limit${COMPLETE_CALLER_RULES}`,
      'at-byte-limit',
    );

    expect(() => loadWorkflowFromFile(exactWorkflowPath, projectDir)).not.toThrow();

    writeProjectFragment(projectDir, 'over-byte-limit', `${exactContent}x`);
    const oversizedWorkflowPath = writeWorkflow(
      projectDir,
      'over-byte-limit',
      `  - uses: over-byte-limit${COMPLETE_CALLER_RULES}`,
      'over-byte-limit',
    );

    expect(() => loadWorkflowFromFile(oversizedWorkflowPath, projectDir)).toThrow('exceeds 1048576 bytes');
  });

  it('should accept the maximum number of fragment references and reject one more', () => {
    const maxReferences = 512;
    const fragmentPath = writeProjectFragment(projectDir, 'shared', 'instruction: valid\n');
    const steps = (count: number) => Array.from(
      { length: count },
      (_value, index) => `  - name: shared-${index}\n    uses: shared${COMPLETE_CALLER_RULES}`,
    ).join('\n');
    const acceptedWorkflowPath = writeWorkflow(projectDir, 'reference-limit', steps(maxReferences), 'shared-0');

    expect(() => loadWorkflowFromFile(acceptedWorkflowPath, projectDir)).not.toThrow();

    const rejectedWorkflowPath = writeWorkflow(projectDir, 'over-reference-limit', steps(maxReferences + 1), 'shared-0');

    const message = errorMessage(() => loadWorkflowFromFile(rejectedWorkflowPath, projectDir));

    expect(message).toContain('maximum expansion count of 512');
    expect(message).toContain(fragmentPath);
  });

  it('should retain fragment provenance for a normalizer error after an inline rename', () => {
    const fragmentPath = writeProjectFragment(
      projectDir,
      'empty-persona',
      ['persona: ""', 'instruction: work', ''].join('\n'),
    );
    const workflowPath = writeWorkflow(
      projectDir,
      'empty-persona-fragment',
      [
        '  - uses: empty-persona',
        '    name: renamed',
        '    rules:',
        '      - condition: done',
        '        next: COMPLETE',
      ].join('\n'),
      'renamed',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('empty persona value');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step fragment "empty-persona"');
    expect(message).toContain(fragmentPath);
  });

  it('should retain fragment provenance for a parallel command quality gate error', () => {
    const fragmentPath = writeProjectFragment(
      projectDir,
      'command-gate',
      ['instruction: review', 'quality_gates:', '  - type: command', '    command: npm test', ''].join('\n'),
    );
    const workflowPath = writeWorkflow(
      projectDir,
      'parallel-command-gate',
      [
        '  - name: reviewers',
        '    parallel:',
        '      - uses: command-gate',
        '        rules:',
        '          - condition: done',
        '            next: COMPLETE',
        '    rules:',
        '      - condition: all("done")',
        '        next: COMPLETE',
      ].join('\n'),
      'reviewers',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses command quality gate');
    expect(message).toContain('step fragment "command-gate"');
    expect(message).toContain(fragmentPath);
  });

  it('should retain fragment context for caller-originated missing required fields', () => {
    writeProjectFragment(projectDir, 'agent-step', 'instruction: valid\n');
    const workflowPath = writeWorkflow(projectDir, 'caller-required-field-error', `  - uses: agent-step
    kind: workflow_call${COMPLETE_CALLER_RULES}`, 'agent-step');

    let error: unknown;
    try {
      loadWorkflowFromFile(workflowPath, projectDir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ZodError);
    const issue = (error as ZodError).issues.find((candidate) => candidate.path.join('.') === 'steps.0.call')!;
    expect(issue.message).toContain('step uses fragment "agent-step"');
    expect(issue.message).toContain('defined by the workflow');
  });

  it('should include the containing fragment path for an unresolved nested uses reference', () => {
    const fragmentPath = writeProjectFragment(projectDir, 'outer', 'uses: missing\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'nested-missing-fragment',
      `  - uses: outer${COMPLETE_CALLER_RULES}`,
      'outer',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('missing');
    expect(message).toContain(fragmentPath);
  });

  it('should include the containing fragment name and path for an invalid nested uses value', () => {
    const fragmentPath = writeProjectFragment(projectDir, 'outer', 'uses: 0\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'nested-invalid-fragment',
      `  - uses: outer${COMPLETE_CALLER_RULES}`,
      'outer',
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('step fragment uses must be a non-empty string');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(fragmentPath);
  });

  it('should report an invalid transition after expanding a fragment', () => {
    writeProjectFragment(projectDir, 'invalid-transition', 'instruction: invalid transition\n');
    const workflowPath = writeWorkflow(projectDir, 'invalid-expanded-transition', `  - uses: invalid-transition
    rules:
      - condition: done
        next: missing-step`, 'invalid-transition');

    const report = inspectWorkflowFile(workflowPath, projectDir);

    expect(report.diagnostics.some((diagnostic) => diagnostic.message.includes(
      'Step "invalid-transition" routes to unknown next step "missing-step"',
    ))).toBe(true);
  });

  it('should use expanded steps for doctor reference and graph validation', () => {
    writeProjectFragment(projectDir, 'inspectable', 'instruction: inspectable task\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'doctor-fragment',
      `  - uses: inspectable${COMPLETE_CALLER_RULES}`,
      'inspectable',
    );

    const report = inspectWorkflowFile(workflowPath, projectDir);

    expect(report.diagnostics).toEqual([]);
  });

  it('should use expanded steps when building a workflow preview', () => {
    writeProjectFragment(projectDir, 'preview-step', 'instruction: preview instruction\n');
    writeWorkflow(
      projectDir,
      'preview-fragment',
      `  - uses: preview-step${COMPLETE_CALLER_RULES}`,
      'preview-step',
    );

    const preview = getWorkflowDescription('preview-fragment', projectDir, 1);

    expect(preview.workflowStructure).toContain('preview-step');
  });

  it('should reject duplicate top-level names introduced by fragments', () => {
    writeProjectFragment(projectDir, 'duplicate', 'name: duplicate\ninstruction: work\n');
    const workflowPath = writeWorkflow(projectDir, 'duplicate-expanded-name', `  - uses: duplicate
    rules:
      - condition: done
        next: COMPLETE
  - name: duplicate
    instruction: other
    rules:
      - condition: done
        next: COMPLETE`, 'duplicate');

    expect(() => new WorkflowEngine(loadWorkflowFromFile(workflowPath, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    })).toThrow(/duplicate step name "duplicate"/);
  });

  it('reports fragment context when a caller-provided duplicate name collides with a fragment-defined name', () => {
    writeProjectFragment(projectDir, 'first', 'name: duplicate\ninstruction: work\n');
    writeProjectFragment(projectDir, 'second', 'instruction: other\n');
    const workflowPath = writeWorkflow(projectDir, 'caller-duplicate-name', `  - uses: first
    rules:
      - condition: done
        next: COMPLETE
  - uses: second
    name: duplicate
    rules:
      - condition: done
        next: COMPLETE`, 'duplicate');

    const message = errorMessage(() => new WorkflowEngine(loadWorkflowFromFile(workflowPath, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    }));

    expect(message).toContain('duplicate step name "duplicate"');
    expect(message).toContain('step fragment "second"');
  });

  it('should reject system steps supplied by a fragment', () => {
    writeProjectFragment(projectDir, 'system-step', 'kind: system\ninputs: []\neffects: []\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'system-fragment',
      `  - uses: system-step${COMPLETE_CALLER_RULES}`,
      'system-step',
    );

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/unsupported kind "system"/);
  });

  it.each([
    ['top-level', `  - uses: system-step${COMPLETE_CALLER_RULES}`],
    ['parallel', `  - name: parent
    instruction: work
    parallel:
      - uses: system-step${COMPLETE_PARALLEL_CALLER_RULES}
    rules:
      - condition: all("done")
        next: COMPLETE`],
  ])('should reject mode: system supplied by a fragment in a %s step', (_placement, steps) => {
    writeProjectFragment(projectDir, 'system-step', 'mode: system\ninputs: []\neffects: []\n');
    const workflowPath = writeWorkflow(projectDir, 'system-mode-fragment', steps, 'parent');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/unsupported kind "system"/);
  });

  it('should reject YAML sets as step fragments', () => {
    writeProjectFragment(projectDir, 'set-step', '!!set\n? instruction\n');
    const workflowPath = writeWorkflow(
      projectDir,
      'set-fragment',
      `  - uses: set-step${COMPLETE_CALLER_RULES}`,
      'set-step',
    );

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/must contain one step object/);
  });

  it('publishes an immutable dependency manifest with eject sources', () => {
    const stepsDir = join(projectDir, '.takt', 'steps');
    const innerPath = writeProjectFragment(projectDir, 'inner', 'instruction: review\n');
    const outerPath = writeProjectFragment(projectDir, 'outer', 'uses: inner\n');

    const resolution = resolveWorkflowStepFragments({
      steps: [{
        uses: 'outer',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, {
      workflowPath: join(projectDir, '.takt', 'workflows', 'default.yaml'),
      candidateDirs: [stepsDir],
      context: {
        lang: 'en',
        projectDir,
        workflowDir: join(projectDir, '.takt', 'workflows'),
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      },
    });

    const outer = resolution.dependencies.find((dependency) => dependency.ref === 'outer');
    const inner = resolution.dependencies.find((dependency) => dependency.ref === 'inner');

    expect(resolution.dependencies).toHaveLength(2);
    expect(outer).toMatchObject({
      sourcePath: outerPath,
      sourceRoot: stepsDir,
    });
    expect(inner).toMatchObject({
      sourcePath: innerPath,
      sourceRoot: stepsDir,
    });
    expect(Object.isFrozen(resolution.dependencies)).toBe(true);
    expect(Object.isFrozen(outer)).toBe(true);
    expect(() => (resolution.dependencies as unknown as string[]).push('mutated')).toThrow();
  });

  it('creates a distinct step object for each repeated raw step position', () => {
    const sharedStep = { name: 'review', instruction: 'review' };

    const resolution = resolveWorkflowStepFragments({
      steps: [sharedStep, sharedStep],
    }, {
      workflowPath: join(projectDir, '.takt', 'workflows', 'shared-step.yaml'),
    });
    const steps = (resolution.raw as { steps: unknown[] }).steps;

    expect(steps[0]).not.toBe(steps[1]);
  });

  function parallelRuleTreeWorkflow(uses: string, childName: string, override = ''): string {
    return [
      'name: parallel-fragment-resolution',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      `    uses: ${uses}`,
      ...(override.length > 0 ? override.split('\n').map((line) => `    ${line}`) : []),
      '    rules:',
      '      self:',
      '        - condition: all("done")',
      '          next: COMPLETE',
      '      parallel:',
      `        ${childName}:`,
      '          - condition: done',
      '',
    ].join('\n');
  }

  it('resolves a nested parallel reference from the fragment definition scope', () => {
    writeGlobalFragment(globalConfigDir, 'reviewers', 'parallel:\n  - uses: reviewer\n');
    writeGlobalFragment(globalConfigDir, 'reviewer', 'name: global-reviewer\ninstruction: global review\n');
    writeProjectFragment(projectDir, 'reviewer', 'name: project-reviewer\ninstruction: project review\n');
    const workflowPath = writeFile(
      projectDir,
      '.takt/workflows/review.yaml',
      parallelRuleTreeWorkflow('reviewers', 'global-reviewer'),
    );

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'global-reviewer',
      instruction: 'global review',
    });
  });

  it('uses the caller scope when the caller replaces a fragment parallel array', () => {
    writeGlobalFragment(globalConfigDir, 'reviewers', 'parallel:\n  - uses: discarded-reviewer\n');
    writeProjectFragment(projectDir, 'reviewer', 'name: project-reviewer\ninstruction: project review\n');
    writeGlobalFragment(globalConfigDir, 'reviewer', 'name: global-reviewer\ninstruction: global review\n');
    const workflowPath = writeFile(
      projectDir,
      '.takt/workflows/review.yaml',
      parallelRuleTreeWorkflow('reviewers', 'project-reviewer', [
        'parallel:',
        '  - uses: reviewer',
        '    rules:',
        '      - condition: done',
      ].join('\n')),
    );

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'project-reviewer',
      instruction: 'project review',
    });
  });

  it('rejects a circular reference reached through a fragment parallel sub-step', () => {
    writeGlobalFragment(globalConfigDir, 'reviewers', 'parallel:\n  - uses: reviewers\n');
    const workflowPath = writeFile(
      projectDir,
      '.takt/workflows/review.yaml',
      parallelRuleTreeWorkflow('reviewers', 'cycle'),
    );

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular step fragment reference "reviewers"');
    expect(message).not.toContain('maximum expansion');
  });

  it('does not resolve a discarded fragment parallel array', () => {
    writeGlobalFragment(globalConfigDir, 'reviewers', 'parallel:\n  - uses: missing-reviewer\n');
    const workflowPath = writeFile(
      projectDir,
      '.takt/workflows/review.yaml',
      parallelRuleTreeWorkflow('reviewers', 'inline-reviewer', [
        'parallel:',
        '  - name: inline-reviewer',
        '    instruction: review',
        '    rules:',
        '      - condition: done',
        '        next: COMPLETE',
      ].join('\n')),
    );

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel).toHaveLength(1);
    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'inline-reviewer',
      instruction: 'review',
    });
    expect(loaded.steps[0]?.parallel).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'missing-reviewer' })]),
    );
  });

  it('expands fixed and pool fragments before validating a dynamic parallel step', () => {
    writeFile(
      projectDir,
      '.takt/facets/personas/architecture-reviewer.md',
      'Architecture persona contract',
    );
    writeFile(
      projectDir,
      '.takt/facets/personas/frontend-reviewer.md',
      'Frontend persona contract',
    );
    writeFile(projectDir, '.takt/facets/policies/architecture-policy.md', 'Architecture policy contract');
    writeFile(projectDir, '.takt/facets/policies/frontend-policy.md', 'Frontend policy contract');
    writeFile(projectDir, '.takt/facets/knowledge/architecture-domain.md', 'Architecture knowledge contract');
    writeFile(projectDir, '.takt/facets/knowledge/frontend-domain.md', 'Frontend knowledge contract');
    writeProjectFragment(projectDir, 'architecture', [
      'name: architecture',
      'persona: architecture-reviewer',
      'policy: [architecture-policy]',
      'knowledge: [architecture-domain]',
      'instruction: Review architecture',
      'output_contracts:',
      '  report:',
      '    - name: architecture-review.md',
      '      format: review',
      '',
    ].join('\n'));
    writeProjectFragment(projectDir, 'frontend', [
      'name: frontend',
      'persona: frontend-reviewer',
      'policy: [frontend-policy]',
      'knowledge: [frontend-domain]',
      'instruction: Review frontend implementation',
      'output_contracts:',
      '  report:',
      '    - name: frontend-review.md',
      '      format: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', [
      'name: dynamic-parallel-fragment-resolution',
      'initial_step: reviewers',
      'max_steps: 1',
      'report_formats:',
      '  review: Return the reviewer report.',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      fixed:',
      '        - uses: architecture',
      '          rules:',
      '            - condition: approved',
      '              next: COMPLETE',
      '      pool:',
      '        - uses: frontend',
      '          description: Review frontend changes',
      '          rules:',
      '            - condition: approved',
      '              next: COMPLETE',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);
    const parallel = loaded.steps[0]?.parallel as unknown as {
      fixed: Array<Record<string, unknown>>;
      pool: Array<{
        name: string;
        description: string;
        instruction: string;
        rules: unknown[];
      }>;
      selection: { mode: string };
    };

    expect(parallel).toMatchObject({
      fixed: [{
        name: 'architecture',
        persona: 'architecture-reviewer',
        personaPath: join(projectDir, '.takt/facets/personas/architecture-reviewer.md'),
        policyContents: [expect.objectContaining({ content: 'Architecture policy contract' })],
        knowledgeContents: [expect.objectContaining({ content: 'Architecture knowledge contract' })],
        instruction: 'Review architecture',
        outputContracts: [{ name: 'architecture-review.md', format: 'Return the reviewer report.' }],
        rules: [{ condition: { kind: 'semantic', label: 'approved' }, next: 'COMPLETE' }],
      }],
      pool: [{
        name: 'frontend',
        description: 'Review frontend changes',
        persona: 'frontend-reviewer',
        personaPath: join(projectDir, '.takt/facets/personas/frontend-reviewer.md'),
        policyContents: [expect.objectContaining({ content: 'Frontend policy contract' })],
        knowledgeContents: [expect.objectContaining({ content: 'Frontend knowledge contract' })],
        instruction: 'Review frontend implementation',
        outputContracts: [{ name: 'frontend-review.md', format: 'Return the reviewer report.' }],
        rules: [{ condition: { kind: 'semantic', label: 'approved' }, next: 'COMPLETE' }],
      }],
      selection: { mode: 'replace' },
    });
  });

  it('applies caller-owned rules to dynamic participants inside a parent fragment', () => {
    writeProjectFragment(projectDir, 'architecture', [
      'name: architecture',
      'instruction: Review architecture',
      '',
    ].join('\n'));
    writeProjectFragment(projectDir, 'frontend', [
      'name: frontend',
      'instruction: Review frontend',
      '',
    ].join('\n'));
    writeProjectFragment(projectDir, 'dynamic-reviewers', [
      'parallel:',
      '  fixed:',
      '    - uses: architecture',
      '  pool:',
      '    - uses: frontend',
      '      description: Review frontend changes',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', [
      'name: nested-dynamic-parallel-fragment-resolution',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    uses: dynamic-reviewers',
      '    rules:',
      '      self:',
      '        - condition: all("approved")',
      '          next: COMPLETE',
      '      parallel:',
      '        architecture:',
      '          - condition: approved',
      '        frontend:',
      '          - condition: approved',
      '',
    ].join('\n'));

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);
    const parallel = loaded.steps[0]?.parallel as unknown as {
      fixed: Array<Record<string, unknown>>;
      pool: Array<Record<string, unknown>>;
    };

    expect(parallel.fixed).toMatchObject([{
      name: 'architecture',
      rules: [{ condition: { kind: 'semantic', label: 'approved' } }],
    }]);
    expect(parallel.pool).toMatchObject([{
      name: 'frontend',
      description: 'Review frontend changes',
      rules: [{ condition: { kind: 'semantic', label: 'approved' } }],
    }]);
  });

  it('rejects rules owned by a fragment used as a dynamic participant', () => {
    writeProjectFragment(projectDir, 'reviewer', [
      'name: reviewer',
      'instruction: Review changes',
      'rules:',
      '  - condition: approved',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', [
      'name: dynamic-parallel-fragment-rules',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - uses: reviewer',
      '          description: Review changes',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('rejects a dynamic participant using a fragment without caller rules', () => {
    writeProjectFragment(projectDir, 'reviewer', [
      'name: reviewer',
      'instruction: Review changes',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', [
      'name: dynamic-parallel-missing-caller-rules',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - uses: reviewer',
      '          description: Review changes',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('rejects duplicate names after expanding fixed and pool fragments', () => {
    writeProjectFragment(projectDir, 'fixed-review', [
      'name: duplicate-review',
      'instruction: Review architecture',
      '',
    ].join('\n'));
    writeProjectFragment(projectDir, 'pool-review', [
      'name: duplicate-review',
      'instruction: Review frontend implementation',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', [
      'name: dynamic-parallel-duplicate',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      fixed:',
      '        - uses: fixed-review',
      '          rules:',
      '            - condition: approved',
      '              next: COMPLETE',
      '      pool:',
      '        - uses: pool-review',
      '          description: Review frontend changes',
      '          rules:',
      '            - condition: approved',
      '              next: COMPLETE',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/duplicate-review/);
  });

  it('rejects fragment-owned rules for a caller-owned fragment expansion', () => {
    writeProjectFragment(projectDir, 'body', `instruction: review
rules:
  - condition: fragment-owned
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: body
    rules:
      - condition: caller-owned
        next: COMPLETE`, 'entry');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir))
      .toThrow('define rules on each concrete workflow step that uses the fragment');
  });

  it.each([
    ['missing', ''],
    ['empty', '    rules: []\n'],
  ])('rejects %s caller rules', (_label, rules) => {
    writeProjectFragment(projectDir, 'body', 'instruction: review\n');
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: body
${rules}`.trimEnd(), 'entry');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('injects a rule tree by final child name while preserving fragment order and concurrency', () => {
    writeProjectFragment(projectDir, 'reviewers', `name: reviewers
concurrency: 2
parallel:
  - name: architecture
    instruction: architecture review
  - name: security
    instruction: security review
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: all("architecture-approved", "security-approved")
          next: COMPLETE
      parallel:
        security:
          - condition: security-approved
          - condition: security-needs-fix
        architecture:
          - condition: architecture-approved
          - condition: architecture-needs-fix`, 'entry');

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.concurrency).toBe(2);
    expect(loaded.steps[0]?.parallel?.map((step) => step.name)).toEqual(['architecture', 'security']);
    expect(loaded.steps[0]?.parallel?.find((step) => step.name === 'architecture')?.rules).toMatchObject([
      { condition: { kind: 'semantic', label: 'architecture-approved' } },
      { condition: { kind: 'semantic', label: 'architecture-needs-fix' } },
    ]);
    expect(loaded.steps[0]?.parallel?.find((step) => step.name === 'security')?.rules).toMatchObject([
      { condition: { kind: 'semantic', label: 'security-approved' } },
      { condition: { kind: 'semantic', label: 'security-needs-fix' } },
    ]);
    expect(loaded.steps[0]?.rules).toHaveLength(1);
  });

  it('injects rules after expanding a nested fragment and a parallel child uses', () => {
    writeProjectFragment(projectDir, 'leaf', 'instruction: leaf review\n');
    writeProjectFragment(projectDir, 'reviewers', `name: reviewers
parallel:
  - name: leaf-review
    uses: leaf
`);
    writeProjectFragment(projectDir, 'outer', 'name: composed\nuses: reviewers\n');
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: outer
    rules:
      self:
        - condition: all("approved")
          next: COMPLETE
      parallel:
        leaf-review:
          - condition: approved
          - condition: needs_fix`, 'entry');

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'leaf-review',
      instruction: 'leaf review',
    });
    expect(loaded.steps[0]?.parallel?.[0]?.rules).toHaveLength(2);
  });

  it.each([
    ['plain array', `    rules:
      - condition: done
        next: COMPLETE`],
    ['missing child', `    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: done`],
    ['unknown child', `    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: done
        second:
          - condition: done
        third:
          - condition: done`],
    ['empty child', `    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first: []
        second:
          - condition: done`],
    ['nested child tree', `    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          self:
            - condition: done
          parallel:
            nested:
              - condition: done
        second:
          - condition: done`],
  ])('rejects a parallel caller with %s rules', (_label, rules) => {
    writeProjectFragment(projectDir, 'reviewers', `parallel:
  - name: first
    instruction: first
  - name: second
    instruction: second
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: reviewers
${rules}`, 'entry');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('rejects duplicate final parallel child names before rule injection', () => {
    writeProjectFragment(projectDir, 'reviewers', `parallel:
  - name: duplicate
    instruction: first
  - name: duplicate
    instruction: second
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        duplicate:
          - condition: done`, 'entry');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('rejects an invalid caller-owned rule item condition', () => {
    writeProjectFragment(projectDir, 'reviewers', `parallel:
  - name: first
    instruction: first
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: "all("`, 'entry');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('remaps contextual schema errors to the caller rule-tree path', () => {
    writeProjectFragment(projectDir, 'reviewers', `parallel:
  - name: first
    instruction: first
`);
    const workflowPath = writeWorkflow(projectDir, 'ownership', `  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: all("approved")`, 'entry');

    try {
      loadWorkflowFromFile(workflowPath, projectDir);
      throw new Error('Expected load to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const zodError = error as ZodError;
      const issuePaths = zodError.issues.map((issue) => issue.path);
      expect(issuePaths).toContainEqual(['steps', 0, 'rules', 'parallel', 'first', 0, 'condition']);
      expect(issuePaths).not.toContainEqual(['steps', 0, 'parallel', 0, 'rules', 0, 'condition']);
    }
  });
});
