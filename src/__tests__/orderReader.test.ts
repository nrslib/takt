/**
 * Unit tests for orderReader: findPreviousOrderContent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findPreviousOrderContent } from '../features/interactive/orderReader.js';

const TEST_DIR = join(process.cwd(), 'tmp-test-order-reader');

function createRunWithOrder(slug: string, content: string): void {
  const orderDir = join(TEST_DIR, '.takt', 'runs', slug, 'context', 'task');
  mkdirSync(orderDir, { recursive: true });
  writeFileSync(join(orderDir, 'order.md'), content, 'utf-8');
}

function createRunWithoutOrder(slug: string): void {
  const runDir = join(TEST_DIR, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('findPreviousOrderContent', () => {
  it('should return order content when slug is specified and order.md exists', () => {
    createRunWithOrder('20260218-run1', '# Task Order\nDo something');

    const result = findPreviousOrderContent(TEST_DIR, '20260218-run1');

    expect(result).toBe('# Task Order\nDo something');
  });

  it('should return null when slug is specified but order.md does not exist', () => {
    createRunWithoutOrder('20260218-run1');

    const result = findPreviousOrderContent(TEST_DIR, '20260218-run1');

    expect(result).toBeNull();
  });

  it('should return null when slug is specified but run directory does not exist', () => {
    mkdirSync(join(TEST_DIR, '.takt', 'runs'), { recursive: true });

    const result = findPreviousOrderContent(TEST_DIR, 'nonexistent-slug');

    expect(result).toBeNull();
  });

  it('should return null for empty order.md content', () => {
    createRunWithOrder('20260218-run1', '');

    const result = findPreviousOrderContent(TEST_DIR, '20260218-run1');

    expect(result).toBeNull();
  });

  it('should return null for whitespace-only order.md content', () => {
    createRunWithOrder('20260218-run1', '   \n  ');

    const result = findPreviousOrderContent(TEST_DIR, '20260218-run1');

    expect(result).toBeNull();
  });

  it('should find order from latest run when slug is null', () => {
    createRunWithOrder('20260218-run-a', 'First order');
    createRunWithOrder('20260219-run-b', 'Second order');

    const result = findPreviousOrderContent(TEST_DIR, null);

    expect(result).toBe('Second order');
  });

  it('should skip runs without order.md when searching latest', () => {
    createRunWithOrder('20260218-run-a', 'First order');
    createRunWithoutOrder('20260219-run-b');

    const result = findPreviousOrderContent(TEST_DIR, null);

    expect(result).toBe('First order');
  });

  it('should return null when no runs have order.md', () => {
    createRunWithoutOrder('20260218-run-a');
    createRunWithoutOrder('20260219-run-b');

    const result = findPreviousOrderContent(TEST_DIR, null);

    expect(result).toBeNull();
  });

  it('should return null when .takt/runs directory does not exist', () => {
    const result = findPreviousOrderContent(TEST_DIR, null);

    expect(result).toBeNull();
  });
});
