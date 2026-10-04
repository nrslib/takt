import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildRunPaths,
  type RunPaths,
} from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';
import {
  copyTaskAttachmentsToRunContext,
  resolveTaskAttachmentManifest,
  type TaskAttachmentManifest,
} from '../attachments.js';
import { readTaskSpecFile } from '../taskSpecFile.js';

export interface ResolvedTaskSpec {
  readonly runSlug: string;
  readonly sourceTaskDir: string;
  readonly attachmentManifest: TaskAttachmentManifest;
  readonly taskPrompt: string;
  readonly orderContent: string;
  readonly stagedOrderContent: string;
}

function getTaskSpecPath(projectCwd: string, taskDir: string): string {
  return path.join(projectCwd, taskDir, 'order.md');
}

function rewriteAttachmentPathsForRunContext(orderContent: string, contextTaskRel: string): string {
  const contextTaskRelPosix = contextTaskRel.replace(/\\/g, '/');
  const toRunContextPath = (attachmentPath: string): string => {
    const segments = attachmentPath.split('/');
    if (segments.some((segment) => segment === '..' || segment.length === 0)) {
      throw new Error(`Invalid task attachment path: attachments/${attachmentPath}`);
    }
    return path.posix.join(contextTaskRelPosix, 'attachments', attachmentPath);
  };
  const splitTrailingPunctuation = (attachmentPath: string): { pathPart: string; suffix: string } => {
    const match = attachmentPath.match(/^(.+?)([.!?,;:]*)$/);
    return {
      pathPart: match?.[1] ?? attachmentPath,
      suffix: match?.[2] ?? '',
    };
  };
  const backticked = orderContent.replace(/`attachments\/([^`\r\n]+)`/g, (_match, attachmentPath: string) =>
    `\`${toRunContextPath(attachmentPath)}\``,
  );
  return backticked.replace(/(^|[\s([:])attachments\/([A-Za-z0-9._/-]+)/g, (
    _match,
    prefix: string,
    attachmentPath: string,
  ) => {
    const { pathPart, suffix } = splitTrailingPunctuation(attachmentPath);
    return `${prefix}\`${toRunContextPath(pathPart)}\`${suffix}`;
  });
}

export function resolveTaskSpecForExecution(
  projectCwd: string,
  execCwd: string,
  taskDir: string,
  reportDirName: string,
): ResolvedTaskSpec {
  const sourceTaskDir = path.join(projectCwd, taskDir);
  const sourceOrderPath = getTaskSpecPath(projectCwd, taskDir);
  const orderContent = readTaskSpecFile(sourceOrderPath);
  const runPaths = buildRunPaths(execCwd, reportDirName);
  const stagedOrderContent = rewriteAttachmentPathsForRunContext(orderContent, runPaths.contextTaskRel);
  const attachmentManifest = resolveTaskAttachmentManifest(sourceTaskDir);

  return Object.freeze({
    runSlug: runPaths.slug,
    sourceTaskDir,
    attachmentManifest,
    taskPrompt: buildTaskInstruction(runPaths.contextTaskRel, runPaths.contextTaskOrderRel),
    orderContent,
    stagedOrderContent,
  });
}

export function stageTaskSpecForExecution(
  taskSpec: ResolvedTaskSpec,
  runPaths: RunPaths,
): void {
  if (taskSpec.runSlug !== runPaths.slug) {
    throw new Error(
      `Task spec run "${taskSpec.runSlug}" does not match reserved run "${runPaths.slug}"`,
    );
  }
  try {
    fs.mkdirSync(runPaths.contextTaskAbs, { recursive: true });
    fs.writeFileSync(
      runPaths.contextTaskOrderAbs,
      taskSpec.stagedOrderContent,
      'utf-8',
    );
    copyTaskAttachmentsToRunContext(
      taskSpec.sourceTaskDir,
      runPaths.contextTaskAbs,
      taskSpec.attachmentManifest,
    );
  } catch (error) {
    fs.rmSync(runPaths.contextTaskAbs, { recursive: true, force: true });
    throw error;
  }
}
