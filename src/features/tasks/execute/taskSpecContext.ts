import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';
import { copyTaskAttachmentsToRunContext } from '../attachments.js';
import { readTaskSpecFile } from '../taskSpecFile.js';

export interface StagedTaskSpec {
  taskPrompt: string;
  orderContent: string;
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

  try {
    fs.mkdirSync(runPaths.contextTaskAbs, { recursive: true });
    fs.writeFileSync(runPaths.contextTaskOrderAbs, orderContent, 'utf-8');
    copyTaskAttachmentsToRunContext(sourceTaskDir, runPaths.contextTaskAbs);
  } catch (error) {
    fs.rmSync(runPaths.contextTaskAbs, { recursive: true, force: true });
    throw error;
  }

  return {
    taskPrompt: buildTaskInstruction(runPaths.contextTaskRel, runPaths.contextTaskOrderRel),
    orderContent,
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
