import * as path from 'node:path';
import type { StoredImageAttachment } from '../types/image-attachments.js';

export interface ImageAttachmentCollection {
  saveImage(data: Buffer, mimeType: string): Promise<StoredImageAttachment>;
  listAttachments(): StoredImageAttachment[];
  seal(): void;
}

export interface ImageAttachmentStoreOptions {
  tmpRoot: string;
  sessionId: string;
  initialAttachments?: readonly StoredImageAttachment[];
  initialAttachmentIndex?: number;
}

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

function resolveInitialAttachmentIndex(attachments: readonly StoredImageAttachment[]): number {
  return attachments.reduce((maxIndex, attachment) => {
    const placeholderIndex = /\[Image #(\d+)\]/.exec(attachment.placeholder)?.[1];
    const fileNameIndex = /^image-(\d+)\.[A-Za-z0-9]+$/.exec(attachment.fileName)?.[1];
    return Math.max(maxIndex, Number(placeholderIndex ?? 0), Number(fileNameIndex ?? 0));
  }, 0);
}

export function createImageAttachmentCollection(
  options: ImageAttachmentStoreOptions,
  saveAttachment: (attachment: StoredImageAttachment, data: Buffer) => void | Promise<void>,
): ImageAttachmentCollection {
  if (options.tmpRoot.length === 0) {
    throw new Error('Image attachment tmpRoot is required.');
  }
  validateImageAttachmentSessionId(options.sessionId);

  let attachments: StoredImageAttachment[] = options.initialAttachments
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
    async saveImage(data: Buffer, mimeType: string): Promise<StoredImageAttachment> {
      if (sealed) {
        throw new Error('Image attachment store is sealed; the run already ended.');
      }
      // Numbered past whatever the run already carries: a revision that starts
      // with attachments must not hand out a placeholder one of them owns.
      const index = nextAttachmentIndex + 1;
      nextAttachmentIndex = index;
      const fileName = `image-${index}.${extensionForMimeType(mimeType)}`;
      const tempPath = path.join(attachmentDir, fileName);
      const attachment: StoredImageAttachment = {
        placeholder: `[Image #${index}]`,
        tempPath,
        fileName,
      };

      const writing = saveAttachment(attachment, data);
      if (writing !== undefined) await writing;
      attachments = [...attachments, attachment];
      return attachment;
    },

    listAttachments(): StoredImageAttachment[] {
      return [...attachments];
    },

    seal(): void {
      sealed = true;
    },
  };
}

