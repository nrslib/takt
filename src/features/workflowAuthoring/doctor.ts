import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  isWorkflowPath,
  resolveWorkflowConfigValue,
} from '../../infra/config/index.js';
import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { inspectWorkflowFile } from '../../infra/config/loaders/workflowDoctor.js';

function resolveInputPath(input: string, baseDir: string): string {
  if (input.startsWith('~')) {
    return resolve(homedir(), input.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(input)) {
    return input;
  }
  return resolve(baseDir, input);
}

function resolveNamedWorkflowPath(name: string, projectDir: string): string | undefined {
  const lang = resolveWorkflowConfigValue(projectDir, 'language');
  const candidateDirs = [
    getProjectWorkflowsDir(projectDir),
    getGlobalWorkflowsDir(),
    getBuiltinWorkflowsDir(lang),
  ];

  for (const dir of candidateDirs) {
    for (const ext of ['.yaml', '.yml']) {
      const filePath = join(dir, `${name}${ext}`);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return undefined;
}

function collectWorkflowFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(rootDir)) {
    const entryPath = join(rootDir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      results.push(...collectWorkflowFiles(entryPath));
      continue;
    }
    if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      results.push(entryPath);
    }
  }
  return results;
}

function resolveWorkflowTargets(targets: string[], projectDir: string): string[] {
  if (targets.length === 0) {
    return [
      ...collectWorkflowFiles(getProjectWorkflowsDir(projectDir)),
    ];
  }

  return targets.map((target) => {
    if (isWorkflowPath(target)) {
      return resolveInputPath(target, projectDir);
    }

    const resolvedPath = resolveNamedWorkflowPath(target, projectDir);
    if (!resolvedPath) {
      throw new Error(`Workflow not found: ${target}`);
    }
    return resolvedPath;
  });
}

export async function doctorWorkflowCommand(
  targets: string[],
  projectDir: string,
): Promise<void> {
  const resolvedTargets = resolveWorkflowTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const filePath of resolvedTargets) {
    const report = inspectWorkflowFile(filePath, projectDir);
    if (report.diagnostics.length === 0) {
      success(`Workflow OK: ${sanitizeTerminalText(filePath)}`);
      continue;
    }

    for (const diagnostic of report.diagnostics) {
      const message = sanitizeTerminalText(diagnostic.message);
      if (diagnostic.level === 'error') {
        hasErrors = true;
        error(`${sanitizeTerminalText(filePath)}: ${message}`);
      } else {
        warn(`${sanitizeTerminalText(filePath)}: ${message}`);
      }
    }
  }

  if (hasErrors) {
    throw new Error('Workflow validation failed');
  }
}
