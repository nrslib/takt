import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function workflow(steps: string, initialStep = 'entry'): string {
  return `name: ownership
initial_step: ${initialStep}
max_steps: 3
steps:
${steps}
`;
}

describe('workflow step fragment rule ownership', () => {
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-fragment-rule-owner-project-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-fragment-rule-owner-config-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('loads a non-parallel fragment with caller-owned rules', () => {
    write(projectDir, '.takt/steps/body.yaml', 'name: fragment-name\ninstruction: review\n');
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: body
    rules:
      - condition: done
        next: COMPLETE`));

    const loaded = loadWorkflowFromFile(path, projectDir);

    expect(loaded.steps[0]).toMatchObject({
      name: 'entry',
      instruction: 'review',
      rules: [{ condition: { kind: 'semantic', label: 'done' }, next: 'COMPLETE' }],
    });
  });

  it('rejects fragment-owned rules for a caller-owned fragment expansion', () => {
    write(projectDir, '.takt/steps/body.yaml', `instruction: review
rules:
  - condition: fragment-owned
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: body
    rules:
      - condition: caller-owned
        next: COMPLETE`));

    expect(() => loadWorkflowFromFile(path, projectDir))
      .toThrow('define rules on each concrete workflow step that uses the fragment');
  });

  it.each([
    ['missing', ''],
    ['empty', '    rules: []\n'],
  ])('rejects %s caller rules', (_label, rules) => {
    write(projectDir, '.takt/steps/body.yaml', 'instruction: review\n');
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: body
${rules}`.trimEnd()));

    expect(() => loadWorkflowFromFile(path, projectDir)).toThrow();
  });

  it('injects a rule tree by final child name while preserving fragment order and concurrency', () => {
    write(projectDir, '.takt/steps/reviewers.yaml', `name: reviewers
concurrency: 2
parallel:
  - name: architecture
    instruction: architecture review
  - name: security
    instruction: security review
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
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
          - condition: architecture-needs-fix`));

    const loaded = loadWorkflowFromFile(path, projectDir);

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
    write(projectDir, '.takt/steps/leaf.yaml', 'instruction: leaf review\n');
    write(projectDir, '.takt/steps/reviewers.yaml', `name: reviewers
parallel:
  - name: leaf-review
    uses: leaf
`);
    write(projectDir, '.takt/steps/outer.yaml', 'name: composed\nuses: reviewers\n');
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: outer
    rules:
      self:
        - condition: all("approved")
          next: COMPLETE
      parallel:
        leaf-review:
          - condition: approved
          - condition: needs_fix`));

    const loaded = loadWorkflowFromFile(path, projectDir);

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
    write(projectDir, '.takt/steps/reviewers.yaml', `parallel:
  - name: first
    instruction: first
  - name: second
    instruction: second
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: reviewers
${rules}`));

    expect(() => loadWorkflowFromFile(path, projectDir)).toThrow();
  });

  it('rejects duplicate final parallel child names before rule injection', () => {
    write(projectDir, '.takt/steps/reviewers.yaml', `parallel:
  - name: duplicate
    instruction: first
  - name: duplicate
    instruction: second
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        duplicate:
          - condition: done`));

    expect(() => loadWorkflowFromFile(path, projectDir)).toThrow();
  });

  it('rejects an invalid caller-owned rule item condition', () => {
    write(projectDir, '.takt/steps/reviewers.yaml', `parallel:
  - name: first
    instruction: first
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: "all("
`));

    expect(() => loadWorkflowFromFile(path, projectDir)).toThrow();
  });

  it('remaps contextual schema errors to the caller rule-tree path', () => {
    write(projectDir, '.takt/steps/reviewers.yaml', `parallel:
  - name: first
    instruction: first
`);
    const path = write(projectDir, '.takt/workflows/default.yaml', workflow(`  - name: entry
    uses: reviewers
    rules:
      self:
        - condition: done
          next: COMPLETE
      parallel:
        first:
          - condition: all("approved")
`));

    try {
      loadWorkflowFromFile(path, projectDir);
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
