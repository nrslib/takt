import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOrderAttachmentContent,
  persistTaskOrderRevision,
  resolveTaskOrderContent,
} from '../features/tasks/orderRevision.js';

const { renameFailure } = vi.hoisted(() => ({ renameFailure: { enabled: false } }));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    renameSync: (...args: Parameters<typeof original.renameSync>) => {
      if (renameFailure.enabled) {
        throw new Error('replacement failed');
      }
      return original.renameSync(...args);
    },
  };
});

const temporaryProjects: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-order-revision-'));
  temporaryProjects.push(projectDir);
  return projectDir;
}

afterEach(() => {
  renameFailure.enabled = false;
  for (const projectDir of temporaryProjects.splice(0)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

describe('task order revision contract', () => {
  it('reads the current task_dir/order.md instead of a run copy', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'order.md'), '# Canonical\n\nKeep this.');

    expect(resolveTaskOrderContent(
      projectDir,
      '.takt/tasks/example-task',
      'legacy fallback',
    )).toBe('# Canonical\n\nKeep this.');
  });

  it('archives and atomically replaces the canonical order on approval', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    fs.mkdirSync(taskDir, { recursive: true });
    const orderPath = path.join(taskDir, 'order.md');
    fs.writeFileSync(orderPath, '# Old order');

    const persisted = persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order\n\nComplete replacement.',
    );

    expect(persisted.created).toBe(false);
    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# New order\n\nComplete replacement.');
    const archives = fs.readdirSync(taskDir)
      .filter((entry) => entry.startsWith('order.md.'));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(taskDir, archives[0]!), 'utf-8')).toBe('# Old order');
  });

  it('keeps attachment placeholders and saved attachment paths in the proposal', () => {
    const projectDir = makeProject();
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };
    const proposal = ensureOrderAttachmentContent(
      'Use [Image #1].\n\n## 添付画像\n\n- [Image #1]: `attachments/wrong.png`',
      [attachment],
    );
    expect(proposal).toContain('[Image #1]');
    expect(proposal).toContain('attachments/image-1.png');
    expect(proposal).not.toContain('attachments/wrong.png');

    const persisted = persistTaskOrderRevision(projectDir, undefined, proposal, [attachment]);
    expect(persisted.created).toBe(true);
    expect(fs.readFileSync(path.join(persisted.taskDir!, 'order.md'), 'utf-8')).toBe(proposal);
    expect(fs.existsSync(path.join(persisted.taskDir!, 'attachments/image-1.png'))).toBe(true);
  });

  it('keeps the current order and removes newly promoted attachments when replacement fails', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    fs.mkdirSync(taskDir, { recursive: true });
    const orderPath = path.join(taskDir, 'order.md');
    fs.writeFileSync(orderPath, '# Old order');
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };
    renameFailure.enabled = true;

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order',
      [attachment],
    )).toThrow('replacement failed');

    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });

  it('rolls an approved existing-task revision back when the task record update fails', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    fs.mkdirSync(taskDir, { recursive: true });
    const orderPath = path.join(taskDir, 'order.md');
    fs.writeFileSync(orderPath, '# Old order');
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };

    const revision = persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order\n\nUse [Image #1].',
      [attachment],
    );
    revision.rollback();

    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });
});
