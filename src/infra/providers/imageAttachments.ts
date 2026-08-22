import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isImageAttachmentPlaceholder,
  validateImageAttachmentFileName,
} from '../../shared/utils/imageAttachmentReferences.js';
import type { ProviderImageAttachment } from './types.js';

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
}

function assertProviderImageAttachment(value: unknown): asserts value is ProviderImageAttachment {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Image attachment must be an object.');
  }
}

function assertReadableImageAttachmentFile(filePath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`Failed to read image attachment at ${filePath}`, { cause: error });
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Image attachment source must be a regular file: ${filePath}`);
  }
}

export function validateProviderImageAttachments(
  imageAttachments: readonly ProviderImageAttachment[] | undefined,
): void {
  if (imageAttachments === undefined || imageAttachments.length === 0) {
    return;
  }

  const placeholders = new Set<string>();
  for (const attachmentValue of imageAttachments) {
    assertProviderImageAttachment(attachmentValue);
    const attachment = attachmentValue;
    assertNonEmptyString(attachment.placeholder, 'Image attachment placeholder');
    if (!isImageAttachmentPlaceholder(attachment.placeholder)) {
      throw new Error(`Invalid image attachment placeholder: ${attachment.placeholder}`);
    }
    if (placeholders.has(attachment.placeholder)) {
      throw new Error(`Duplicate image attachment placeholder: ${attachment.placeholder}`);
    }
    placeholders.add(attachment.placeholder);

    assertNonEmptyString(attachment.path, 'Image attachment source path');
    validateImageAttachmentFileName(path.basename(attachment.path));
    assertReadableImageAttachmentFile(attachment.path);
  }
}
