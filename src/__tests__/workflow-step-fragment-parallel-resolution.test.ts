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

function workflow(uses: string, override = ''): string {
  return [
    'name: parallel-fragment-resolution',
    'initial_step: reviewers',
    'max_steps: 1',
    'steps:',
    `  - uses: ${uses}`,
    ...(override.length > 0 ? override.split('\n').map((line) => `    ${line}`) : []),
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
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    writeFile(globalConfigDir, 'steps/reviewer.yaml', [
      'name: global-reviewer',
      'instruction: global review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'name: project-reviewer',
      'instruction: project review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers'));

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
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'name: project-reviewer',
      'instruction: project review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    writeFile(globalConfigDir, 'steps/reviewer.yaml', [
      'name: global-reviewer',
      'instruction: global review',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', [
      'parallel:',
      '  - uses: reviewer',
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
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('circular step fragment reference "reviewers"');
    expect(message).not.toContain('maximum expansion');
  });

  it('does not resolve a discarded fragment parallel array', () => {
    writeFile(globalConfigDir, 'steps/reviewers.yaml', [
      'parallel:',
      '  - uses: missing-reviewer',
      'rules:',
      '  - condition: all("done")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/review.yaml', workflow('reviewers', [
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
});
