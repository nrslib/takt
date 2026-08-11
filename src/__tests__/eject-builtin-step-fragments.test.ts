import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ejectBuiltin } from '../features/config/ejectBuiltin.js';
import { writeNewEjectedFile } from '../features/config/ejectStepFragments.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';

describe('ejectBuiltin step fragments', () => {
  let globalConfigDir: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-eject-global-'));
    projectDir = mkdtempSync(join(tmpdir(), 'takt-eject-project-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: en\n');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(globalConfigDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('should load an ejected builtin workflow that uses a workflow_call step fragment', async () => {
    await ejectBuiltin('review-fix-default', { projectDir });

    const workflowPath = join(projectDir, '.takt', 'workflows', 'review-fix-default.yaml');
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).not.toThrow();
  });

  it('should reject dangling symlink targets without writing outside the project', async () => {
    const outsideWorkflowPath = join(projectDir, 'outside-workflow.yaml');
    const outsideFragmentPath = join(projectDir, 'outside-fragment.yaml');
    const workflowTarget = join(projectDir, '.takt', 'workflows', 'review-fix-default.yaml');
    const fragmentTarget = join(projectDir, '.takt', 'steps', 'review-gather-with-clarification-to-reviewers.yaml');
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'steps'), { recursive: true });
    symlinkSync(outsideWorkflowPath, workflowTarget);

    await expect(ejectBuiltin('review-fix-default', { projectDir })).rejects.toThrow('Eject target file must not be a symlink');
    expect(existsSync(outsideWorkflowPath)).toBe(false);

    rmSync(workflowTarget);
    symlinkSync(outsideFragmentPath, fragmentTarget);

    await expect(ejectBuiltin('review-fix-default', { projectDir })).rejects.toThrow('Eject target file must not be a symlink');
    expect(existsSync(outsideFragmentPath)).toBe(false);
  });

  it('rejects a symlinked intermediate eject directory', () => {
    const outsideDir = join(projectDir, 'outside');
    const linkedTaktDir = join(projectDir, '.takt');
    rmSync(linkedTaktDir, { recursive: true, force: true });
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, linkedTaktDir);

    expect(() => writeNewEjectedFile(
      projectDir,
      join(linkedTaktDir, 'workflows', 'default.yaml'),
      'name: default\n',
    )).toThrow(`Eject target directory must not be a symlink: ${linkedTaktDir}`);
    expect(existsSync(join(outsideDir, 'workflows', 'default.yaml'))).toBe(false);
  });
});
