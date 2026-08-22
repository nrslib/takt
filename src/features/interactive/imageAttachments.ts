import { randomUUID } from 'node:crypto';
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

export interface ImageAttachmentStoreOptions {
  tmpRoot: string;
  sessionId: string;
  initialAttachments?: readonly InteractiveImageAttachment[];
  initialAttachmentIndex?: number;
}

const PRIVATE_FILE_MODE = 0o600;

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported pasted image type: ${mimeType}`);
  }
}

function validateImageAttachmentSessionId(sessionId: string): void {
  if (sessionId.length === 0) {
    throw new Error('Image attachment sessionId is required.');
  }
  if (
    sessionId === '.'
    || sessionId === '..'
    || sessionId.includes('/')
    || sessionId.includes('\\')
    || path.isAbsolute(sessionId)
    || path.win32.isAbsolute(sessionId)
  ) {
    throw new Error('Image attachment sessionId must be a single path segment.');
  }
}

function resolveInitialAttachmentIndex(attachments: readonly InteractiveImageAttachment[]): number {
  return attachments.reduce((maxIndex, attachment) => {
    const placeholderIndex = /\[Image #(\d+)\]/.exec(attachment.placeholder)?.[1];
    const fileNameIndex = /^image-(\d+)\.[A-Za-z0-9]+$/.exec(attachment.fileName)?.[1];
    return Math.max(maxIndex, Number(placeholderIndex ?? 0), Number(fileNameIndex ?? 0));
  }, 0);
}

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

export function createImageAttachmentStore(
  options: ImageAttachmentStoreOptions,
): ImageAttachmentStore {
  if (options.tmpRoot.length === 0) {
    throw new Error('Image attachment tmpRoot is required.');
  }
  validateImageAttachmentSessionId(options.sessionId);

  let attachments: InteractiveImageAttachment[] = options.initialAttachments
    ? [...options.initialAttachments]
    : [];
  let nextAttachmentIndex = Math.max(
    options.initialAttachmentIndex ?? 0,
    resolveInitialAttachmentIndex(attachments),
  );
  const sessionDir = path.join(options.tmpRoot, options.sessionId);
  const attachmentDir = path.join(sessionDir, 'attachments');

  let sealed = false;

  return {
    async saveImage(data: Buffer, mimeType: string): Promise<InteractiveImageAttachment> {
      if (sealed) {
        throw new Error('Image attachment store is sealed; the run already ended.');
      }
      // Numbered past whatever the run already carries: a revision that starts
      // with attachments must not hand out a placeholder one of them owns.
      const index = nextAttachmentIndex + 1;
      nextAttachmentIndex = index;
      const fileName = `image-${index}.${extensionForMimeType(mimeType)}`;
      const tempPath = path.join(attachmentDir, fileName);
      const attachment: InteractiveImageAttachment = {
        placeholder: `[Image #${index}]`,
        tempPath,
        fileName,
      };

      ensurePrivateDirectory(sessionDir);
      ensurePrivateDirectory(attachmentDir);
      writeNewPrivateFileWithMode(tempPath, data, PRIVATE_FILE_MODE);
      attachments = [...attachments, attachment];
      return attachment;
    },

    listAttachments(): InteractiveImageAttachment[] {
      return [...attachments];
    },

    cleanup(): void {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },

    seal(): void {
      sealed = true;
    },
  };
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
