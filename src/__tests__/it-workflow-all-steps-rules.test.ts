import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...actual,
    getBuiltinWorkflowsDir: () => (
      process.env.TAKT_TEST_BUILTIN_WORKFLOWS_DIR ?? actual.getBuiltinWorkflowsDir('en')
    ),
  };
});

type ResolvedAllStepsRule = {
  readonly ref: string;
  readonly position: 'after_execution_rules' | 'before_instruction';
  readonly content: string;
};

type WorkflowWithAllStepsRules = {
  readonly allStepsRules?: readonly ResolvedAllStepsRule[];
};

function resolvedRules(workflow: unknown): readonly ResolvedAllStepsRule[] | undefined {
  return (workflow as WorkflowWithAllStepsRules).allStepsRules;
}

function workflowYaml(name: string, refs: readonly string[]): string {
  return `name: ${name}
initial_step: work
max_steps: 1
all_steps:
  rules:
${refs.map((ref) => `    - ${ref}`).join('\n')}
steps:
  - name: work
    persona: coder
    instruction: Work
`;
}

describe('workflow-wide rule loading', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let builtinWorkflowsDir: string;
  let previousConfigDir: string | undefined;
  let previousBuiltinWorkflowsDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    previousBuiltinWorkflowsDir = process.env.TAKT_TEST_BUILTIN_WORKFLOWS_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-all-steps-rules-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-all-steps-rules-global-'));
    builtinWorkflowsDir = mkdtempSync(join(tmpdir(), 'takt-all-steps-rules-builtin-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    process.env.TAKT_TEST_BUILTIN_WORKFLOWS_DIR = builtinWorkflowsDir;
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    if (previousBuiltinWorkflowsDir === undefined) {
      delete process.env.TAKT_TEST_BUILTIN_WORKFLOWS_DIR;
    } else {
      process.env.TAKT_TEST_BUILTIN_WORKFLOWS_DIR = previousBuiltinWorkflowsDir;
    }
    invalidateGlobalConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    rmSync(builtinWorkflowsDir, { recursive: true, force: true });
  });

  it('resolves project rules before global rules and retains normalized positions', () => {
    const projectRulesDir = join(projectDir, '.takt', 'workflows', 'rules');
    const globalRulesDir = join(globalConfigDir, 'workflows', 'rules');
    mkdirSync(projectRulesDir, { recursive: true });
    mkdirSync(globalRulesDir, { recursive: true });
    writeFileSync(join(projectRulesDir, 'shared.md'), 'PROJECT_SHARED', 'utf-8');
    writeFileSync(join(globalRulesDir, 'shared.md'), 'GLOBAL_SHARED', 'utf-8');
    writeFileSync(join(globalRulesDir, 'global-only.md'), 'GLOBAL_ONLY', 'utf-8');

    const workflowPath = join(projectDir, 'rules.yaml');
    writeFileSync(workflowPath, `name: rules-loader
initial_step: work
max_steps: 1
all_steps:
  rules:
    - shared
    - ref: global-only
      position: before_instruction
steps:
  - name: work
    persona: coder
    instruction: Work
`, 'utf-8');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(resolvedRules(workflow)).toEqual([
      { ref: 'shared', position: 'after_execution_rules', content: 'PROJECT_SHARED' },
      { ref: 'global-only', position: 'before_instruction', content: 'GLOBAL_ONLY' },
    ]);
  });

  it('uses project rules for normal workflows and isolated rules only with an explicit resource root', () => {
    const projectRulesDir = join(projectDir, '.takt', 'workflows', 'rules');
    const isolatedRoot = join(projectDir, '.takt', 'make', 'isolated');
    const isolatedWorkflowsDir = join(isolatedRoot, 'workflows');
    const isolatedRulesDir = join(isolatedWorkflowsDir, 'rules');
    mkdirSync(projectRulesDir, { recursive: true });
    mkdirSync(isolatedRulesDir, { recursive: true });
    writeFileSync(join(projectRulesDir, 'shared.md'), 'PROJECT_SHARED', 'utf-8');
    writeFileSync(join(isolatedRulesDir, 'shared.md'), 'ISOLATED_SHARED', 'utf-8');
    const workflowPath = join(isolatedWorkflowsDir, 'rules.yaml');
    writeFileSync(workflowPath, workflowYaml('rules', ['shared']), 'utf-8');

    const normal = loadWorkflowFromFile(workflowPath, projectDir);
    const isolated = loadWorkflowFromFile(workflowPath, projectDir, { resourceRoot: isolatedRoot });

    expect(resolvedRules(normal)?.[0]?.content).toBe('PROJECT_SHARED');
    expect(resolvedRules(isolated)?.[0]?.content).toBe('ISOLATED_SHARED');
  });

  it('fails isolated loading when a rule exists only in the project layer', () => {
    const projectRulesDir = join(projectDir, '.takt', 'workflows', 'rules');
    const isolatedRoot = join(projectDir, '.takt', 'make', 'isolated');
    const isolatedWorkflowsDir = join(isolatedRoot, 'workflows');
    mkdirSync(projectRulesDir, { recursive: true });
    mkdirSync(isolatedWorkflowsDir, { recursive: true });
    writeFileSync(join(projectRulesDir, 'project-only.md'), 'PROJECT_ONLY', 'utf-8');
    const workflowPath = join(isolatedWorkflowsDir, 'rules.yaml');
    writeFileSync(workflowPath, workflowYaml('rules', ['project-only']), 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir, { resourceRoot: isolatedRoot })).toThrow(
      /project-only/,
    );
    expect(() => loadWorkflowFromFile(workflowPath, projectDir, { resourceRoot: isolatedRoot })).toThrow(
      new RegExp(`isolated workflow rules under "${isolatedWorkflowsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    );
    expect(() => loadWorkflowFromFile(workflowPath, projectDir, { resourceRoot: isolatedRoot })).not.toThrow(
      /project, global, or builtin/,
    );
  });

  it('fails at workflow load when a declared rule cannot be resolved', () => {
    const workflowPath = join(projectDir, 'missing-rule.yaml');
    writeFileSync(workflowPath, workflowYaml('missing-rule', ['does-not-exist']), 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(
      /all_steps\.rules\[0\].*does-not-exist|does-not-exist.*all_steps\.rules\[0\]/,
    );
  });

  it('uses the builtin rule layer when project and global layers have no matching ref', () => {
    const builtinRulesDir = join(builtinWorkflowsDir, 'rules');
    mkdirSync(builtinRulesDir, { recursive: true });
    writeFileSync(join(builtinRulesDir, 'builtin-only.md'), 'BUILTIN_ONLY', 'utf-8');
    const workflowPath = join(projectDir, 'builtin-rule.yaml');
    writeFileSync(workflowPath, workflowYaml('builtin-rule', ['builtin-only']), 'utf-8');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(resolvedRules(workflow)).toEqual([
      { ref: 'builtin-only', position: 'after_execution_rules', content: 'BUILTIN_ONLY' },
    ]);
  });

  it.each([
    ['required-output-heading', '**必須出力（見出しを含める）**'],
    ['required-output-heading-with-article', '**Required output (include the headings)**'],
    ['required-output-section', '## 必須出力'],
    ['required-output-decorated-section-en', '## **Required Output**'],
    ['required-output-decorated-section-ja', '## **必須出力**'],
    ['required-output-link-section-en', '## [Required Output](https://example.com/output)'],
    ['required-output-link-section-ja', '## [必須出力](https://example.com/output)'],
    ['required-output-html-section-en', '## Required <strong>Output</strong>'],
    ['required-output-html-section-ja', '## 必須<strong>出力</strong>'],
    ['report-reference', 'Previous result: {report:previous.md}'],
  ])('rejects %s in a rule file and identifies the source file', (ref, content) => {
    const rulesDir = join(projectDir, '.takt', 'workflows', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const rulePath = join(rulesDir, `${ref}.md`);
    writeFileSync(rulePath, content, 'utf-8');
    const workflowPath = join(projectDir, `${ref}.yaml`);
    writeFileSync(workflowPath, workflowYaml(ref, [ref]), 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(
      new RegExp(`all_steps\\.rules\\[0\\].*${ref}\\.md|${ref}\\.md.*all_steps\\.rules\\[0\\]`),
    );
  });
});
