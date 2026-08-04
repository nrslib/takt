import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { generateExecutionReportDir } from '../core/workflow/run/run-slug.js';
import { readRunContextOrderContent } from '../core/workflow/run/order-content.js';

const tempRoots = new Set<string>();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe('buildRunPaths', () => {
  it('should build run-scoped relative and absolute paths', () => {
    const paths = buildRunPaths('/tmp/project', '20260210-demo-task');

    expect(paths.runRootRel).toBe('.takt/runs/20260210-demo-task');
    expect(paths.reportsRel).toBe('.takt/runs/20260210-demo-task/reports');
    expect(paths.contextTaskRel).toBe('.takt/runs/20260210-demo-task/context/task');
    expect(paths.contextTaskOrderRel).toBe('.takt/runs/20260210-demo-task/context/task/order.md');
    expect(paths.contextKnowledgeRel).toBe('.takt/runs/20260210-demo-task/context/knowledge');
    expect(paths.contextPolicyRel).toBe('.takt/runs/20260210-demo-task/context/policy');
    expect(paths.contextPreviousResponsesRel).toBe('.takt/runs/20260210-demo-task/context/previous_responses');
    expect(paths.logsRel).toBe('.takt/runs/20260210-demo-task/logs');
    expect(paths.operationsRel).toBe('.takt/runs/20260210-demo-task/operations');
    expect(paths.operationJournalRel).toBe('.takt/runs/20260210-demo-task/operations/journal.json');
    expect(paths.findingContractDatabaseRel).toBe(
      '.takt/runs/20260210-demo-task/finding-contract.sqlite',
    );
    expect(paths.metaRel).toBe('.takt/runs/20260210-demo-task/meta.json');

    expect(paths.reportsAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/reports');
    expect(paths.contextTaskAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/context/task');
    expect(paths.contextTaskOrderAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/context/task/order.md');
    expect(paths.operationJournalAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/operations/journal.json');
    expect(paths.findingContractDatabaseAbs).toBe(
      '/tmp/project/.takt/runs/20260210-demo-task/finding-contract.sqlite',
    );
    expect(paths.metaAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/meta.json');
  });

  it('should append namespace under reports and context paths for subworkflows', () => {
    const paths = buildRunPaths('/tmp/project', '20260210-demo-task', ['subworkflows', 'delegate-coding']);

    expect(paths.reportsRel).toBe('.takt/runs/20260210-demo-task/reports/subworkflows/delegate-coding');
    expect(paths.contextRel).toBe('.takt/runs/20260210-demo-task/context/subworkflows/delegate-coding');
    expect(paths.reportsAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/reports/subworkflows/delegate-coding');
    expect(paths.contextKnowledgeAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/context/subworkflows/delegate-coding/knowledge');
  });
});

describe('generateExecutionReportDir', () => {
  it('should keep task execution report names separate from existing run directories', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const root = createTempProjectDir('takt-report-dir-test-');

    const first = generateExecutionReportDir(root, 'Use saved task spec');
    fs.mkdirSync(path.join(root, '.takt', 'runs', first), { recursive: true });
    const second = generateExecutionReportDir(root, 'Use saved task spec');

    expect(second).not.toBe(first);
    expect(second).toBe(`${first}-2`);
  });
});

describe('readRunContextOrderContent', () => {
  it('run コンテキストから order.md を読む', () => {
    const root = createTempProjectDir('takt-run-order-content-test-');
    const slug = '20260216-run-order';
    const orderPath = path.join(root, '.takt', 'runs', slug, 'context', 'task', 'order.md');
    fs.mkdirSync(path.dirname(orderPath), { recursive: true });
    fs.writeFileSync(orderPath, '# Task\n\nImplement exactly this.', 'utf-8');

    const result = readRunContextOrderContent(root, slug);

    expect(result).toBe('# Task\n\nImplement exactly this.');
  });

  it('不正な slug では .takt/runs 配下の外を読まない', () => {
    const root = createTempProjectDir('takt-run-order-content-test-');
    const escapedOrderPath = path.join(root, '.takt', 'escaped-run', 'context', 'task', 'order.md');
    fs.mkdirSync(path.dirname(escapedOrderPath), { recursive: true });
    fs.writeFileSync(escapedOrderPath, '# Escaped Task\n\nShould not be readable.', 'utf-8');

    const result = readRunContextOrderContent(root, '../escaped-run');

    expect(result).toBeUndefined();
  });

  it('読み込み失敗時は onError を呼んで undefined を返す', () => {
    const root = createTempProjectDir('takt-run-order-content-test-');
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
    const root = createTempProjectDir('takt-run-order-content-test-');
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
    const root = createTempProjectDir('takt-run-order-content-test-');
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
