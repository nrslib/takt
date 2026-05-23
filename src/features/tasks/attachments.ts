import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateReportDir } from '../../shared/utils/index.js';

export interface TaskAttachment {
  placeholder: string;
  tempPath: string;
  fileName: string;
}

export interface PreparedTaskSpec {
  taskDir: string;
  taskDirRelative: string;
}

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

  const attachmentLines = attachments.map((attachment) =>
    `- ${attachment.placeholder}: \`${getTaskAttachmentRelativePath(attachment)}\``,
  );
  return [
    taskContent.trimEnd(),
    '',
    '## 添付画像',
    '',
    ...attachmentLines,
  ].join('\n');
}

function getTaskAttachmentRelativePath(attachment: TaskAttachment): string {
  return path.posix.join('attachments', attachment.fileName);
}

function validateTaskAttachment(attachment: TaskAttachment): void {
  if (attachment.fileName.includes('/') || attachment.fileName.includes('\\') || attachment.fileName === '') {
    throw new Error(`Invalid task attachment file name: ${attachment.fileName}`);
  }
}

function validateTaskAttachmentTempFile(attachment: TaskAttachment): void {
  const stats = fs.lstatSync(attachment.tempPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Task attachment source must be a regular file: ${attachment.tempPath}`);
  }
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

export function resolveUniqueTaskSpecSlug(cwd: string, taskContent: string): string {
  const baseSlug = generateReportDir(taskContent);
  let sequence = 1;
  let slug = baseSlug;
  let taskDir = path.join(cwd, '.takt', 'tasks', slug);
  while (fs.existsSync(taskDir)) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
    taskDir = path.join(cwd, '.takt', 'tasks', slug);
  }
  return slug;
}

export function cleanupPreparedTaskSpec(taskDir: string): void {
  fs.rmSync(taskDir, { recursive: true, force: true });
  const tasksDir = path.dirname(taskDir);
  if (fs.existsSync(tasksDir) && fs.readdirSync(tasksDir).length === 0) {
    fs.rmdirSync(tasksDir);
  }
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
  const taskDirSlug = resolveUniqueTaskSpecSlug(cwd, taskContent);
  const taskDir = path.join(cwd, '.takt', 'tasks', taskDirSlug);
  const taskDirRelative = `.takt/tasks/${taskDirSlug}`;
  const orderContent = buildTaskOrderContent(taskContent, attachments);
  const orderPath = path.join(taskDir, 'order.md');

  fs.mkdirSync(taskDir, { recursive: true });
  try {
    if (options?.sourceTaskDir) {
      copyExistingTaskAttachments(options.sourceTaskDir, taskDir);
    }
    promoteTaskAttachments(taskDir, attachments);
    fs.writeFileSync(orderPath, orderContent, 'utf-8');
  } catch (error) {
    cleanupPreparedTaskSpec(taskDir);
    throw error;
  }

  return { taskDir, taskDirRelative };
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
