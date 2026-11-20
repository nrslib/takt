import { randomUUID } from 'node:crypto';
import { createImageAttachmentCollection, type ImageAttachmentStoreOptions } from '../../shared/utils/imageAttachmentStore.js';
export type { ImageAttachmentStoreOptions } from '../../shared/utils/imageAttachmentStore.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageAttachmentReference, StoredImageAttachment } from '../../shared/types/image-attachments.js';
import { debugLog } from '../../shared/utils/index.js';
import { resolveReferencedImageAttachments } from '../../shared/utils/imageAttachmentReferences.js';
import { ensurePrivateDirectory, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import type { InteractiveModeResult } from './interactive.js';
import type { ImagePasteHandler } from './inlineImagePaste.js';
import { readClipboardImage } from './clipboardImage.js';

export type InteractiveImageAttachment = StoredImageAttachment;

export interface ImageAttachmentStore {
  saveImage(data: Buffer, mimeType: string): Promise<InteractiveImageAttachment>;
  listAttachments(): InteractiveImageAttachment[];
  cleanup(): void;
  /**
   * Stop accepting images. A capture that was still running when the run ended
   * would otherwise write its file after the owner enumerated and cleaned up,
   * leaving a temp file behind; already saved images are untouched.
   */
  seal(): void;
}

export interface ImageAttachmentCleanupOwner {
  cleanupAttachments?: () => void;
}

const PRIVATE_FILE_MODE = 0o600;

export function cleanupImageAttachmentStore(attachmentStore: ImageAttachmentStore): void {
  try {
    // Sealed first: a capture that ignored its abort would otherwise recreate the
    // session directory right after it was removed.
    attachmentStore.seal();
    attachmentStore.cleanup();
  } catch (error) {
    debugLog('interactive', 'Failed to cleanup image attachment store', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Cleans the store up if the process ends before its owner can.
 *
 * A readline selector ends the process itself when the user interrupts it
 * (`shared/prompt/select.ts` calls `process.exit(130)`), so a run that is
 * waiting on one never reaches its own teardown and the files a paste left in
 * the temp directory would survive it. `exit` handlers can only do synchronous
 * work, which is exactly what sealing and removing the directory need.
 *
 * Returns the release for the owner to call once it has taken the files back.
 */
export function cleanupImageAttachmentStoreOnProcessExit(
  attachmentStore: ImageAttachmentStore,
): () => void {
  const cleanupOnExit = (): void => {
    cleanupImageAttachmentStore(attachmentStore);
  };
  process.once('exit', cleanupOnExit);
  return () => {
    process.off('exit', cleanupOnExit);
  };
}

function createImageAttachmentResultCleanup(attachmentStore: ImageAttachmentStore): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    cleanupImageAttachmentStore(attachmentStore);
  };
}

export function attachImageAttachmentCleanup<T extends object>(
  result: T,
  cleanupAttachments: (() => void) | undefined,
): T & ImageAttachmentCleanupOwner {
  if (cleanupAttachments === undefined) {
    return result as T & ImageAttachmentCleanupOwner;
  }

  return {
    ...result,
    cleanupAttachments,
  };
}

export function cleanupInteractiveResultAttachments(result: ImageAttachmentCleanupOwner): void {
  if (result.cleanupAttachments === undefined) {
    return;
  }
  try {
    result.cleanupAttachments();
  } catch (error) {
    debugLog('interactive', 'Failed to cleanup interactive result attachments', error instanceof Error ? error.message : String(error));
  }
}

export function buildInteractiveResultWithAttachments(
  result: InteractiveModeResult,
  attachmentStore: ImageAttachmentStore,
  attachmentsOverride?: readonly InteractiveImageAttachment[],
): InteractiveModeResult {
  const attachments = attachmentsOverride
    ? [...attachmentsOverride]
    : attachmentStore.listAttachments();
  const resultWithAttachments = {
    ...result,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  return attachments.length > 0
    ? attachImageAttachmentCleanup(resultWithAttachments, createImageAttachmentResultCleanup(attachmentStore))
    : resultWithAttachments;
}

export function createImageAttachmentStore(options: ImageAttachmentStoreOptions): ImageAttachmentStore {
  const sessionDir = path.join(options.tmpRoot, options.sessionId);
  const collection = createImageAttachmentCollection(options, (attachment, data) => {
    ensurePrivateDirectory(sessionDir);
    ensurePrivateDirectory(path.dirname(attachment.tempPath));
    writeNewPrivateFileWithMode(attachment.tempPath, data, PRIVATE_FILE_MODE);
  });
  return { ...collection, cleanup() { fs.rmSync(sessionDir, { recursive: true, force: true }); } };
}

/**
 * A pasted image has to be readable by the provider that is asked to look at
 * it, and a provider that sandboxes its file access can only reach the project
 * it was pointed at — the OS temp directory is outside every such sandbox. The
 * files therefore live under the project's own `.takt/`, which `.takt/.gitignore`
 * already keeps out of version control, and are deleted when the run ends.
 */
export function createSessionImageAttachmentStore(
  cwd: string,
  initialAttachments?: readonly InteractiveImageAttachment[],
  initialAttachmentIndex?: number,
): ImageAttachmentStore {
  return createImageAttachmentStore({
    tmpRoot: path.join(cwd, '.takt', 'tmp', 'images'),
    sessionId: randomUUID(),
    ...(initialAttachments ? { initialAttachments } : {}),
    ...(initialAttachmentIndex === undefined ? {} : { initialAttachmentIndex }),
  });
}

export function createImagePasteHandler(attachmentStore: ImageAttachmentStore): ImagePasteHandler {
  return async (image) => {
    const attachment = await attachmentStore.saveImage(image.data, image.mimeType);
    return attachment.placeholder;
  };
}

export function createClipboardImagePasteHandler(
  attachmentStore: ImageAttachmentStore,
): (abortSignal?: AbortSignal) => Promise<string> {
  return async (abortSignal?: AbortSignal) => {
    const image = await readClipboardImage(abortSignal);
    const attachment = await attachmentStore.saveImage(image.data, image.mimeType);
    return attachment.placeholder;
  };
}

export function resolvePromptImageAttachments(
  prompt: string,
  attachments: readonly InteractiveImageAttachment[],
): ImageAttachmentReference[] {
  return resolveReferencedImageAttachments(prompt, attachments);
}
