import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInteractiveResultWithAttachments,
  createImageAttachmentStore,
  createImagePasteHandler,
  createSessionImageAttachmentStore,
} from '../features/interactive/imageAttachments.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-image-attachments-test-'));
  tempRoots.add(root);
  return root;
}

describe('createImageAttachmentStore', () => {
  it('should save pasted images under the session tmp attachment directory', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-abc',
    });
    const imageData = Buffer.from('png-data');

    const attachment = await store.saveImage(imageData, 'image/png');

    expect(attachment).toEqual({
      placeholder: '[Image #1]',
      tempPath: path.join(tmpRoot, 'takt', 'session-abc', 'attachments', 'image-1.png'),
      fileName: 'image-1.png',
    });
    expect(fs.readFileSync(attachment.tempPath)).toEqual(imageData);
  });

  it('should assign stable placeholders and relative paths in paste order', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-abc',
    });

    const first = await store.saveImage(Buffer.from('first'), 'image/png');
    const second = await store.saveImage(Buffer.from('second'), 'image/png');

    expect(first.placeholder).toBe('[Image #1]');
    expect(first.fileName).toBe('image-1.png');
    expect(second.placeholder).toBe('[Image #2]');
    expect(second.fileName).toBe('image-2.png');
    expect(store.listAttachments()).toEqual([first, second]);
  });

  it('should create session attachment directories and pasted files with private permissions', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-private',
    });

    const attachment = await store.saveImage(Buffer.from('private'), 'image/png');

    const sessionDir = path.join(tmpRoot, 'takt', 'session-private');
    const attachmentDir = path.join(sessionDir, 'attachments');
    expect(fs.statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(attachmentDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(attachment.tempPath).mode & 0o777).toBe(0o600);
  });

  it('should create a process session store in the OS tmp directory', async () => {
    const store = createSessionImageAttachmentStore();

    const attachment = await store.saveImage(Buffer.from('session'), 'image/png');
    tempRoots.add(path.dirname(path.dirname(attachment.tempPath)));

    expect(attachment.placeholder).toBe('[Image #1]');
    expect(attachment.fileName).toBe('image-1.png');
    expect(attachment.tempPath.startsWith(path.join(os.tmpdir(), 'takt') + path.sep)).toBe(true);
    expect(fs.readFileSync(attachment.tempPath)).toEqual(Buffer.from('session'));
  });

  it('should create a paste handler that stores images and returns placeholders', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-paste',
    });
    const onImagePaste = createImagePasteHandler(store);

    const placeholder = await onImagePaste({
      data: Buffer.from('paste'),
      mimeType: 'image/png',
    });

    expect(placeholder).toBe('[Image #1]');
    const [attachment] = store.listAttachments();
    expect(attachment?.tempPath).toBe(path.join(tmpRoot, 'takt', 'session-paste', 'attachments', 'image-1.png'));
    expect(fs.readFileSync(attachment!.tempPath)).toEqual(Buffer.from('paste'));
  });
});

describe('buildInteractiveResultWithAttachments', () => {
  it('should not add attachments when no images were pasted', () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-empty-result',
    });

    const result = buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, store);

    expect(result).toEqual({ action: 'cancel', task: '' });
  });

  it('should include pasted image attachments on the interactive result', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-result',
    });
    const attachment = await store.saveImage(Buffer.from('result-image'), 'image/png');

    const result = buildInteractiveResultWithAttachments({ action: 'execute', task: 'Use [Image #1].' }, store);

    expect(result).toEqual({
      action: 'execute',
      task: 'Use [Image #1].',
      attachments: [attachment],
    });
  });
});
