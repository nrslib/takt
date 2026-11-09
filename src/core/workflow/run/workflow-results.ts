import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { WorkflowConfig, WorkflowState } from '../../models/types.js';
import { writeFileAtomic } from '../../../shared/utils/atomic-file.js';
import { warn } from '../../../shared/ui/LogManager.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { resumeWorkflowMatches } from './resume-point.js';

const RESULTS_FILE = 'workflow-results.json';
const scopes = z.record(z.string(), z.record(z.string(), z.unknown()));
const resultsSchema = z.object({
  workflow: z.string(),
  workflow_ref: z.string(),
  context: scopes,
  effect: scopes,
  structured: scopes,
}).strict();

export function saveWorkflowResults(contextDirectory: string, config: WorkflowConfig, state: WorkflowState): void {
  const path = join(contextDirectory, RESULTS_FILE);
  const content = JSON.stringify({
    workflow: config.name,
    workflow_ref: getWorkflowReference(config),
    context: Object.fromEntries(state.systemContexts),
    effect: Object.fromEntries(state.effectResults),
    structured: Object.fromEntries(state.structuredOutputs),
  });
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeFileAtomic(path, content, 0o600);
}

export function inheritWorkflowResults(sourceContext: string, targetContext: string): void {
  if (sourceContext === targetContext) return;
  const sourcePath = join(sourceContext, RESULTS_FILE);
  if (existsSync(sourcePath)) {
    mkdirSync(targetContext, { recursive: true });
    writeFileAtomic(join(targetContext, RESULTS_FILE), readFileSync(sourcePath, 'utf8'), 0o600);
  }
  const children = join(sourceContext, 'subworkflows');
  if (!existsSync(children)) return;
  for (const child of readdirSync(children, { withFileTypes: true })) {
    if (child.isDirectory()) {
      inheritWorkflowResults(join(children, child.name), join(targetContext, 'subworkflows', child.name));
    }
  }
}

export function restoreWorkflowResults(contextDirectory: string, config: WorkflowConfig, state: WorkflowState): void {
  const path = join(contextDirectory, RESULTS_FILE);
  if (!existsSync(path)) {
    warn(`Saved workflow results are unavailable for "${config.name}" at "${state.currentStep}" (${path}); resuming with empty results.`);
    return;
  }
  const results = resultsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!resumeWorkflowMatches(results, config)) {
    throw new Error(`Cannot resume workflow "${config.name}": saved results belong to "${results.workflow}"`);
  }
  for (const [root, target] of [
    [results.context, state.systemContexts],
    [results.effect, state.effectResults],
    [results.structured, state.structuredOutputs],
  ] as const) {
    for (const [scope, value] of Object.entries(root)) target.set(scope, value);
  }
}
