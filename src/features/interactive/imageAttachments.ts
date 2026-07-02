import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ImageAttachmentReference, StoredImageAttachment } from '../../shared/types/image-attachments.js';
import { resolveReferencedImageAttachments } from '../../shared/utils/imageAttachmentReferences.js';
import type { InteractiveModeResult } from './interactive.js';
import type { ImagePasteHandler } from './inlineImagePaste.js';
import { readClipboardImage } from './clipboardImage.js';

export type InteractiveImageAttachment = StoredImageAttachment;

export interface ImageAttachmentStore {
  saveImage(data: Buffer, mimeType: string): Promise<InteractiveImageAttachment>;
  listAttachments(): InteractiveImageAttachment[];
}

export interface ImageAttachmentStoreOptions {
  tmpRoot: string;
  sessionId: string;
  initialAttachments?: readonly InteractiveImageAttachment[];
}

const PRIVATE_DIRECTORY_MODE = 0o700;
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

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function buildInteractiveResultWithAttachments(
  result: InteractiveModeResult,
  attachmentStore: ImageAttachmentStore,
): InteractiveModeResult {
  const attachments = attachmentStore.listAttachments();
  return {
    ...result,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function createImageAttachmentStore(
  options: ImageAttachmentStoreOptions,
): ImageAttachmentStore {
  if (options.tmpRoot.length === 0) {
    throw new Error('Image attachment tmpRoot is required.');
  }
  if (options.sessionId.length === 0) {
    throw new Error('Image attachment sessionId is required.');
  }

  let attachments: InteractiveImageAttachment[] = options.initialAttachments
    ? [...options.initialAttachments]
    : [];
  const sessionDir = path.join(options.tmpRoot, 'takt', options.sessionId);
  const attachmentDir = path.join(sessionDir, 'attachments');

  return {
    async saveImage(data: Buffer, mimeType: string): Promise<InteractiveImageAttachment> {
      const index = attachments.length + 1;
      const fileName = `image-${index}.${extensionForMimeType(mimeType)}`;
      const tempPath = path.join(attachmentDir, fileName);
      const attachment: InteractiveImageAttachment = {
        placeholder: `[Image #${index}]`,
        tempPath,
        fileName,
      };

      ensurePrivateDirectory(sessionDir);
      ensurePrivateDirectory(attachmentDir);
      fs.writeFileSync(tempPath, data, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      attachments = [...attachments, attachment];
      return attachment;
    },

    listAttachments(): InteractiveImageAttachment[] {
      return [...attachments];
    },
  };
}

export function createSessionImageAttachmentStore(
  initialAttachments?: readonly InteractiveImageAttachment[],
): ImageAttachmentStore {
  return createImageAttachmentStore({
    tmpRoot: os.tmpdir(),
    sessionId: randomUUID(),
    ...(initialAttachments ? { initialAttachments } : {}),
  });
}

export function createImagePasteHandler(attachmentStore: ImageAttachmentStore): ImagePasteHandler {
  return async (image) => {
    const attachment = await attachmentStore.saveImage(image.data, image.mimeType);
    return attachment.placeholder;
  };
}

export function createClipboardImagePasteHandler(attachmentStore: ImageAttachmentStore): () => Promise<string> {
  return async () => {
    const image = await readClipboardImage();
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
