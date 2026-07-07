import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StoredImageAttachment } from '../../shared/types/image-attachments.js';
import {
  assertRegularImageAttachmentFile,
  validateStoredImageAttachment,
} from '../../shared/utils/imageAttachmentReferences.js';
import {
  cleanupTaskSpecDirectory,
  prepareTaskSpecDirectory as prepareEnqueuedTaskSpecDirectory,
  type PreparedTaskSpecDirectory,
} from '../../infra/task/enqueueService.js';

export type TaskAttachment = StoredImageAttachment;

export type PreparedTaskSpec = PreparedTaskSpecDirectory;

export interface PrepareTaskSpecOptions {
  sourceTaskDir?: string;
}

function hasAttachments(attachments: readonly TaskAttachment[] | undefined): attachments is readonly TaskAttachment[] {
  return attachments !== undefined && attachments.length > 0;
}

export function buildTaskOrderContent(
  taskContent: string,
  attachments?: readonly TaskAttachment[],
): string {
  if (!hasAttachments(attachments)) {
    return taskContent;
  }

  const normalizedTaskContent = normalizeTaskAttachmentReferences(taskContent, attachments);
  const attachmentLines = attachments.map((attachment) =>
    `- ${attachment.placeholder}: \`${getTaskAttachmentRelativePath(attachment)}\``,
  );
  return [
    normalizedTaskContent.trimEnd(),
    '',
    '## 添付画像',
    '',
    ...attachmentLines,
  ].join('\n');
}

function getTaskAttachmentRelativePath(attachment: TaskAttachment): string {
  return path.posix.join('attachments', attachment.fileName);
}

function normalizeTaskAttachmentReferences(
  taskContent: string,
  attachments: readonly TaskAttachment[],
): string {
  return attachments.reduce((content, attachment) => {
    const relativePath = getTaskAttachmentRelativePath(attachment);
    const pathVariants = new Set([
      attachment.tempPath,
      attachment.tempPath.replace(/\\/g, '/'),
    ]);
    let normalized = content;
    for (const tempPath of pathVariants) {
      normalized = normalized
        .split(`\`${tempPath}\``).join(`\`${relativePath}\``)
        .split(tempPath).join(`\`${relativePath}\``);
    }
    return normalized;
  }, taskContent);
}

function validateTaskAttachment(attachment: TaskAttachment): void {
  validateStoredImageAttachment(attachment);
}

function validateTaskAttachmentTempFile(attachment: TaskAttachment): void {
  assertRegularImageAttachmentFile(attachment.tempPath, 'Task attachment source');
}

export function promoteTaskAttachments(
  taskDir: string,
  attachments?: readonly TaskAttachment[],
): void {
  if (!hasAttachments(attachments)) {
    return;
  }

  const attachmentsDir = path.join(taskDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  for (const attachment of attachments) {
    validateTaskAttachment(attachment);
    validateTaskAttachmentTempFile(attachment);
    const destinationPath = path.join(taskDir, getTaskAttachmentRelativePath(attachment));
    if (fs.existsSync(destinationPath)) {
      throw new Error(`Task attachment destination already exists: ${destinationPath}`);
    }
    fs.copyFileSync(attachment.tempPath, destinationPath);
  }
}

export function cleanupPreparedTaskSpec(taskDir: string): void {
  cleanupTaskSpecDirectory(taskDir);
}

function copyAttachmentEntry(sourcePath: string, destinationPath: string): void {
  const stats = fs.lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Task attachments must not contain symlinks: ${sourcePath}`);
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyAttachmentEntry(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`Task attachments must be regular files or directories: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyExistingTaskAttachments(sourceTaskDir: string, taskDir: string): void {
  const sourceAttachmentsDir = path.join(sourceTaskDir, 'attachments');
  if (!fs.existsSync(sourceAttachmentsDir)) {
    return;
  }

  const stats = fs.lstatSync(sourceAttachmentsDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Task attachments must be a regular directory: ${sourceAttachmentsDir}`);
  }

  copyAttachmentEntry(sourceAttachmentsDir, path.join(taskDir, 'attachments'));
}

export function prepareTaskSpecDirectory(
  cwd: string,
  taskContent: string,
  attachments?: readonly TaskAttachment[],
  options?: PrepareTaskSpecOptions,
): PreparedTaskSpec {
  const orderContent = buildTaskOrderContent(taskContent, attachments);
  return prepareEnqueuedTaskSpecDirectory(cwd, taskContent, {
    orderContent,
    beforeWrite: (taskDir) => {
      if (options?.sourceTaskDir) {
        copyExistingTaskAttachments(options.sourceTaskDir, taskDir);
      }
      promoteTaskAttachments(taskDir, attachments);
    },
  });
}

export function copyTaskAttachmentsToRunContext(sourceTaskDir: string, runContextTaskDir: string): void {
  const sourceAttachmentsDir = path.join(sourceTaskDir, 'attachments');
  if (!fs.existsSync(sourceAttachmentsDir)) {
    return;
  }

  const stats = fs.lstatSync(sourceAttachmentsDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Task attachments must be a regular directory: ${sourceAttachmentsDir}`);
  }

  copyAttachmentEntry(sourceAttachmentsDir, path.join(runContextTaskDir, 'attachments'));
}
