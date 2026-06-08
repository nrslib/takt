import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';
import { copyTaskAttachmentsToRunContext } from '../attachments.js';
import { readTaskSpecFile } from '../taskSpecFile.js';

export interface StagedTaskSpec {
  taskPrompt: string;
  orderContent: string;
  stagedOrderContent: string;
  contextTaskDir: string;
  contextDir: string;
  runRootDir: string;
}

function getTaskSpecPath(projectCwd: string, taskDir: string): string {
  return path.join(projectCwd, taskDir, 'order.md');
}

function removeEmptyDirectory(directory: string): void {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
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

export function stageTaskSpecForExecution(
  projectCwd: string,
  execCwd: string,
  taskDir: string,
  reportDirName: string,
): StagedTaskSpec {
  const sourceTaskDir = path.join(projectCwd, taskDir);
  const sourceOrderPath = getTaskSpecPath(projectCwd, taskDir);
  const orderContent = readTaskSpecFile(sourceOrderPath);
  const runPaths = buildRunPaths(execCwd, reportDirName);
  const stagedOrderContent = rewriteAttachmentPathsForRunContext(orderContent, runPaths.contextTaskRel);

  try {
    fs.mkdirSync(runPaths.contextTaskAbs, { recursive: true });
    fs.writeFileSync(runPaths.contextTaskOrderAbs, stagedOrderContent, 'utf-8');
    copyTaskAttachmentsToRunContext(sourceTaskDir, runPaths.contextTaskAbs);
  } catch (error) {
    fs.rmSync(runPaths.contextTaskAbs, { recursive: true, force: true });
    throw error;
  }

  return {
    taskPrompt: buildTaskInstruction(runPaths.contextTaskRel, runPaths.contextTaskOrderRel),
    orderContent,
    stagedOrderContent,
    contextTaskDir: runPaths.contextTaskAbs,
    contextDir: runPaths.contextAbs,
    runRootDir: runPaths.runRootAbs,
  };
}

export function cleanupStagedTaskSpec(stagedSpec: StagedTaskSpec): void {
  fs.rmSync(stagedSpec.contextTaskDir, { recursive: true, force: true });
  removeEmptyDirectory(stagedSpec.contextDir);
  removeEmptyDirectory(stagedSpec.runRootDir);
}
