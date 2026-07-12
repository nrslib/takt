import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemStepServicesOptions } from '../core/workflow/system/system-step-services.js';
import {
  captureArtifactsEffect,
  commitArtifactsEffect,
} from '../infra/workflow/system/system-artifact-effects.js';

describe('artifact transition effects', () => {
  let cwd: string;
  let options: SystemStepServicesOptions;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-artifacts-'));
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Takt Test'], { cwd });
    execFileSync('git', ['config', 'user.email', 'takt@example.test'], { cwd });
    writeFileSync(join(cwd, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd });
    options = { cwd, projectCwd: cwd, task: 'test' };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function createPlan(parent = 'specs/phase-42-proof'): void {
    mkdirSync(join(cwd, parent), { recursive: true });
    writeFileSync(join(cwd, parent, 'plan.md'), 'plan\n');
    writeFileSync(join(cwd, parent, 'task.md'), 'task\n');
    writeFileSync(join(cwd, parent, 'test-plan.md'), 'tests\n');
  }

  function capture(manifestPath?: string): Record<string, unknown> {
    return captureArtifactsEffect(options, {
      type: 'capture_artifacts',
      allowedPatterns: [
        'specs/phase-*/plan.md',
        'specs/phase-*/task.md',
        'specs/phase-*/test-plan.md',
      ],
      requiredBasenames: ['plan.md', 'task.md', 'test-plan.md'],
      sameParent: true,
      ...(manifestPath !== undefined ? { manifestPath } : {}),
    });
  }

  it('captures exactly one phase and commits only the captured artifacts', () => {
    createPlan();
    writeFileSync(join(cwd, 'other.md'), 'unrelated\n');
    execFileSync('git', ['add', 'other.md'], { cwd });
    const captured = capture();
    const result = commitArtifactsEffect(options, {
      manifest: captured.manifest,
      message: 'approve plan',
    });

    expect(result.status).toBe('committed');
    const committed = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim().split('\n').sort();
    expect(committed).toEqual([
      'specs/phase-42-proof/plan.md',
      'specs/phase-42-proof/task.md',
      'specs/phase-42-proof/test-plan.md',
    ]);
    expect(execFileSync('git', ['status', '--porcelain', '--', 'other.md'], { cwd, encoding: 'utf8' }))
      .toContain('A  other.md');

    const retry = commitArtifactsEffect(options, {
      manifest: captured.manifest,
      message: 'approve plan',
    });
    expect(retry.status).toBe('already_committed');
  });

  it('rejects more than one complete dirty phase directory', () => {
    createPlan('specs/phase-1-a');
    createPlan('specs/phase-2-b');
    expect(() => capture()).toThrow('could not identify one current artifact parent');
  });

  it('selects the unique complete phase when another phase has one dirty artifact', () => {
    createPlan('specs/phase-1-old');
    execFileSync('git', ['add', 'specs/phase-1-old'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'old plan'], { cwd });
    writeFileSync(join(cwd, 'specs/phase-1-old/plan.md'), 'old changed\n');
    createPlan('specs/phase-2-current');

    const result = capture();
    expect(JSON.stringify(result)).toContain('specs/phase-2-current/plan.md');
    expect(JSON.stringify(result)).not.toContain('specs/phase-1-old/plan.md');
  });

  it('ignores an unrelated rename outside the artifact allow patterns', () => {
    writeFileSync(join(cwd, 'old.md'), 'old\n');
    execFileSync('git', ['add', 'old.md'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd });
    execFileSync('git', ['mv', 'old.md', 'new.md'], { cwd });
    createPlan();

    expect(() => capture()).not.toThrow();
  });

  it('rejects changes made after capture', () => {
    createPlan();
    const captured = capture();
    writeFileSync(join(cwd, 'specs/phase-42-proof/plan.md'), 'changed after review\n');
    expect(() => commitArtifactsEffect(options, {
      manifest: captured.manifest,
      message: 'approve plan',
    })).toThrow('Artifact changed after capture');
  });

  it('persists a task-bound manifest for process restart and rejects another task', () => {
    createPlan();
    capture('.takt/state/plan-artifacts.json');
    const result = commitArtifactsEffect(options, {
      manifestPath: '.takt/state/plan-artifacts.json',
      message: 'approve plan',
    });
    expect(result.status).toBe('committed');

    expect(() => commitArtifactsEffect(
      { ...options, task: 'another task' },
      { manifestPath: '.takt/state/plan-artifacts.json', message: 'wrong task' },
    )).toThrow('different task');
  });

  it('uses the persisted parent to disambiguate a partial replan', () => {
    createPlan('specs/phase-1-current');
    capture('.takt/state/plan-artifacts.json');
    writeFileSync(join(cwd, 'specs/phase-2-unrelated-plan.md'), 'outside allow pattern\n');
    mkdirSync(join(cwd, 'specs/phase-2-other'), { recursive: true });
    writeFileSync(join(cwd, 'specs/phase-2-other/plan.md'), 'other dirty\n');
    writeFileSync(join(cwd, 'specs/phase-1-current/plan.md'), 'current revised\n');

    const result = capture('.takt/state/plan-artifacts.json');
    expect(JSON.stringify(result)).toContain('specs/phase-1-current/plan.md');
  });
});
