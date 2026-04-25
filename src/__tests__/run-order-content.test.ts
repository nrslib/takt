import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRunContextOrderContent } from '../core/workflow/run/order-content.js';

const tempRoots = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-run-order-content-test-'));
  tempRoots.add(root);
  return root;
}

describe('readRunContextOrderContent', () => {
  it('run コンテキストから order.md を読む', () => {
    const root = createTempProjectDir();
    const slug = '20260216-run-order';
    const orderPath = path.join(root, '.takt', 'runs', slug, 'context', 'task', 'order.md');
    fs.mkdirSync(path.dirname(orderPath), { recursive: true });
    fs.writeFileSync(orderPath, '# Task\n\nImplement exactly this.', 'utf-8');

    const result = readRunContextOrderContent(root, slug);

    expect(result).toBe('# Task\n\nImplement exactly this.');
  });

  it('不正な slug では .takt/runs 配下の外を読まない', () => {
    const root = createTempProjectDir();
    const escapedOrderPath = path.join(root, '.takt', 'escaped-run', 'context', 'task', 'order.md');
    fs.mkdirSync(path.dirname(escapedOrderPath), { recursive: true });
    fs.writeFileSync(escapedOrderPath, '# Escaped Task\n\nShould not be readable.', 'utf-8');

    const result = readRunContextOrderContent(root, '../escaped-run');

    expect(result).toBeUndefined();
  });

  it('読み込み失敗時は onError を呼んで undefined を返す', () => {
    const root = createTempProjectDir();
    const slug = '20260216-run-order-error';
    const orderPath = path.join(root, '.takt', 'runs', slug, 'context', 'task', 'order.md');
    fs.mkdirSync(orderPath, { recursive: true });

    const onError = vi.fn();

    const result = readRunContextOrderContent(root, slug, { onError });

    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(orderPath);
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('symlink 化した run directory 経由の order.md を読まない', () => {
    const root = createTempProjectDir();
    const slug = '20260216-linked-run';
    const escapedRunDir = path.join(root, '.takt', 'escaped-run');
    const linkedRunDir = path.join(root, '.takt', 'runs', slug);
    const escapedOrderPath = path.join(escapedRunDir, 'context', 'task', 'order.md');
    fs.mkdirSync(path.dirname(escapedOrderPath), { recursive: true });
    fs.writeFileSync(escapedOrderPath, '# Escaped Task\n\nShould not be readable.', 'utf-8');
    fs.mkdirSync(path.dirname(linkedRunDir), { recursive: true });
    fs.symlinkSync(escapedRunDir, linkedRunDir, 'dir');

    const result = readRunContextOrderContent(root, slug);

    expect(result).toBeUndefined();
  });

  it('symlink 化した order.md を読まない', () => {
    const root = createTempProjectDir();
    const slug = '20260216-linked-order';
    const runTaskDir = path.join(root, '.takt', 'runs', slug, 'context', 'task');
    const escapedOrderPath = path.join(root, '.takt', 'escaped-order.md');
    fs.mkdirSync(runTaskDir, { recursive: true });
    fs.writeFileSync(escapedOrderPath, '# Escaped Task\n\nShould not be readable.', 'utf-8');
    fs.symlinkSync(escapedOrderPath, path.join(runTaskDir, 'order.md'), 'file');

    const result = readRunContextOrderContent(root, slug);

    expect(result).toBeUndefined();
  });
});
