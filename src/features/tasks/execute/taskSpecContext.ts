import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';
import { copyTaskAttachmentsToRunContext } from '../attachments.js';
import { readTaskSpecFile } from '../taskSpecFile.js';

function getTaskSpecPath(projectCwd: string, taskDir: string): string {
  return path.join(projectCwd, taskDir, 'order.md');
}

export function stageTaskSpecForExecution(
  projectCwd: string,
  execCwd: string,
  taskDir: string,
  reportDirName: string,
): { taskPrompt: string; orderContent: string } {
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
  };
}
