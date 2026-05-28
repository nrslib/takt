import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupPreparedRetryTaskSpec,
  prepareRetryTaskSpecWithAttachments,
} from '../features/tasks/list/retryTaskSpecAttachments.js';
import type { TaskAttachment } from '../features/tasks/attachments.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-retry-attachments-test-'));
  tempRoots.add(root);
  return root;
}

function createAttachment(root: string, content: string): TaskAttachment {
  const tempDir = path.join(root, 'tmp-attachments');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, 'image-1.png');
  fs.writeFileSync(tempPath, content, 'utf-8');
  return {
    placeholder: '[Image #1]',
    tempPath,
    fileName: 'image-1.png',
  };
}

describe('prepareRetryTaskSpecWithAttachments', () => {
  it('should copy existing task_dir attachments and renumber newly pasted images', () => {
    const projectDir = createTempRoot();
    const sourceTaskDirRelative = '.takt/tasks/source-task';
    const sourceTaskDir = path.join(projectDir, sourceTaskDirRelative);
    fs.mkdirSync(path.join(sourceTaskDir, 'attachments'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceTaskDir, 'order.md'),
      [
        'Original task with [Image #1].',
        '',
        '## 添付画像',
        '',
        '- [Image #1]: `attachments/image-1.png`',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(sourceTaskDir, 'attachments', 'image-1.png'), 'old-image', 'utf-8');
    const attachment = createAttachment(projectDir, 'new-image');

    const prepared = prepareRetryTaskSpecWithAttachments(
      projectDir,
      'display-only content',
      'Use [Image #1].',
      [attachment],
      sourceTaskDirRelative,
    );

    expect(prepared).toBeDefined();
    if (!prepared) {
      throw new Error('Prepared retry task spec is required.');
    }
    const preparedTaskDir = prepared.taskDir;
    const orderContent = fs.readFileSync(path.join(preparedTaskDir, 'order.md'), 'utf-8');
    expect(orderContent).toContain('Original task with [Image #1].');
    expect(orderContent).toContain('Use [Image #2].');
    expect(orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(orderContent).toContain('- [Image #2]: `attachments/image-2.png`');
    expect(fs.readFileSync(path.join(preparedTaskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('old-image');
    expect(fs.readFileSync(path.join(preparedTaskDir, 'attachments', 'image-2.png'), 'utf-8')).toBe('new-image');

    cleanupPreparedRetryTaskSpec(prepared);
  });

  it('should renumber newly pasted images against existing content without task_dir', () => {
    const projectDir = createTempRoot();
    const attachment = createAttachment(projectDir, 'new-image');

    const prepared = prepareRetryTaskSpecWithAttachments(
      projectDir,
      [
        'Original task with [Image #1].',
        '',
        '## 添付画像',
        '',
        '- [Image #1]: `attachments/image-1.png`',
      ].join('\n'),
      'Use [Image #1].',
      [attachment],
    );

    expect(prepared).toBeDefined();
    if (!prepared) {
      throw new Error('Prepared retry task spec is required.');
    }
    const orderContent = fs.readFileSync(path.join(prepared.taskDir, 'order.md'), 'utf-8');
    expect(orderContent).toContain('Original task with [Image #1].');
    expect(orderContent).toContain('Use [Image #2].');
    expect(orderContent).toContain('- [Image #2]: `attachments/image-2.png`');
    expect(fs.readFileSync(path.join(prepared.taskDir, 'attachments', 'image-2.png'), 'utf-8')).toBe('new-image');

    cleanupPreparedRetryTaskSpec(prepared);
  });

  it('should reject symlinked task_dir order.md before preparing retry attachments', () => {
    const projectDir = createTempRoot();
    const sourceTaskDirRelative = '.takt/tasks/source-task';
    const sourceTaskDir = path.join(projectDir, sourceTaskDirRelative);
    const linkedOrderPath = path.join(projectDir, 'linked-order.md');
    const attachment = createAttachment(projectDir, 'new-image');
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(linkedOrderPath, 'External order', 'utf-8');
    fs.symlinkSync(linkedOrderPath, path.join(sourceTaskDir, 'order.md'));

    expect(() =>
      prepareRetryTaskSpecWithAttachments(
        projectDir,
        'display-only content',
        'Use [Image #1].',
        [attachment],
        sourceTaskDirRelative,
      )).toThrow(`Task spec file must be a regular file: ${path.join(sourceTaskDir, 'order.md')}`);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toEqual(['source-task']);
  });
});
