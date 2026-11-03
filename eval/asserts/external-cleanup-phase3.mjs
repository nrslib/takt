import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import buildPhase3Prompt, { loadPhase3JudgmentRules } from '../phase3-judgment-prompt.mjs';
import { runCliReview } from '../providers/cli-review.mjs';
import { determineRuleTransition } from '../../dist/core/workflow/engine/transitions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export async function evaluateReport(report, vars, judge) {
  const language = vars.language ?? 'ja';
  const verifier = vars.role === 'verifier';
  const expectedResult = vars.scenario.startsWith('external-cleanup-complete') ? 'verified'
    : vars.scenario.startsWith('external-cleanup-repair-pending') ? 'incomplete' : 'plan_invalid';
  if (verifier) {
    const result = report.match(/^##\s*(?:結果|Result):\s*(verified|incomplete|plan_invalid)\s*$/im)?.[1];
    if (result !== expectedResult) {
      return { pass: false, score: 0, reason: `Verifier report result: ${result ?? 'missing'}; expected: ${expectedResult}` };
    }
  }
  const phaseVars = {
    language, variant: 'candidate', workflow: 'development-remediation-dynamic',
    step_name: verifier ? 'fix-verifier' : 'fix', input_source: 'report', input: report, json_instruction: true,
  };
  const prompt = buildPhase3Prompt({ vars: phaseVars });
  const answer = await judge(prompt);
  let decision;
  try {
    decision = JSON.parse(answer);
  } catch {
    return { pass: false, score: 0, reason: 'Phase 3 did not return JSON' };
  }
  if (decision === null || typeof decision !== 'object' || !Number.isInteger(decision.step)) {
    return { pass: false, score: 0, reason: 'Phase 3 returned an invalid decision' };
  }
  const { candidates } = loadPhase3JudgmentRules(phaseVars);
  const candidate = candidates[decision.step - 1];
  if (!candidate || typeof decision.reason !== 'string') {
    return { pass: false, score: 0, reason: 'Phase 3 returned an invalid decision' };
  }
  const workflow = parse(readFileSync(join(root, 'builtins', language, 'workflows', `${phaseVars.workflow}.yaml`), 'utf8'));
  const step = workflow.steps.find(entry => entry.name === phaseVars.step_name);
  const index = step.rules.findIndex(rule => rule.condition === candidate.label);
  const nextStep = determineRuleTransition(step, index)?.nextStep;
  const expectedNextStep = verifier
    ? { verified: 'COMPLETE', incomplete: 'fix-retry', plan_invalid: 'verification-replan' }[expectedResult]
    : vars.scenario.startsWith('external-cleanup-complete') ? 'fix-verifier' : 'fix-replan';
  const pass = nextStep === expectedNextStep;
  return { pass, score: pass ? 1 : 0, reason: `Phase 3 selected ${candidate.label}; next: ${nextStep}` };
}

export default async function assertExternalCleanupPhase3(output, context) {
  return evaluateReport(output, context.vars, prompt => runCliReview({
    cli: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'low', timeout_ms: 120000,
  }, prompt, { cwd: join(root, 'eval/fixtures/phase3-judgment/refund') }));
}
