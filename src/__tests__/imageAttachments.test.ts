import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInteractiveResultWithAttachments,
  cleanupInteractiveResultAttachments,
  createImageAttachmentStore,
  createImagePasteHandler,
  createSessionImageAttachmentStore,
  resolvePromptImageAttachments,
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

function createTempImage(root: string, fileName: string): string {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, Buffer.from('image-data'));
  return filePath;
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

  it('should remove the session image attachment directory on cleanup', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-cleanup',
    });
    const attachment = await store.saveImage(Buffer.from('cleanup'), 'image/png');
    const sessionDir = path.join(tmpRoot, 'takt', 'session-cleanup');

    expect(fs.existsSync(attachment.tempPath)).toBe(true);

    store.cleanup();

    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('should reject unsafe session ids before cleanup can target the tmp root', () => {
    const tmpRoot = createTempRoot();
    const sentinelPath = path.join(tmpRoot, 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'keep');

    for (const sessionId of ['.', '..', 'nested/session', 'nested\\session', '/absolute', 'C:\\absolute']) {
      expect(() => createImageAttachmentStore({
        tmpRoot,
        sessionId,
      })).toThrow('Image attachment sessionId must be a single path segment.');
      expect(fs.existsSync(tmpRoot)).toBe(true);
      expect(fs.existsSync(sentinelPath)).toBe(true);
    }
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

describe('resolvePromptImageAttachments', () => {
  it('should return only attachments referenced by placeholders in the prompt', () => {
    const tmpRoot = createTempRoot();
    const first = {
      placeholder: '[Image #1]',
      tempPath: createTempImage(tmpRoot, 'image-1.png'),
      fileName: 'image-1.png',
    };
    const second = {
      placeholder: '[Image #2]',
      tempPath: createTempImage(tmpRoot, 'image-2.png'),
      fileName: 'image-2.png',
    };

    const result = resolvePromptImageAttachments('Please inspect [Image #2].', [first, second]);

    expect(result).toEqual([
      { placeholder: '[Image #2]', path: second.tempPath },
    ]);
  });

  it('should not match a prefix placeholder when only a later image is referenced', () => {
    const tmpRoot = createTempRoot();
    const first = {
      placeholder: '[Image #1]',
      tempPath: createTempImage(tmpRoot, 'image-1.png'),
      fileName: 'image-1.png',
    };
    const tenth = {
      placeholder: '[Image #10]',
      tempPath: createTempImage(tmpRoot, 'image-10.png'),
      fileName: 'image-10.png',
    };

    const result = resolvePromptImageAttachments('Please inspect [Image #10].', [first, tenth]);

    expect(result).toEqual([
      { placeholder: '[Image #10]', path: tenth.tempPath },
    ]);
  });

  it('should leave unknown image placeholder text unresolved', () => {
    const result = resolvePromptImageAttachments('Please inspect [Image #1].', []);

    expect(result).toEqual([]);
  });

  it('should reject referenced images whose tempPath is not a regular file', () => {
    const tmpRoot = createTempRoot();
    const directoryPath = path.join(tmpRoot, 'not-a-file.png');
    fs.mkdirSync(directoryPath);

    expect(() => resolvePromptImageAttachments('Please inspect [Image #1].', [{
      placeholder: '[Image #1]',
      tempPath: directoryPath,
      fileName: 'image-1.png',
    }])).toThrow(`Image attachment source must be a regular file: ${directoryPath}`);
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
      cleanupAttachments: expect.any(Function),
    });
    expect(result.cleanupAttachments).toEqual(expect.any(Function));
    expect(Object.keys(result)).toEqual(['action', 'task', 'attachments', 'cleanupAttachments']);
  });

  it('should cleanup pasted image attachments from the interactive result owner', async () => {
    const tmpRoot = createTempRoot();
    const store = createImageAttachmentStore({
      tmpRoot,
      sessionId: 'session-result-cleanup',
    });
    const attachment = await store.saveImage(Buffer.from('result-cleanup-image'), 'image/png');
    const sessionDir = path.join(tmpRoot, 'takt', 'session-result-cleanup');
    const result = buildInteractiveResultWithAttachments({ action: 'execute', task: 'Use [Image #1].' }, store);

    expect(fs.existsSync(attachment.tempPath)).toBe(true);

    cleanupInteractiveResultAttachments(result);
    cleanupInteractiveResultAttachments(result);

    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
