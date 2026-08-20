import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOrderAttachmentContent,
  persistTaskOrderRevision,
  resolveTaskOrderContent,
} from '../features/tasks/orderRevision.js';

const { renameFailure, archiveCleanupFailure, archiveCopyFailure, mockWarn } = vi.hoisted(() => ({
  renameFailure: { enabled: false },
  archiveCleanupFailure: { enabled: false },
  archiveCopyFailure: { mode: null as 'conflict' | 'failure' | null },
  mockWarn: vi.fn(),
}));

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
    copyFileSync: (...args: Parameters<typeof original.copyFileSync>) => {
      const destination = args[1];
      if (archiveCopyFailure.mode
        && typeof destination === 'string'
        && path.basename(destination).startsWith('order.md.')) {
        if (archiveCopyFailure.mode === 'conflict') {
          original.writeFileSync(destination, '# Concurrent archive');
        }
        throw new Error(archiveCopyFailure.mode === 'conflict'
          ? 'archive candidate conflict'
          : 'archive copy failed');
      }
      return original.copyFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      const target = args[0];
      if (archiveCleanupFailure.enabled
        && typeof target === 'string'
        && path.basename(target).startsWith('order.md.')) {
        throw new Error('archive cleanup failed');
      }
      return original.rmSync(...args);
    },
  };
});

vi.mock('../shared/ui/index.js', () => ({
  warn: (...args: unknown[]) => mockWarn(...args),
}));

const temporaryProjects: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-order-revision-'));
  temporaryProjects.push(projectDir);
  return projectDir;
}

afterEach(() => {
  renameFailure.enabled = false;
  archiveCleanupFailure.enabled = false;
  archiveCopyFailure.mode = null;
  mockWarn.mockReset();
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

  it('rejects an empty canonical order', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/empty-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'order.md'), '  \n');

    expect(() => resolveTaskOrderContent(
      projectDir,
      '.takt/tasks/empty-task',
      'legacy fallback',
    )).toThrow('Task order is empty');
  });

  it('rejects an invalid task_dir before resolving an order path', () => {
    const projectDir = makeProject();

    expect(() => resolveTaskOrderContent(
      projectDir,
      '.takt/tasks/../outside',
      'legacy fallback',
    )).toThrow('Invalid task_dir format');
  });

  it('rejects a task_dir that is not a directory when persisting', () => {
    const projectDir = makeProject();
    const taskPath = path.join(projectDir, '.takt/tasks/not-a-directory');
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(taskPath, 'not a directory');

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/not-a-directory',
      '# New order',
      'en',
    )).toThrow('Task directory must be a regular directory');
    expect(fs.readFileSync(taskPath, 'utf-8')).toBe('not a directory');
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
      'ja',
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
      'ja',
    );
    expect(proposal).toContain('[Image #1]');
    expect(proposal).toContain('attachments/image-1.png');
    expect(proposal).not.toContain('attachments/wrong.png');

    const persisted = persistTaskOrderRevision(projectDir, undefined, proposal, 'ja', [attachment]);
    expect(persisted.created).toBe(true);
    expect(fs.readFileSync(path.join(persisted.taskDir!, 'order.md'), 'utf-8')).toBe(proposal);
    expect(fs.existsSync(path.join(persisted.taskDir!, 'attachments/image-1.png'))).toBe(true);
  });

  it('preserves an existing task attachment when a revision uses the same file name', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    const existingAttachmentPath = path.join(taskDir, 'attachments/image-1.png');
    const sourcePath = path.join(projectDir, 'image.png');
    fs.mkdirSync(path.dirname(existingAttachmentPath), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'order.md'), '# Old order');
    fs.writeFileSync(existingAttachmentPath, 'existing attachment');
    fs.writeFileSync(sourcePath, 'new attachment');

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order\n\nUse [Image #1].',
      'en',
      [{
        placeholder: '[Image #1]',
        tempPath: sourcePath,
        fileName: 'image-1.png',
      }],
    )).toThrow('Task attachment destination already exists');

    expect(fs.readFileSync(existingAttachmentPath, 'utf-8')).toBe('existing attachment');
    expect(fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8')).toBe('# Old order');
  });

  it('uses the language-specific attachments heading in the proposal', () => {
    const projectDir = makeProject();
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };

    const proposal = ensureOrderAttachmentContent('Use [Image #1].', [attachment], 'en');

    expect(proposal).toContain('## Attachments');
    expect(proposal).not.toContain('## 添付画像');
  });

  it('persists the English attachment heading exactly as approved', () => {
    const projectDir = makeProject();
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };
    const proposal = ensureOrderAttachmentContent('Use [Image #1].', [attachment], 'en');

    const persisted = persistTaskOrderRevision(projectDir, undefined, proposal, 'en', [attachment]);
    const saved = fs.readFileSync(path.join(persisted.taskDir!, 'order.md'), 'utf-8');

    expect(saved).toBe(proposal);
    expect(saved.match(/^## Attachments$/gm)).toHaveLength(1);
    expect(saved).not.toContain('## 添付画像');
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
      'ja',
      [attachment],
    )).toThrow('replacement failed');

    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });

  it('rejects a symlinked canonical order without changing the target or task directory', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/symlinked-order');
    const targetOrderPath = path.join(projectDir, 'target-order.md');
    const orderPath = path.join(taskDir, 'order.md');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(targetOrderPath, '# Old order');
    fs.symlinkSync(targetOrderPath, orderPath);

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/symlinked-order',
      '# New order',
      'en',
    )).toThrow('Task order must be a regular file');

    expect(fs.readFileSync(targetOrderPath, 'utf-8')).toBe('# Old order');
    expect(fs.lstatSync(orderPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(taskDir)).toEqual(['order.md']);
  });

  it('keeps a competing archive when its candidate is claimed before copy completes', () => {
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
    archiveCopyFailure.mode = 'conflict';

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order',
      'ja',
      [attachment],
    )).toThrow('archive candidate conflict');

    const archives = fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(taskDir, archives[0]!), 'utf-8')).toBe('# Concurrent archive');
    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });

  it('keeps existing archives when archive copy fails before ownership is established', () => {
    const projectDir = makeProject();
    const taskDir = path.join(projectDir, '.takt/tasks/example-task');
    fs.mkdirSync(taskDir, { recursive: true });
    const orderPath = path.join(taskDir, 'order.md');
    const existingArchivePath = path.join(taskDir, 'order.md.existing');
    fs.writeFileSync(orderPath, '# Old order');
    fs.writeFileSync(existingArchivePath, '# Existing archive');
    const sourcePath = path.join(projectDir, 'image.png');
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: sourcePath,
      fileName: 'image-1.png',
    };
    archiveCopyFailure.mode = 'failure';

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order',
      'ja',
      [attachment],
    )).toThrow('archive copy failed');

    expect(fs.readFileSync(existingArchivePath, 'utf-8')).toBe('# Existing archive');
    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });

  it('preserves the replacement error and continues cleanup when archive removal fails', () => {
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
    archiveCleanupFailure.enabled = true;

    expect(() => persistTaskOrderRevision(
      projectDir,
      '.takt/tasks/example-task',
      '# New order',
      'ja',
      [attachment],
    )).toThrow('replacement failed');

    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(1);
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
      'ja',
      [attachment],
    );
    revision.rollback();

    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('# Old order');
    expect(fs.readdirSync(taskDir).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
  });

  it('keeps rollback cleanup when restoring the archive fails', () => {
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
      '# New order',
      'ja',
      [attachment],
    );
    renameFailure.enabled = true;

    expect(() => revision.rollback()).not.toThrow();
    expect(fs.readFileSync(orderPath, 'utf-8')).toContain('# New order');
    expect(fs.existsSync(path.join(taskDir, 'attachments/image-1.png'))).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Failed to rollback task order revision'));
  });
});
