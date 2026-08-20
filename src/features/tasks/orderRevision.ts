import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepareTaskSpecDirectory, cleanupTaskSpecDirectory } from '../../infra/task/enqueueService.js';
import { isValidTaskDir } from '../../shared/utils/taskPaths.js';
import type { InteractiveImageAttachment } from '../interactive/imageAttachments.js';
import { promoteTaskAttachments } from './attachments.js';
import { readTaskSpecFile } from './taskSpecFile.js';

export interface PersistedTaskOrderRevision {
  readonly taskDirRelative?: string;
  readonly taskDir?: string;
  readonly created: boolean;
  /** Roll back only when the subsequent task-record mutation has failed. */
  readonly rollback: () => void;
}

function resolveTaskDirPath(projectDir: string, taskDir: string): string {
  if (!isValidTaskDir(taskDir)) {
    throw new Error(`Invalid task_dir format: ${taskDir}`);
  }
  return path.join(projectDir, taskDir);
}

/**
 * Resolve the canonical order used by retry/instruct.
 *
 * Existing task records always win over run-context copies. Records written by
 * older versions without task_dir retain their task text as a compatibility
 * fallback.
 */
export function resolveTaskOrderContent(
  projectDir: string,
  taskDir: string | undefined,
  legacyContent: string,
): string {
  if (taskDir !== undefined) {
    const orderPath = path.join(resolveTaskDirPath(projectDir, taskDir), 'order.md');
    const content = readTaskSpecFile(orderPath).trim();
    if (content.length === 0) {
      throw new Error(`Task order is empty: ${orderPath}`);
    }
    return content;
  }

  const content = legacyContent.trim();
  if (content.length === 0) {
    throw new Error('Task order is empty and no task_dir is available.');
  }
  return content;
}

function getAttachmentRelativePath(attachment: InteractiveImageAttachment): string {
  return path.posix.join('attachments', attachment.fileName);
}

function normalizeAttachmentPaths(
  content: string,
  attachments: readonly InteractiveImageAttachment[],
): string {
  return attachments.reduce((current, attachment) => {
    const relativePath = getAttachmentRelativePath(attachment);
    const pathVariants = new Set([attachment.tempPath, attachment.tempPath.replace(/\\/g, '/')]);
    return [...pathVariants].reduce(
      (normalized, sourcePath) => normalized
        .split(`\`${sourcePath}\``).join(`\`${relativePath}\``)
        .split(sourcePath).join(`\`${relativePath}\``),
      current,
    );
  }, content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAttachmentPlaceholderMapping(
  content: string,
  attachment: InteractiveImageAttachment,
): string {
  const placeholder = escapeRegExp(attachment.placeholder);
  const relativePath = getAttachmentRelativePath(attachment);
  const mappingLine = new RegExp(
    `(^|\\n)([^\\n]*${placeholder}\\s*:\\s*)([^\\n]*)`,
    'g',
  );
  return content.replace(mappingLine, `$1$2\`${relativePath}\``);
}

function hasAttachmentPlaceholderMapping(
  content: string,
  attachment: InteractiveImageAttachment,
): boolean {
  const placeholder = escapeRegExp(attachment.placeholder);
  const relativePath = escapeRegExp(getAttachmentRelativePath(attachment));
  return new RegExp(
    '(?:^|\\n)[^\\n]*'
      + `${placeholder}\\s*:\\s*` + '`?' + `${relativePath}` + '`?(?:\\s|$)',
  ).test(content);
}

/**
 * Make the confirmation text and the persisted order agree about attachments.
 */
export function ensureOrderAttachmentContent(
  content: string,
  attachments: readonly InteractiveImageAttachment[],
): string {
  if (attachments.length === 0) {
    return content;
  }

  const normalized = attachments.reduce(
    (current, attachment) => normalizeAttachmentPlaceholderMapping(
      normalizeAttachmentPaths(current, [attachment]),
      attachment,
    ),
    content,
  );
  const missingLines = attachments
    .filter((attachment) => !hasAttachmentPlaceholderMapping(normalized, attachment))
    .map((attachment) => `- ${attachment.placeholder}: \`${getAttachmentRelativePath(attachment)}\``);
  if (missingLines.length === 0) {
    return normalized;
  }

  const trimmed = normalized.trimEnd();
  if (trimmed.includes('## 添付画像')) {
    return `${trimmed}\n${missingLines.join('\n')}`;
  }
  return [trimmed, '', '## 添付画像', '', ...missingLines].join('\n');
}

export function resolveMaxImageIndex(content: string): number {
  const matches = content.matchAll(/\[Image #(\d+)\]|attachments\/image-(\d+)\.[A-Za-z0-9]+/g);
  let maxIndex = 0;
  for (const match of matches) {
    const rawIndex = match[1] ?? match[2];
    if (rawIndex !== undefined) {
      maxIndex = Math.max(maxIndex, Number(rawIndex));
    }
  }
  return maxIndex;
}

function makeTimestamp(): string {
  return String(Date.now());
}

function nextArchivePath(orderPath: string): string {
  const basePath = `${orderPath}.${makeTimestamp()}`;
  let candidate = basePath;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${basePath}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function makeTemporaryOrderPath(taskDir: string): string {
  const base = path.join(taskDir, `.order.md.revision-${process.pid}-${Date.now()}`);
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

interface PromotedRevisionAttachments {
  readonly paths: readonly string[];
  readonly createdDirectory: boolean;
}

function removePromotedRevisionAttachments(
  taskDir: string,
  promoted: PromotedRevisionAttachments,
): void {
  for (const destinationPath of promoted.paths) {
    fs.rmSync(destinationPath, { force: true });
  }
  if (promoted.createdDirectory) {
    const attachmentsDir = path.join(taskDir, 'attachments');
    try {
      if (fs.readdirSync(attachmentsDir).length === 0) {
        fs.rmdirSync(attachmentsDir);
      }
    } catch {
      // Cleanup is best-effort; the canonical order itself remains untouched.
    }
  }
}

function promoteRevisionAttachments(
  taskDir: string,
  attachments: readonly InteractiveImageAttachment[],
): PromotedRevisionAttachments {
  if (attachments.length === 0) {
    return { paths: [], createdDirectory: false };
  }

  const attachmentsDir = path.join(taskDir, 'attachments');
  const createdDirectory = !fs.existsSync(attachmentsDir);
  const destinationPaths = attachments.map((attachment) => path.join(taskDir, getAttachmentRelativePath(attachment)));
  const existing = new Set(destinationPaths.filter((destinationPath) => fs.existsSync(destinationPath)));
  try {
    promoteTaskAttachments(taskDir, attachments);
  } catch (error) {
    for (const destinationPath of destinationPaths) {
      if (!existing.has(destinationPath)) {
        fs.rmSync(destinationPath, { force: true });
      }
    }
    if (createdDirectory) {
      try {
        if (fs.readdirSync(attachmentsDir).length === 0) {
          fs.rmdirSync(attachmentsDir);
        }
      } catch {
        // Cleanup is best-effort; the caller still receives the promotion error.
      }
    }
    throw error;
  }

  return {
    paths: destinationPaths.filter((destinationPath) => !existing.has(destinationPath)),
    createdDirectory,
  };
}

function replaceCanonicalOrder(
  taskDir: string,
  approvedOrderContent: string,
  attachments: readonly InteractiveImageAttachment[],
): () => void {
  const orderPath = path.join(taskDir, 'order.md');
  const orderStats = fs.lstatSync(orderPath);
  if (!orderStats.isFile()) {
    throw new Error(`Task order must be a regular file: ${orderPath}`);
  }

  const temporaryPath = makeTemporaryOrderPath(taskDir);
  let archivePath: string | undefined;
  let archiveCreated = false;
  let promoted: PromotedRevisionAttachments | undefined;
  try {
    fs.writeFileSync(temporaryPath, approvedOrderContent, { encoding: 'utf-8', flag: 'wx' });
    promoted = promoteRevisionAttachments(taskDir, attachments);
    archivePath = nextArchivePath(orderPath);
    fs.copyFileSync(orderPath, archivePath, fs.constants.COPYFILE_EXCL);
    archiveCreated = true;
    // The old file remains in place until this atomic replacement succeeds.
    fs.renameSync(temporaryPath, orderPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (promoted) {
      removePromotedRevisionAttachments(taskDir, promoted);
    }
    if (archiveCreated && archivePath) {
      fs.rmSync(archivePath, { force: true });
    }
    throw error;
  }

  const committedArchivePath = archivePath;
  const committedAttachments = promoted;
  let rolledBack = false;
  return () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    // The archive is the old canonical file. Renaming it back restores the
    // exact previous file while removing the approved replacement.
    fs.renameSync(committedArchivePath!, orderPath);
    if (committedAttachments) {
      removePromotedRevisionAttachments(taskDir, committedAttachments);
    }
  };
}

/**
 * Persist an approved full order. The same function is used by Retry and
 * completed-task Instruct; execution/task-state transitions stay with callers.
 */
export function persistTaskOrderRevision(
  projectDir: string,
  taskDir: string | undefined,
  approvedOrderContent: string,
  attachments?: readonly InteractiveImageAttachment[],
): PersistedTaskOrderRevision {
  const normalizedContent = ensureOrderAttachmentContent(approvedOrderContent, attachments ?? []);
  if (normalizedContent.trim().length === 0) {
    throw new Error('Approved task order must not be empty.');
  }

  if (taskDir !== undefined) {
    const absoluteTaskDir = resolveTaskDirPath(projectDir, taskDir);
    const taskDirStats = fs.lstatSync(absoluteTaskDir);
    if (!taskDirStats.isDirectory()) {
      throw new Error(`Task directory must be a regular directory: ${absoluteTaskDir}`);
    }
    const rollback = replaceCanonicalOrder(absoluteTaskDir, normalizedContent, attachments ?? []);
    return {
      taskDirRelative: taskDir,
      taskDir: absoluteTaskDir,
      created: false,
      rollback,
    };
  }

  const prepared = prepareTaskSpecDirectory(projectDir, normalizedContent);
  try {
    promoteRevisionAttachments(prepared.taskDir, attachments ?? []);
  } catch (error) {
    cleanupTaskSpecDirectory(prepared.taskDir);
    throw error;
  }
  return {
    ...prepared,
    created: true,
    rollback: () => cleanupTaskSpecDirectory(prepared.taskDir),
  };
}

export function cleanupPersistedTaskOrderRevision(
  revision: PersistedTaskOrderRevision | undefined,
): void {
  revision?.rollback();
}
