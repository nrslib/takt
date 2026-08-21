import { createHash } from 'node:crypto';
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

export interface TaskAttachmentManifestEntry {
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
  readonly contentSha256: string;
}

export type TaskAttachmentManifest = readonly TaskAttachmentManifestEntry[];

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
    fs.copyFileSync(attachment.tempPath, destinationPath, fs.constants.COPYFILE_EXCL);
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

interface AttachmentTreeManifest {
  readonly root: TaskAttachmentManifestEntry;
  readonly entries: readonly TaskAttachmentManifestEntry[];
}

function hashAttachmentContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readAttachmentTreeManifest(
  absolutePath: string,
  relativePath: string,
): AttachmentTreeManifest {
  const stats = fs.lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Task attachments must not contain symlinks: ${absolutePath}`);
  }
  if (stats.isFile()) {
    const root = Object.freeze({
      relativePath,
      kind: 'file' as const,
      contentSha256: hashAttachmentContent(fs.readFileSync(absolutePath)),
    });
    return Object.freeze({ root, entries: Object.freeze([root]) });
  }
  if (!stats.isDirectory()) {
    throw new Error(`Task attachments must be regular files or directories: ${absolutePath}`);
  }

  const children = fs.readdirSync(absolutePath)
    .sort()
    .map((entry) => readAttachmentTreeManifest(
      path.join(absolutePath, entry),
      path.posix.join(relativePath, entry),
    ));
  const root = Object.freeze({
    relativePath,
    kind: 'directory' as const,
    contentSha256: hashAttachmentContent(JSON.stringify(
      children.map((child) => child.root),
    )),
  });
  return Object.freeze({
    root,
    entries: Object.freeze([
      root,
      ...children.flatMap((child) => child.entries),
    ]),
  });
}

export function resolveTaskAttachmentManifest(
  taskDir: string,
): TaskAttachmentManifest {
  const attachmentsDir = path.join(taskDir, 'attachments');
  if (!fs.existsSync(attachmentsDir)) {
    return Object.freeze([]);
  }

  const stats = fs.lstatSync(attachmentsDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Task attachments must be a regular directory: ${attachmentsDir}`);
  }

  return readAttachmentTreeManifest(attachmentsDir, 'attachments').entries;
}

function assertTaskAttachmentManifestEntry(
  taskDir: string,
  expected: TaskAttachmentManifestEntry,
  actual: TaskAttachmentManifestEntry | undefined,
): void {
  const entryPath = path.join(taskDir, expected.relativePath);
  if (actual === undefined) {
    throw new Error(`Task attachment is missing: ${entryPath}`);
  }
  if (actual.kind !== expected.kind) {
    throw new Error(`Task attachment type changed: ${entryPath}`);
  }
  if (actual.contentSha256 !== expected.contentSha256) {
    throw new Error(`Task attachment content changed: ${entryPath}`);
  }
}

function assertTaskAttachmentsMatchManifest(
  taskDir: string,
  expectedManifest: TaskAttachmentManifest,
): void {
  const actualManifest = resolveTaskAttachmentManifest(taskDir);
  const expectedByPath = new Map(
    expectedManifest.map((entry) => [entry.relativePath, entry]),
  );
  const actualByPath = new Map(
    actualManifest.map((entry) => [entry.relativePath, entry]),
  );

  for (const expected of expectedManifest) {
    if (!actualByPath.has(expected.relativePath)) {
      throw new Error(
        `Task attachment is missing: ${path.join(taskDir, expected.relativePath)}`,
      );
    }
  }
  for (const actual of actualManifest) {
    if (!expectedByPath.has(actual.relativePath)) {
      throw new Error(
        `Task attachment was added after resolution: ${path.join(taskDir, actual.relativePath)}`,
      );
    }
  }
  for (const expected of expectedManifest) {
    assertTaskAttachmentManifestEntry(
      taskDir,
      expected,
      actualByPath.get(expected.relativePath),
    );
  }
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

export function copyTaskAttachmentsToRunContext(
  sourceTaskDir: string,
  runContextTaskDir: string,
  expectedManifest: TaskAttachmentManifest,
): void {
  assertTaskAttachmentsMatchManifest(sourceTaskDir, expectedManifest);
  const sourceAttachmentsDir = path.join(sourceTaskDir, 'attachments');
  if (expectedManifest.length !== 0) {
    copyAttachmentEntry(sourceAttachmentsDir, path.join(runContextTaskDir, 'attachments'));
  }
  assertTaskAttachmentsMatchManifest(sourceTaskDir, expectedManifest);
  assertTaskAttachmentsMatchManifest(runContextTaskDir, expectedManifest);
}
