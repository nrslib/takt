/**
 * Tests for loadPreviousOrderContent utility function.
 *
 * Verifies order.md loading from run directories,
 * including happy path, missing slug, and missing file cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPreviousOrderContent } from '../features/interactive/runSessionReader.js';

function createTmpDir(): string {
  const dir = join(tmpdir(), `takt-order-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createRunWithOrder(cwd: string, slug: string, taskContent: string, orderContent: string): void {
  const runDir = join(cwd, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'context', 'task'), { recursive: true });

  const meta = {
    task: taskContent,
    piece: 'default',
    status: 'completed',
    startTime: '2026-02-01T00:00:00.000Z',
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    runSlug: slug,
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
  writeFileSync(join(runDir, 'context', 'task', 'order.md'), orderContent, 'utf-8');
}

function createRunWithoutOrder(cwd: string, slug: string, taskContent: string): void {
  const runDir = join(cwd, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });

  const meta = {
    task: taskContent,
    piece: 'default',
    status: 'completed',
    startTime: '2026-02-01T00:00:00.000Z',
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    runSlug: slug,
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
}

describe('loadPreviousOrderContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return order.md content when run and file exist', () => {
    const taskContent = 'Implement feature X';
    const orderContent = '# Task\n\nImplement feature X with tests.';
    createRunWithOrder(tmpDir, 'run-feature-x', taskContent, orderContent);

    const result = loadPreviousOrderContent(tmpDir, taskContent);

    expect(result).toBe(orderContent);
  });

  it('should return null when no matching run exists', () => {
    const result = loadPreviousOrderContent(tmpDir, 'Non-existent task');

    expect(result).toBeNull();
  });

  it('should return null when run exists but order.md is missing', () => {
    const taskContent = 'Task without order';
    createRunWithoutOrder(tmpDir, 'run-no-order', taskContent);

    const result = loadPreviousOrderContent(tmpDir, taskContent);

    expect(result).toBeNull();
  });

  it('should return null when .takt/runs directory does not exist', () => {
    const emptyDir = join(tmpdir(), `takt-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    const result = loadPreviousOrderContent(emptyDir, 'any task');

    expect(result).toBeNull();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should match the correct run among multiple runs', () => {
    createRunWithOrder(tmpDir, 'run-a', 'Task A', '# Order A');
    createRunWithOrder(tmpDir, 'run-b', 'Task B', '# Order B');

    expect(loadPreviousOrderContent(tmpDir, 'Task A')).toBe('# Order A');
    expect(loadPreviousOrderContent(tmpDir, 'Task B')).toBe('# Order B');
  });
});
