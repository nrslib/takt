import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRunningStepByRunSlug, readRunMeta } from '../core/workflow/run/run-meta.js';

function writeMeta(runRoot: string, slug: string, meta: Record<string, unknown>): void {
  const metaPath = path.join(runRoot, '.takt', 'runs', slug, 'meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

describe('run-meta lookup', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-run-meta-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('should read currentStep from the specified run slug even when meta.task differs', () => {
    writeMeta(projectDir, '20260409-run-b', {
      task: 'Stored from .takt/runs/.../context/task',
      workflow: 'default',
      runSlug: '20260409-run-b',
      runRoot: '.takt/runs/20260409-run-b',
      reportDirectory: '.takt/runs/20260409-run-b/reports',
      contextDirectory: '.takt/runs/20260409-run-b/context',
      logsDirectory: '.takt/runs/20260409-run-b/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Other task prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'review',
      currentIteration: 1,
    });

    const currentStep = findRunningStepByRunSlug(projectDir, '20260409-run-b');

    expect(currentStep).toBe('implement');
    expect(
      readRunMeta(path.join(projectDir, '.takt', 'runs', '20260409-run-b', 'meta.json'))?.currentIteration,
    ).toBe(2);
  });

  it('should ignore unreadable unrelated meta.json when run slug is known', () => {
    const newestMetaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json');
    fs.mkdirSync(path.dirname(newestMetaPath), { recursive: true });
    fs.writeFileSync(newestMetaPath, '{ broken json', 'utf-8');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });

    expect(
      findRunningStepByRunSlug(projectDir, '20260409-run-a'),
    ).toBe('implement');
    expect(readRunMeta(newestMetaPath)).toBeNull();
  });

  it('should return undefined when run slug is invalid', () => {
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-z',
      runRoot: '.takt/runs/20260409-run-z',
      reportDirectory: '.takt/runs/20260409-run-z/reports',
      contextDirectory: '.takt/runs/20260409-run-z/context',
      logsDirectory: '.takt/runs/20260409-run-z/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'wrong-step',
      currentIteration: 9,
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });

    expect(findRunningStepByRunSlug(projectDir, '../20260409-run-a')).toBeUndefined();
  });
});
