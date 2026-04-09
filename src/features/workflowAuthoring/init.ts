import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  ensureDir,
  getGlobalFacetDir,
  getGlobalWorkflowsDir,
  getProjectFacetDir,
  getProjectWorkflowsDir,
  isPathSafe,
} from '../../infra/config/index.js';
import { info, success } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { createWorkflowScaffold } from './template.js';

export type WorkflowInitTemplateKind = 'minimal' | 'faceted';

export type InitWorkflowOptions = {
  description?: string;
  global?: boolean;
  steps?: number;
  template?: WorkflowInitTemplateKind;
  projectDir: string;
};

function normalizeWorkflowName(name: string): string {
  const normalized = name.trim().replace(/\.ya?ml$/i, '');
  if (normalized.length === 0) {
    throw new Error('Workflow name is required');
  }
  return normalized;
}

function resolveWorkflowTargetPath(baseDir: string, workflowName: string): string {
  return resolve(baseDir, `${workflowName}.yaml`);
}

function validateTemplate(template: string | undefined): WorkflowInitTemplateKind {
  if (template === undefined || template === 'minimal' || template === 'faceted') {
    return template ?? 'minimal';
  }
  throw new Error(`Unsupported workflow template: ${template}`);
}

function validateStepCount(steps: number | undefined): number {
  if (steps === undefined) {
    return 1;
  }
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new Error(`--steps must be a positive integer: ${steps}`);
  }
  return steps;
}

export async function initWorkflowCommand(
  name: string,
  options: InitWorkflowOptions,
): Promise<void> {
  const workflowName = normalizeWorkflowName(name);
  const template = validateTemplate(options.template);
  const stepCount = validateStepCount(options.steps);
  const workflowsDir = options.global
    ? getGlobalWorkflowsDir()
    : getProjectWorkflowsDir(options.projectDir);
  const workflowPath = resolveWorkflowTargetPath(workflowsDir, workflowName);

  if (!isPathSafe(workflowsDir, workflowPath)) {
    throw new Error(`Invalid workflow name: ${sanitizeTerminalText(name)}`);
  }

  const personaDir = options.global
    ? getGlobalFacetDir('personas')
    : getProjectFacetDir(options.projectDir, 'personas');
  const instructionDir = options.global
    ? getGlobalFacetDir('instructions')
    : getProjectFacetDir(options.projectDir, 'instructions');
  const files = template === 'faceted'
    ? createWorkflowScaffold({
      description: options.description,
      instructionDir,
      name: workflowName,
      personaDir,
      stepCount,
      template,
      workflowPath,
    })
    : createWorkflowScaffold({
      description: options.description,
      name: workflowName,
      stepCount,
      template,
      workflowPath,
    });

  for (const file of files) {
    if (existsSync(file.path)) {
      throw new Error(`Workflow scaffold already exists: ${file.path}`);
    }
  }

  ensureDir(workflowsDir);
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf-8');
  }

  success(`Created workflow scaffold: ${sanitizeTerminalText(workflowPath)}`);
  if (template === 'faceted') {
    success(`Created facet files under: ${sanitizeTerminalText(resolve(personaDir, '..'))}`);
  }
  info(`Next: takt workflow doctor ${sanitizeTerminalText(workflowName)}`);
}
