/**
 * A clipboard capture that ignores its abort signal can finish after the run
 * already ended. By then the owner has enumerated the attachments and deleted
 * the session directory, so a late save would recreate it and leave a temp file
 * behind. Sealing the store is what stops that.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupImageAttachmentStoreOnProcessExit,
  createImageAttachmentStore,
  type ImageAttachmentStore,
} from '../features/interactive/imageAttachments.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tmpRoot: string;
let store: ImageAttachmentStore;

function sessionDir(): string {
  return join(tmpRoot, 'session-1');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'takt-attach-'));
  store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('image attachment store sealing', () => {
  it('should save images while the run is live', async () => {
    const attachment = await store.saveImage(PNG, 'image/png');

    expect(attachment.placeholder).toBe('[Image #1]');
    expect(existsSync(attachment.tempPath)).toBe(true);
    expect(store.listAttachments()).toHaveLength(1);
  });

  it('should refuse a late save and leave no file behind after a forced exit', async () => {
    // The run ends: the owner seals, then cleans up.
    store.seal();
    store.cleanup();
    expect(existsSync(sessionDir())).toBe(false);

    await expect(store.saveImage(PNG, 'image/png')).rejects.toThrow('sealed');

    expect(existsSync(sessionDir())).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(store.listAttachments()).toEqual([]);
  });

  describe('process exit net', () => {
    /** The handler the helper registered, without emitting a real process exit. */
    function takeExitHandler(before: readonly unknown[]): () => void {
      const added = process.listeners('exit').filter((listener) => !before.includes(listener));
      const handler = added[0];
      if (added.length !== 1 || typeof handler !== 'function') {
        throw new Error(`expected exactly one new exit listener, got ${added.length}`);
      }
      return handler as () => void;
    }

    it('should seal and remove the directory when the process exits mid-run', async () => {
      await store.saveImage(PNG, 'image/png');
      const before = process.listeners('exit');

      const release = cleanupImageAttachmentStoreOnProcessExit(store);
      try {
        // A selector that ends the process on Ctrl+C never returns to the run,
        // so this handler is the only thing left to delete the file.
        takeExitHandler(before)();

        expect(existsSync(sessionDir())).toBe(false);
        await expect(store.saveImage(PNG, 'image/png')).rejects.toThrow('sealed');
        expect(existsSync(sessionDir())).toBe(false);
      } finally {
        release();
      }
    });

    it('should stop watching once the caller takes the files back', async () => {
      await store.saveImage(PNG, 'image/png');
      const before = process.listeners('exit');

      const release = cleanupImageAttachmentStoreOnProcessExit(store);
      release();

      // Nothing of ours is left on the process, so a later exit deletes nothing.
      expect(process.listeners('exit').filter((listener) => !before.includes(listener))).toEqual([]);
      expect(existsSync(sessionDir())).toBe(true);
    });
  });

  it('should keep images that were already saved when sealing', async () => {
    const attachment = await store.saveImage(PNG, 'image/png');

    store.seal();

    expect(existsSync(attachment.tempPath)).toBe(true);
    expect(store.listAttachments()).toHaveLength(1);
  });

  it('should stay sealed for every later attempt', async () => {
    store.seal();

    await expect(store.saveImage(PNG, 'image/png')).rejects.toThrow('sealed');
    await expect(store.saveImage(PNG, 'image/png')).rejects.toThrow('sealed');
  });
});
