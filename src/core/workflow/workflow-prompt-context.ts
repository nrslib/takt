import type { Language, WorkflowConfig, WorkflowResumePointEntry, WorkflowStep } from '../models/types.js';
import { isDynamicParallelSubSteps } from '../models/types.js';
import type { WorkflowCallResolver } from './types.js';
import { workflowEntryMatchesWorkflow } from './workflow-reference.js';
import { isWorkflowCallStep } from './step-kind.js';

type StepPath = readonly (string | number)[];
type WorkflowStepRoute = readonly StepPath[];

interface WorkflowTreeRow {
  readonly ja: string;
  readonly en: string;
  readonly route?: WorkflowStepRoute;
}

function treeRow(depth: number, name: string, description: string | undefined, workflow: boolean, optional: boolean, route?: WorkflowStepRoute): WorkflowTreeRow {
  const prefix = `${'  '.repeat(depth)}- ${name}`;
  const suffix = description ? `: ${description}` : '';
  return {
    ja: `${prefix}${workflow ? '（ワークフロー）' : ''}${optional ? '（実行時に選ばれたときだけ動く）' : ''}${suffix}`,
    en: `${prefix}${workflow ? ' (workflow)' : ''}${optional ? ' (runs only when selected at runtime)' : ''}${suffix}`,
    route,
  };
}

interface WorkflowTreeStep {
  readonly step: WorkflowStep;
  readonly path: StepPath;
  readonly parent?: WorkflowTreeStep;
  readonly child?: WorkflowTreeNode;
}

interface WorkflowTreeNode {
  readonly config: WorkflowConfig;
  readonly steps: readonly WorkflowTreeStep[];
}

export interface WorkflowPromptTree {
  readonly rows: readonly WorkflowTreeRow[];
  readonly root: WorkflowTreeNode;
}

export interface WorkflowAssignment {
  readonly stepName: string;
  readonly parallelParent?: string;
  readonly internalStep?: WorkflowStep['internalPromptContext'];
  readonly stepIteration: number;
  readonly iteration: number;
  readonly maxSteps: number | 'infinite';
}

export interface WorkflowPromptContext {
  readonly tree: string;
  readonly assignment: WorkflowAssignment;
  readonly rules: string;
}

function stepDescription(step: WorkflowStep): string | undefined {
  return step.description;
}

export function buildWorkflowPromptTree(
  config: WorkflowConfig,
  resolveCall: WorkflowCallResolver | undefined,
  projectCwd: string,
  lookupCwd: string,
): WorkflowPromptTree {
  const rows: WorkflowTreeRow[] = [];
  function workflow(config: WorkflowConfig, depth: number, route: WorkflowStepRoute): WorkflowTreeNode {
    rows.push(treeRow(depth, config.name, config.description, true, false));
    function steps(
      definitions: readonly WorkflowStep[],
      path: StepPath,
      depth: number,
      optional: boolean,
      parent?: WorkflowTreeStep,
    ): WorkflowTreeStep[] {
      return definitions.flatMap((step, index) => {
        const stepPath = [...path, index];
        rows.push(treeRow(depth, step.name, stepDescription(step), false, optional, [...route, stepPath]));
        let child: WorkflowTreeNode | undefined;
        if (isWorkflowCallStep(step)) {
          if (resolveCall === undefined) throw new Error(`Workflow prompt tree requires a resolver for "${step.name}"`);
          const resolved = resolveCall({ parentWorkflow: config, step, projectCwd, lookupCwd });
          if (resolved === null) throw new Error(`Workflow prompt tree could not resolve "${step.name}"`);
          child = workflow(resolved, depth + 1, [...route, stepPath]);
        }
        const entry: WorkflowTreeStep = { step, path: stepPath, parent, child };
        if (step.parallel === undefined) return [entry];
        const parallel = step.parallel;
        const nested = isDynamicParallelSubSteps(parallel)
          ? [
              ...steps(parallel.fixed, [...stepPath, 'parallel', 'fixed'], depth + 1, false, entry),
              ...steps(parallel.pool, [...stepPath, 'parallel', 'pool'], depth + 1, true, entry),
            ]
          : steps(parallel, [...stepPath, 'parallel'], depth + 1, false, entry);
        return [entry, ...nested];
      });
    }
    return { config, steps: steps(config.steps, ['steps'], depth + 1, false) };
  }
  return { root: workflow(config, 0, []), rows };
}

export function renderWorkflowPromptTree(tree: WorkflowPromptTree, current: WorkflowStepRoute, language: Language): string {
  let marked = 0;
  const currentKey = JSON.stringify(current);
  const result = tree.rows.map((row) => {
    const isCurrent = row.route !== undefined && JSON.stringify(row.route) === currentKey;
    if (isCurrent) marked++;
    const marker = isCurrent ? (language === 'ja' ? ' ← 現在' : ' ← current') : '';
    return `${row[language]}${marker}`;
  }).join('\n');
  const marker = language === 'ja' ? '← 現在' : '← current';
  if (marked !== 1 || result.split(marker).length !== 2) throw new Error('Workflow prompt tree must mark exactly one current step');
  return result;
}

export function locateWorkflowPromptStep(
  tree: WorkflowPromptTree,
  prefix: readonly WorkflowResumePointEntry[],
  stepPath: readonly PropertyKey[],
): { route: WorkflowStepRoute; workflowName: string; parallelParent?: string } {
  let node = tree.root;
  let scope: WorkflowTreeStep | undefined;
  const route: StepPath[] = [];
  for (const frame of prefix) {
    if (!workflowEntryMatchesWorkflow(frame, node.config)) throw new Error(`Workflow prompt tree frame has a different workflow: "${frame.workflow}"`);
    const entry = node.steps.find((entry) => entry.parent === scope && entry.step.name === frame.step);
    if (entry === undefined) throw new Error(`Workflow prompt tree cannot locate frame "${frame.step}"`);
    if (frame.kind === 'workflow_call') {
      if (entry.child === undefined) throw new Error(`Workflow prompt tree has no child for "${frame.step}"`);
      route.push(entry.path);
      node = entry.child;
      scope = undefined;
    } else {
      scope = entry;
    }
  }
  const pathKey = JSON.stringify(stepPath);
  const entry = node.steps.find((entry) => JSON.stringify(entry.path) === pathKey);
  if (entry === undefined) throw new Error(`Workflow prompt tree cannot locate step path ${pathKey}`);
  return { route: [...route, entry.path], workflowName: node.config.name, parallelParent: entry.parent?.step.name };
}
