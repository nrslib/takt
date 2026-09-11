import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { StatusJudgmentBuilder } from '../dist/core/workflow/instruction/StatusJudgmentBuilder.js';
import { parseWorkflowRuleCondition } from '../dist/core/models/workflow-rule-condition.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflows = new Set([
  'development-implement',
  'development-implement-dynamic',
  'development-implement-team',
  'development-core',
  'development-remediation',
  'development-remediation-dynamic',
  'development-remediation-team',
  'review-remediation',
]);

// Evaluate shipped Phase 3 rules with fixed reports, without running implementation tools.
export function loadCompletionRoutingStep(vars) {
  if (!['ja', 'en'].includes(vars.language)) throw new Error(`Unknown language: ${vars.language}`);
  if (!workflows.has(vars.workflow)) throw new Error(`Unknown workflow: ${vars.workflow}`);
  const relativePath = `builtins/${vars.language}/workflows/${vars.workflow}.yaml`;
  if (vars.baseline_revision !== undefined && !/^[a-f0-9]{40}$/.test(vars.baseline_revision)) {
    throw new Error('baseline_revision must be a full commit SHA');
  }
  const body = vars.baseline_revision === undefined
    ? readFileSync(join(repoRoot, relativePath), 'utf8')
    : execFileSync('git', ['show', `${vars.baseline_revision}:${relativePath}`], { cwd: repoRoot, encoding: 'utf8' });
  const definition = parse(body);
  const stepName = vars.workflow === 'development-core'
    ? 'replan'
    : vars.workflow.includes('remediation') ? 'fix-plan' : 'implement';
  const step = definition.steps.find(candidate => candidate.name === stepName);
  if (!step) throw new Error(`Missing step: ${stepName}`);
  return step;
}

export default function buildCompletionRoutingPrompt({ vars }) {
  const step = loadCompletionRoutingStep(vars);
  const rules = step.rules.map(rule => ({
    condition: parseWorkflowRuleCondition(rule.condition),
    interactiveOnly: rule.interactive_only,
    appendix: rule.appendix,
  }));
  return new StatusJudgmentBuilder({ name: step.name, rules }, {
    language: vars.language,
    structuredOutput: vars.judgment_mode === 'structured',
    inputSource: 'report',
    reportContent: vars.report,
  }).build();
}
