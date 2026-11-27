import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseWorkflowRuleCondition, semanticRuleCandidatesOf } from '../dist/core/models/workflow-rule-condition.js';
import { generateStatusRulesComponents } from '../dist/core/workflow/instruction/status-rules.js';
import { renderTemplate } from '../dist/shared/prompts/index.js';
import { buildWrappedSystemPrompt } from '../dist/agents/runner-prompt.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonInstructions = {
  ja: '出力は {"step": <整数>, "reason": "<文字列>"} の JSON オブジェクトだけにしてください。',
  en: 'Return only a JSON object of the form {"step": <integer>, "reason": "<string>"}.',
};

function findStep(steps, name) {
  for (const step of steps) {
    if (step.name === name) return step;
    if (step.parallel === undefined) continue;
    const children = Array.isArray(step.parallel)
      ? step.parallel
      : [...(step.parallel.fixed ?? []), ...(step.parallel.pool ?? [])];
    const found = findStep(children, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function loadPhase3JudgmentRules(vars) {
  if (!['ja', 'en'].includes(vars.language)) throw new Error(`Unknown language: ${vars.language}`);
  if (typeof vars.workflow !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(vars.workflow)) {
    throw new Error('workflow must be a builtin workflow name');
  }
  const hasStep = vars.step_name !== undefined;
  const hasMonitor = vars.loop_monitor_index !== undefined;
  if (hasStep === hasMonitor) throw new Error('Specify exactly one of step_name or loop_monitor_index');
  const workflow = parse(readFileSync(
    join(repoRoot, 'builtins', vars.language, 'workflows', `${vars.workflow}.yaml`), 'utf8',
  ));
  let source;
  let name;
  if (hasStep) {
    if (typeof vars.step_name !== 'string' || !vars.step_name.trim()) {
      throw new Error('step_name must be a non-empty string');
    }
    source = findStep(workflow.steps, vars.step_name);
    name = vars.step_name;
  } else {
    if (!Number.isInteger(vars.loop_monitor_index) || vars.loop_monitor_index < 1) {
      throw new Error('loop_monitor_index must be a 1-based integer');
    }
    const monitor = workflow.loop_monitors?.[vars.loop_monitor_index - 1];
    source = monitor?.judge;
    if (monitor !== undefined) name = `_loop_judge_${monitor.cycle.join('_')}`;
  }
  if (!Array.isArray(source?.rules) || source.rules.length === 0) {
    throw new Error(`Missing rules: ${vars.workflow}/${vars.step_name ?? vars.loop_monitor_index}`);
  }
  const rules = source.rules.map((rule) => ({
    condition: parseWorkflowRuleCondition(rule.condition),
    interactiveOnly: rule.interactive_only,
    appendix: rule.appendix,
  }));
  const candidates = semanticRuleCandidatesOf(rules, vars.interactive === true);
  if (candidates.length === 0) throw new Error('No selectable semantic rules');
  return { name, candidates };
}

export default function buildPhase3JudgmentPrompt({ vars, provider }) {
  if (!['baseline', 'candidate'].includes(vars.variant)) throw new Error(`Unknown variant: ${vars.variant}`);
  if (vars.baseline_revision !== undefined && !/^[a-f0-9]{40}$/.test(vars.baseline_revision)) {
    throw new Error('baseline_revision must be a full commit SHA');
  }
  if (vars.variant === 'baseline' && vars.baseline_revision === undefined) {
    throw new Error('baseline_revision is required for baseline');
  }
  if (!['report', 'response'].includes(vars.input_source)) throw new Error(`Unknown input_source: ${vars.input_source}`);
  if (typeof vars.input !== 'string' || !vars.input.trim()) throw new Error('input must be non-empty text');
  const { name, candidates } = loadPhase3JudgmentRules(vars);
  const { criteriaTable } = generateStatusRulesComponents(name, candidates, vars.language);
  const templatePath = `src/shared/prompts/${vars.language}/perform_phase3_message.md`;
  const template = vars.variant === 'baseline'
    ? execFileSync('git', ['show', `${vars.baseline_revision}:${templatePath}`], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(join(repoRoot, templatePath), 'utf8');
  const personaPath = vars.variant === 'candidate'
    ? join(repoRoot, 'builtins', vars.language, 'facets', 'personas', 'conductor.md')
    : undefined;
  const agentDefinition = vars.variant === 'baseline'
    ? 'conductor'
    : readFileSync(personaPath, 'utf8');
  const system = buildWrappedSystemPrompt(agentDefinition, {
    language: vars.language,
    personaPath,
    providerRuntimeInstructions: null,
  });
  const user = renderTemplate(template
    .replace(/^<!-- markdownlint-disable MD041 -->\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, ''), {
    structuredOutput: true,
    reportContent: vars.input_source === 'response' ? `\n## Agent Response\n\n${vars.input}` : vars.input,
    criteriaTable,
  });
  const jsonInstruction = vars.json_instruction === true || provider?.config?.cli === 'claude';
  return `${system}\n\n${user}${jsonInstruction ? `\n\n${jsonInstructions[vars.language]}` : ''}`;
}
