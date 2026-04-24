import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunContextOrderContent } from '../core/workflow/run/order-content.js';
import { stageTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-task-spec-context-test-'));
  tempRoots.add(root);
  return root;
}

describe('stageTaskSpecForExecution', () => {
  it('run コンテキストへ order.md を配置し、task 指示文を返す', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    const orderContent = '# Task\n\nImplement exactly this.';
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), orderContent, 'utf-8');

    const { taskPrompt, orderContent: stagedOrderContent } = stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task');
    const stagedOrderPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'order.md');

    expect(taskPrompt).toContain('Implement using only the files in `.takt/runs/20260216-spec-task/context/task`.');
    expect(taskPrompt).toContain('Primary spec: `.takt/runs/20260216-spec-task/context/task/order.md`.');
    expect(stagedOrderContent).toBe(orderContent);
    expect(fs.readFileSync(stagedOrderPath, 'utf-8')).toBe(orderContent);
  });

  it('symlink の order.md は拒否する', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    const linkedOrderPath = path.join(projectCwd, 'linked-order.md');
    const orderContent = '# Task\n\nFollow the linked spec.';
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(linkedOrderPath, orderContent, 'utf-8');
    fs.symlinkSync(linkedOrderPath, path.join(sourceTaskDir, 'order.md'));

    const stagedOrderPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'order.md');

    expect(() => stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task')).toThrow(
      `Task spec file must be a regular file: ${path.join(sourceTaskDir, 'order.md')}`,
    );
    expect(fs.existsSync(stagedOrderPath)).toBe(false);
  });
});

describe('readRunContextOrderContent', () => {
  it('run コンテキストに order.md がない場合は undefined を返す', () => {
    const root = createTempProjectDir();

    const result = readRunContextOrderContent(root, '20260216-missing-order');

    expect(result).toBeUndefined();
  });

  it('run コンテキストに order.md が存在する場合は全文を返す', () => {
    const root = createTempProjectDir();
    const reportDirName = '20260216-task-order-content';
    const runTaskDir = path.join(root, '.takt', 'runs', reportDirName, 'context', 'task');
    const orderContent = '# Task\n\nImplement exactly this.';
    fs.mkdirSync(runTaskDir, { recursive: true });
    fs.writeFileSync(path.join(runTaskDir, 'order.md'), orderContent, 'utf-8');

    const result = readRunContextOrderContent(root, reportDirName);

    expect(result).toBe(orderContent);
  });

  it('order.md の読み込みで I/O エラーが発生した場合は undefined を返す', () => {
    const root = createTempProjectDir();
    const reportDirName = '20260216-task-order-read-error';
    const runTaskDir = path.join(root, '.takt', 'runs', reportDirName, 'context', 'task');
    fs.mkdirSync(runTaskDir, { recursive: true });
    fs.mkdirSync(path.join(runTaskDir, 'order.md'));

    const result = readRunContextOrderContent(root, reportDirName);

    expect(result).toBeUndefined();
  });

  it('指定 run の order.md が存在しない場合は undefined を返す', () => {
    const root = createTempProjectDir();
    const reportDirName = '20260216-task-missing-order';
    fs.mkdirSync(path.join(root, '.takt', 'runs', reportDirName, 'context', 'task'), { recursive: true });

    const result = readRunContextOrderContent(root, '20260216-other-run');

    expect(result).toBeUndefined();
  });
});
