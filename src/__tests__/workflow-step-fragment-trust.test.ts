import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { StepFragmentConfigurationError } from '../infra/config/loaders/workflowStepFragmentReader.js';
import {
  captureConfigError,
  writeStepFragmentTestFile as write,
} from './helpers/step-fragment-test-helpers.js';

describe('step fragment trust boundaries', () => {
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-fragment-trust-project-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-fragment-trust-config-'));
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

  it.each([
    ['top-level step', '  - uses: "@owner/repo/unsafe"\n    name: review', 'instruction: review\nallow_git_commit: true\nrules:\n  - condition: done\n    next: COMPLETE\n'],
    ['parallel parent', '  - uses: "@owner/repo/unsafe"\n    name: reviewers', 'allow_git_commit: true\nparallel:\n  - name: review\n    instruction: review\n'],
    ['parallel sub-step', '  - name: reviewers\n    parallel:\n      - uses: "@owner/repo/unsafe"\n        name: review', 'instruction: review\nallow_git_commit: true\n'],
  ])('rejects low-trust allow_git_commit from a %s', (_placement, steps, fragment) => {
    const fragmentPath = write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', fragment);
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
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
    write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', [
      'instruction: review',
      'allow_git_commit: true',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: "@owner/repo/unsafe"',
      '    name: review',
      '    allow_git_commit: false',
      '',
    ].join('\n'));

    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]).toMatchObject({ allowGitCommit: false });
  });

  it('rejects allow_git_commit inherited through nested low-trust fragments', () => {
    const fragmentPath = write(configDir, 'repertoire/@owner/repo/steps/base.yaml', 'instruction: review\nallow_git_commit: true\n');
    write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', 'uses: "@owner/repo/base"\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: "@owner/repo/unsafe"',
      '    name: review',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(`allow_git_commit from step fragment "@owner/repo/base" at ${fragmentPath}`);
  });

  it.each([
    ['workflow_call', 'kind: workflow_call\ncall: child\n', 'workflow_call'],
    ['allow_git_commit', 'instruction: review\nallow_git_commit: true\n', 'allow_git_commit'],
  ])('fails closed for fragment-derived %s without projectDir', (_field, fragment, expected) => {
    const stepsDir = join(projectDir, '.takt', 'steps');
    write(projectDir, '.takt/steps/unsafe.yaml', fragment);

    const error = captureConfigError(() => resolveWorkflowStepFragments({
      steps: [{ uses: 'unsafe' }],
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
