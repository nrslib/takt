import * as fs from 'node:fs';
import { selectReferencedImageAttachments } from './imageAttachmentSelection.js';
export { isImageAttachmentPlaceholder, validateImageAttachmentFileName, validateStoredImageAttachment } from './imageAttachmentSelection.js';
import type { ImageAttachmentReference, StoredImageAttachment } from '../types/image-attachments.js';

export function assertRegularImageAttachmentFile(filePath: string, subject = 'Image attachment source'): void {
  if (filePath.length === 0) throw new Error(`${subject} path is required.`);
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${subject} must be a regular file: ${filePath}`);
  }
}

export function resolveReferencedImageAttachments(
  prompt: string,
  attachments: readonly StoredImageAttachment[],
): ImageAttachmentReference[] {
  const referenced = selectReferencedImageAttachments(prompt, attachments);
  for (const attachment of referenced) assertRegularImageAttachmentFile(attachment.path);
  return referenced;
}
