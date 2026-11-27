import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPhaseProduction(distDir) {
  const load = (path) => import(pathToFileURL(join(distDir, path)).href);
  const [runner, instruction, report, status, judges, providers, skills, claude] = await Promise.all([
    load('agents/runner.js'),
    load('core/workflow/instruction/InstructionBuilder.js'),
    load('core/workflow/instruction/ReportInstructionBuilder.js'),
    load('core/workflow/instruction/StatusJudgmentBuilder.js'),
    load('agents/judge-status-usecase.js'),
    load('infra/providers/index.js'),
    load('infra/codex/skill-config.js'),
    load('infra/claude/options-builder.js'),
  ]);
  const contextPath = 'core/workflow/workflow-prompt-context.js';
  const workflow = existsSync(join(distDir, contextPath)) ? await load(contextPath) : undefined;
  return { ...runner, ...instruction, ...report, ...status, ...judges, ...providers, ...skills, ...claude, workflow };
}

export function phaseWorkflowMeta(api, steps, current, stepIteration, iteration, cwd) {
  const workflowName = 'phase-awareness';
  const index = steps.findIndex((step) => step.name === current.name);
  if (index < 0) throw new Error('Current step missing from eval workflow');
  if (api.workflow === undefined) {
    return {
      workflowName, currentStep: current.name, workflowDescription: 'レビューと修正のワークフロー',
      stepsList: steps.map(({ name }) => ({ name })), currentPosition: `${index + 1}/${steps.length}`,
    };
  }
  const tree = api.workflow.buildWorkflowPromptTree({ name: workflowName, steps, maxSteps: 30 }, undefined, cwd, cwd);
  return {
    workflowName, currentStep: current.name,
    context: {
      tree: api.workflow.renderWorkflowPromptTree(tree, [['steps', index]], 'ja'),
      assignment: { stepName: current.name, stepIteration, iteration, maxSteps: 30 },
      rules: '1. 修正対象あり\n2. 修正対象なし',
    },
  };
}

export function assignmentOptions(meta) {
  return meta.context === undefined ? {} : { workflowAssignment: meta.context.assignment };
}

export function phasePersonaPath(distDir, step) {
  const name = step === 'review-adjudication' ? 'review-adjudicator' : step === 'implement' ? 'coder' : 'coding-reviewer';
  const path = resolve(distDir, '..', 'builtins/ja/facets/personas', `${name}.md`);
  // Ensure that a missing baseline asset fails before any paid call.
  readFileSync(path, 'utf8');
  return path;
}
