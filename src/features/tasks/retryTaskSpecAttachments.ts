import * as path from 'node:path';
import { prepareTaskSpecDirectory, cleanupPreparedTaskSpec } from './attachments.js';
import type { TaskAttachment } from './attachments.js';
import { readTaskSpecFile } from './taskSpecFile.js';

export interface PreparedRetryTaskSpec {
  taskDir: string;
  taskDirRelative: string;
  retryNote: string;
}

export function hasAttachments(attachments: readonly TaskAttachment[] | undefined): attachments is readonly TaskAttachment[] {
  return attachments !== undefined && attachments.length > 0;
}

function buildRetryTaskSpecContent(taskContent: string, retryNote: string): string {
  return [
    taskContent.trimEnd(),
    '',
    '## 追加指示',
    '',
    retryNote,
  ].join('\n');
}

function resolveTaskDirPath(projectDir: string, taskDir: string): string {
  return path.join(projectDir, taskDir);
}

function resolveRetryTaskSpecBaseContent(
  projectDir: string,
  taskContent: string,
  taskDir: string | undefined,
): string {
  if (!taskDir) {
    return taskContent;
  }

  return readTaskSpecFile(path.join(resolveTaskDirPath(projectDir, taskDir), 'order.md'));
}

function getImageAttachmentExtension(fileName: string): string {
  const ext = path.extname(fileName);
  if (ext === '') {
    throw new Error(`Task attachment file must have an extension: ${fileName}`);
  }
  return ext;
}

function resolveMaxImageIndex(content: string): number {
  const matches = content.matchAll(/\[Image #(\d+)\]|attachments\/image-(\d+)\.[A-Za-z0-9]+/g);
  let maxIndex = 0;
  for (const match of matches) {
    const rawIndex = match[1] ?? match[2];
    if (rawIndex === undefined) {
      continue;
    }
    maxIndex = Math.max(maxIndex, Number(rawIndex));
  }
  return maxIndex;
}

function renumberRetryAttachments(
  baseContent: string,
  retryNote: string,
  attachments: readonly TaskAttachment[],
): { retryNote: string; attachments: TaskAttachment[] } {
  let nextImageIndex = resolveMaxImageIndex(baseContent) + 1;
  const placeholderReplacements = new Map<string, string>();
  const adjustedAttachments = attachments.map((attachment) => {
    const placeholder = `[Image #${nextImageIndex}]`;
    const fileName = `image-${nextImageIndex}${getImageAttachmentExtension(attachment.fileName)}`;
    nextImageIndex += 1;
    placeholderReplacements.set(attachment.placeholder, placeholder);
    return {
      ...attachment,
      placeholder,
      fileName,
    };
  });
  const adjustedRetryNote = retryNote.replace(/\[Image #\d+\]/g, (placeholder) =>
    placeholderReplacements.get(placeholder) ?? placeholder);
  return { retryNote: adjustedRetryNote, attachments: adjustedAttachments };
}

export function prepareRetryTaskSpecWithAttachments(
  projectDir: string,
  taskContent: string,
  retryNote: string,
  attachments: readonly TaskAttachment[] | undefined,
  taskDir?: string,
): PreparedRetryTaskSpec | undefined {
  if (!hasAttachments(attachments)) {
    return undefined;
  }

  const taskSpecBaseContent = resolveRetryTaskSpecBaseContent(projectDir, taskContent, taskDir);
  const adjusted = renumberRetryAttachments(taskSpecBaseContent, retryNote, attachments);
  const taskSpecContent = buildRetryTaskSpecContent(taskSpecBaseContent, adjusted.retryNote);
  const prepareArgs: Parameters<typeof prepareTaskSpecDirectory> = taskDir
    ? [
      projectDir,
      taskSpecContent,
      adjusted.attachments,
      { sourceTaskDir: resolveTaskDirPath(projectDir, taskDir) },
    ]
    : [projectDir, taskSpecContent, adjusted.attachments];
  const preparedSpec = prepareTaskSpecDirectory(...prepareArgs);
  return {
    taskDir: preparedSpec.taskDir,
    taskDirRelative: preparedSpec.taskDirRelative,
    retryNote: adjusted.retryNote,
  };
}

export function cleanupPreparedRetryTaskSpec(preparedSpec: PreparedRetryTaskSpec | undefined): void {
  if (preparedSpec) {
    cleanupPreparedTaskSpec(preparedSpec.taskDir);
  }
}
