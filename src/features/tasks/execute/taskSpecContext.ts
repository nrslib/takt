import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildRunPaths,
  type RunPaths,
} from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';
import { firstLine } from '../../../infra/task/naming.js';
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
  destination?: RunPaths,
): ResolvedTaskSpec {
  const sourceTaskDir = path.join(projectCwd, taskDir);
  const sourceOrderPath = getTaskSpecPath(projectCwd, taskDir);
  const orderContent = readTaskSpecFile(sourceOrderPath);
  const runPaths = destination ?? buildRunPaths(execCwd, reportDirName);
  const contextTaskRef = path.relative(execCwd, runPaths.contextTaskAbs);
  const contextOrderRef = path.relative(execCwd, runPaths.contextTaskOrderAbs);
  const stagedOrderContent = rewriteAttachmentPathsForRunContext(orderContent, contextTaskRef);
  const attachmentManifest = resolveTaskAttachmentManifest(sourceTaskDir);

  return Object.freeze({
    runSlug: runPaths.slug,
    sourceTaskDir,
    attachmentManifest,
    taskPrompt: [
      `Task: ${firstLine(orderContent)}`,
      `Task directory: ${path.basename(sourceTaskDir)}`,
      '',
      buildTaskInstruction(contextTaskRef, contextOrderRef),
    ].join('\n'),
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

export function restageTaskSpecForExecution(
  taskSpec: ResolvedTaskSpec,
  runPaths: RunPaths,
): void {
  const temporaryRoot = fs.mkdtempSync(path.join(runPaths.contextAbs, '.task-restage-'));
  const temporaryTaskDir = path.join(temporaryRoot, 'task');
  const temporaryOrderPath = path.join(temporaryTaskDir, path.basename(runPaths.contextTaskOrderAbs));
  try {
    // Keep the real slug and relative references while isolating staging's failure cleanup.
    stageTaskSpecForExecution(taskSpec, {
      ...runPaths,
      contextTaskAbs: temporaryTaskDir,
      contextTaskOrderAbs: temporaryOrderPath,
    });
    const temporaryAttachmentsDir = path.join(temporaryTaskDir, 'attachments');
    if (fs.existsSync(temporaryAttachmentsDir)) {
      fs.cpSync(temporaryAttachmentsDir, path.join(runPaths.contextTaskAbs, 'attachments'), {
        recursive: true,
        force: true,
      });
    }
    fs.renameSync(temporaryOrderPath, runPaths.contextTaskOrderAbs);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
