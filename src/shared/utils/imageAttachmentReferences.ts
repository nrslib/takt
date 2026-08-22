import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageAttachmentReference, StoredImageAttachment } from '../types/image-attachments.js';

const IMAGE_ATTACHMENT_PLACEHOLDER_PATTERN = /\[Image #\d+\]/g;

const IMAGE_ATTACHMENT_PLACEHOLDER_EXACT_PATTERN = /^\[Image #[1-9]\d*\]$/;
const SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
}

export function isImageAttachmentPlaceholder(value: string): boolean {
  return IMAGE_ATTACHMENT_PLACEHOLDER_EXACT_PATTERN.test(value);
}

export function validateImageAttachmentFileName(fileName: string): void {
  assertNonEmptyString(fileName, 'Image attachment fileName');
  if (fileName.includes('/') || fileName.includes('\\')) {
    throw new Error(`Image attachment fileName must not contain path separators: ${fileName}`);
  }

  const extension = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported image attachment file extension: ${fileName}`);
  }
}

export function validateStoredImageAttachment(attachment: StoredImageAttachment): void {
  assertNonEmptyString(attachment.placeholder, 'Image attachment placeholder');
  if (!isImageAttachmentPlaceholder(attachment.placeholder)) {
    throw new Error(`Invalid image attachment placeholder: ${attachment.placeholder}`);
  }
  assertNonEmptyString(attachment.tempPath, 'Image attachment tempPath');
  validateImageAttachmentFileName(attachment.fileName);
}

export function assertRegularImageAttachmentFile(filePath: string, subject = 'Image attachment source'): void {
  assertNonEmptyString(filePath, `${subject} path`);
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${subject} must be a regular file: ${filePath}`);
  }
}

export function resolveReferencedImageAttachments(
  prompt: string,
  attachments: readonly StoredImageAttachment[],
): ImageAttachmentReference[] {
  const referencedPlaceholders = [...new Set(prompt.match(IMAGE_ATTACHMENT_PLACEHOLDER_PATTERN) ?? [])];
  if (referencedPlaceholders.length === 0) {
    return [];
  }

  const attachmentByPlaceholder = new Map<string, StoredImageAttachment>();
  for (const attachment of attachments) {
    if (attachmentByPlaceholder.has(attachment.placeholder)) {
      throw new Error(`Duplicate image attachment placeholder: ${attachment.placeholder}`);
    }
    attachmentByPlaceholder.set(attachment.placeholder, attachment);
  }

  return referencedPlaceholders.flatMap((placeholder): ImageAttachmentReference[] => {
    const attachment = attachmentByPlaceholder.get(placeholder);
    if (attachment === undefined) {
      return [];
    }
    validateStoredImageAttachment(attachment);
    assertRegularImageAttachmentFile(attachment.tempPath);
    return [{
      placeholder: attachment.placeholder,
      path: attachment.tempPath,
    }];
  });
}
