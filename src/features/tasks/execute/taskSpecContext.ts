import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildTaskInstruction } from '../../../infra/task/index.js';

function getTaskSpecPath(projectCwd: string, taskDir: string): string {
  return path.join(projectCwd, taskDir, 'order.md');
}

function buildMissingTaskSpecError(sourceOrderPath: string): Error {
  return new Error(`Task spec file is missing: ${sourceOrderPath}`);
}

function buildInvalidTaskSpecError(sourceOrderPath: string): Error {
  return new Error(`Task spec file must be a regular file: ${sourceOrderPath}`);
}

function readTaskSpecForStaging(sourceOrderPath: string): string {
  let fileDescriptor: number | undefined;
  try {
    const sourceStats = fs.lstatSync(sourceOrderPath);
    if (!sourceStats.isFile()) {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }

    fileDescriptor = fs.openSync(sourceOrderPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const descriptorStats = fs.fstatSync(fileDescriptor);
    if (!descriptorStats.isFile()) {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }

    return fs.readFileSync(fileDescriptor, 'utf-8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      throw buildMissingTaskSpecError(sourceOrderPath);
    }
    if (errorCode === 'ELOOP') {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }
}

export function stageTaskSpecForExecution(
  projectCwd: string,
  execCwd: string,
  taskDir: string,
  reportDirName: string,
): { taskPrompt: string; orderContent: string } {
  const sourceOrderPath = getTaskSpecPath(projectCwd, taskDir);
  const orderContent = readTaskSpecForStaging(sourceOrderPath);
  const runPaths = buildRunPaths(execCwd, reportDirName);

  fs.mkdirSync(runPaths.contextTaskAbs, { recursive: true });
  fs.writeFileSync(runPaths.contextTaskOrderAbs, orderContent, 'utf-8');

  return {
    taskPrompt: buildTaskInstruction(runPaths.contextTaskRel, runPaths.contextTaskOrderRel),
    orderContent,
  };
}
