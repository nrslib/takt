import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function workflow(uses: string, childName: string, override = ''): string {
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

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

describe('workflow step fragment parallel resolution', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-parallel-fragment-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-parallel-fragment-global-'));
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

  it('resolves a nested parallel reference from the fragment definition scope', () => {
    writeFile(globalConfigDir, 'steps/reviewers.yaml', [
      'parallel:',
      '  - uses: reviewer',
      '',
    ].join('\n'));
    writeFile(globalConfigDir, 'steps/reviewer.yaml', [
      'name: global-reviewer',
      'instruction: global review',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'name: project-reviewer',
      'instruction: project review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', 'global-reviewer'));

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'global-reviewer',
      instruction: 'global review',
    });
  });

  it('uses the caller scope when the caller replaces a fragment parallel array', () => {
    writeFile(globalConfigDir, 'steps/reviewers.yaml', [
      'parallel:',
      '  - uses: discarded-reviewer',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'name: project-reviewer',
      'instruction: project review',
      '',
    ].join('\n'));
    writeFile(globalConfigDir, 'steps/reviewer.yaml', [
      'name: global-reviewer',
      'instruction: global review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', 'project-reviewer', [
      'parallel:',
      '  - uses: reviewer',
      '    rules:',
      '      - condition: done',
    ].join('\n')));

    const loaded = loadWorkflowFromFile(workflowPath, projectDir);

    expect(loaded.steps[0]?.parallel?.[0]).toMatchObject({
      name: 'project-reviewer',
      instruction: 'project review',
    });
  });

  it('rejects a circular reference reached through a fragment parallel sub-step', () => {
    writeFile(globalConfigDir, 'steps/reviewers.yaml', [
      'parallel:',
      '  - uses: reviewers',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', 'cycle'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular step fragment reference "reviewers"');
    expect(message).not.toContain('maximum expansion');
  });

  it('does not resolve a discarded fragment parallel array', () => {
    writeFile(globalConfigDir, 'steps/reviewers.yaml', [
      'parallel:',
      '  - uses: missing-reviewer',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', 'inline-reviewer', [
      'parallel:',
      '  - name: inline-reviewer',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n')));

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
    writeFile(projectDir, '.takt/steps/architecture.yaml', [
      'name: architecture',
      'persona: architecture-reviewer',
      'policy: [architecture-policy]',
      'knowledge: [architecture-domain]',
      'instruction: Review architecture',
      'provider: codex',
      'model: gpt-architecture',
      'provider_options:',
      '  codex:',
      '    reasoning_effort: medium',
      'output_contracts:',
      '  report:',
      '    - name: architecture-review.md',
      '      format: review',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/frontend.yaml', [
      'name: frontend',
      'persona: frontend-reviewer',
      'policy: [frontend-policy]',
      'knowledge: [frontend-domain]',
      'instruction: Review frontend implementation',
      'provider: codex',
      'model: gpt-frontend',
      'provider_options:',
      '  codex:',
      '    reasoning_effort: high',
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
        providerOptions?: { codex?: { reasoningEffort?: string } };
        rules: unknown[];
      }>;
      selection: { mode: string };
    };

    expect(parallel).toMatchObject({
      fixed: [{
        name: 'architecture',
        persona: 'architecture-reviewer',
        personaPath: join(projectDir, '.takt/facets/personas/architecture-reviewer.md'),
        policyContents: ['Architecture policy contract'],
        knowledgeContents: ['Architecture knowledge contract'],
        instruction: 'Review architecture',
        provider: 'codex',
        model: 'gpt-architecture',
        providerOptions: { codex: { reasoningEffort: 'medium' } },
        outputContracts: [{ name: 'architecture-review.md', format: 'Return the reviewer report.' }],
        rules: [{ condition: { kind: 'semantic', label: 'approved' }, next: 'COMPLETE' }],
      }],
      pool: [{
        name: 'frontend',
        description: 'Review frontend changes',
        persona: 'frontend-reviewer',
        personaPath: join(projectDir, '.takt/facets/personas/frontend-reviewer.md'),
        policyContents: ['Frontend policy contract'],
        knowledgeContents: ['Frontend knowledge contract'],
        instruction: 'Review frontend implementation',
        provider: 'codex',
        model: 'gpt-frontend',
        providerOptions: { codex: { reasoningEffort: 'high' } },
        outputContracts: [{ name: 'frontend-review.md', format: 'Return the reviewer report.' }],
        rules: [{ condition: { kind: 'semantic', label: 'approved' }, next: 'COMPLETE' }],
      }],
      selection: { mode: 'replace' },
    });
  });

  it('applies caller-owned rules to dynamic participants inside a parent fragment', () => {
    writeFile(projectDir, '.takt/steps/architecture.yaml', [
      'name: architecture',
      'instruction: Review architecture',
      'provider: codex',
      'model: gpt-test',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/frontend.yaml', [
      'name: frontend',
      'instruction: Review frontend',
      'provider_options:',
      '  codex:',
      '    reasoning_effort: high',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/dynamic-reviewers.yaml', [
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
      provider: 'codex',
      model: 'gpt-test',
      rules: [{ condition: { kind: 'semantic', label: 'approved' } }],
    }]);
    expect(parallel.pool).toMatchObject([{
      name: 'frontend',
      description: 'Review frontend changes',
      providerOptions: { codex: { reasoningEffort: 'high' } },
      rules: [{ condition: { kind: 'semantic', label: 'approved' } }],
    }]);
  });

  it('rejects rules owned by a fragment used as a dynamic participant', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
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
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
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
    writeFile(projectDir, '.takt/steps/fixed-review.yaml', [
      'name: duplicate-review',
      'instruction: Review architecture',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/pool-review.yaml', [
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
});
