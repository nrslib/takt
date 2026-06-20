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
    const sourceOrderContent = '# Task\n\nImplement exactly this.';
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), sourceOrderContent, 'utf-8');

    const { taskPrompt, orderContent, stagedOrderContent } = stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task');
    const stagedOrderPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'order.md');

    expect(taskPrompt).toContain('Implement using only the files in `.takt/runs/20260216-spec-task/context/task`.');
    expect(taskPrompt).toContain('Primary spec: `.takt/runs/20260216-spec-task/context/task/order.md`.');
    expect(orderContent).toBe(sourceOrderContent);
    expect(stagedOrderContent).toBe(sourceOrderContent);
    expect(fs.readFileSync(stagedOrderPath, 'utf-8')).toBe(sourceOrderContent);
  });

  it('run コンテキストへ task 添付画像を配置する', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    const orderContent = [
      '# Task',
      '',
      'Use [Image #1] (`attachments/image-1.png`) as the reference.',
      '',
      '## 添付画像',
      '',
      '- [Image #1]: `attachments/image-1.png`',
    ].join('\n');
    fs.mkdirSync(path.join(sourceTaskDir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), orderContent, 'utf-8');
    fs.writeFileSync(path.join(sourceTaskDir, 'attachments', 'image-1.png'), 'png-data', 'utf-8');

    const result = stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task');
    const stagedAttachmentPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'attachments', 'image-1.png');
    const stagedOrderContent = fs.readFileSync(path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'order.md'), 'utf-8');

    expect(result.taskPrompt).toContain('Primary spec: `.takt/runs/20260216-spec-task/context/task/order.md`.');
    expect(result.orderContent).toContain('Use [Image #1] (`attachments/image-1.png`) as the reference.');
    expect(result.orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(result.stagedOrderContent).toContain('Use [Image #1] (`.takt/runs/20260216-spec-task/context/task/attachments/image-1.png`) as the reference.');
    expect(result.stagedOrderContent).toContain('- [Image #1]: `.takt/runs/20260216-spec-task/context/task/attachments/image-1.png`');
    expect(stagedOrderContent).toContain('Use [Image #1] (`.takt/runs/20260216-spec-task/context/task/attachments/image-1.png`) as the reference.');
    expect(stagedOrderContent).toContain('- [Image #1]: `.takt/runs/20260216-spec-task/context/task/attachments/image-1.png`');
    expect(fs.readFileSync(stagedAttachmentPath, 'utf-8')).toBe('png-data');
  });

  it('裸の attachments path も run コンテキスト path へ書き換える', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    const orderContent = [
      '# Task',
      '',
      'Use attachments/image-1.png as the reference.',
      '',
      '- [Image #1]: attachments/image-1.png',
    ].join('\n');
    fs.mkdirSync(path.join(sourceTaskDir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), orderContent, 'utf-8');
    fs.writeFileSync(path.join(sourceTaskDir, 'attachments', 'image-1.png'), 'png-data', 'utf-8');

    const result = stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task');

    expect(result.orderContent).toContain('Use attachments/image-1.png as the reference.');
    expect(result.orderContent).toContain('- [Image #1]: attachments/image-1.png');
    expect(result.stagedOrderContent).toContain('Use `.takt/runs/20260216-spec-task/context/task/attachments/image-1.png` as the reference.');
    expect(result.stagedOrderContent).toContain('- [Image #1]: `.takt/runs/20260216-spec-task/context/task/attachments/image-1.png`');
  });

  it('task 添付 path が attachments 外へ出る場合は拒否する', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), 'Use `attachments/../secret.png`.', 'utf-8');

    expect(() => stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task')).toThrow(
      'Invalid task attachment path: attachments/../secret.png',
    );
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

  it('symlink の attachments ディレクトリは拒否する', () => {
    const projectCwd = createTempProjectDir();
    const execCwd = createTempProjectDir();
    const taskDir = '.takt/tasks/spec-task';
    const sourceTaskDir = path.join(projectCwd, taskDir);
    const externalAttachmentDir = path.join(projectCwd, 'external-attachments');
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.mkdirSync(externalAttachmentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), '# Task\n\nUse [Image #1].', 'utf-8');
    fs.writeFileSync(path.join(externalAttachmentDir, 'image-1.png'), 'outside-data', 'utf-8');
    fs.symlinkSync(externalAttachmentDir, path.join(sourceTaskDir, 'attachments'));

    const stagedAttachmentPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'attachments', 'image-1.png');
    const stagedOrderPath = path.join(execCwd, '.takt', 'runs', '20260216-spec-task', 'context', 'task', 'order.md');
    const stagedTaskDir = path.dirname(stagedOrderPath);

    expect(() => stageTaskSpecForExecution(projectCwd, execCwd, taskDir, '20260216-spec-task')).toThrow(/Task attachments/);
    expect(fs.existsSync(stagedTaskDir)).toBe(false);
    expect(fs.existsSync(stagedOrderPath)).toBe(false);
    expect(fs.existsSync(stagedAttachmentPath)).toBe(false);
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
