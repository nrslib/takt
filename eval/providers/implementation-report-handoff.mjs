import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ReportInstructionBuilder } from '../../dist/core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../dist/core/workflow/instruction/StatusJudgmentBuilder.js';
import { parseWorkflowRuleCondition } from '../../dist/core/models/workflow-rule-condition.js';
import { prepareWorkingDirectory, runCliReview } from './cli-review.mjs';

const builtinsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../builtins');
const workflows = ['development-implement', 'development-implement-dynamic', 'development-implement-team'];

export function loadReportHandoffStep(language, workflow) {
  if (!['ja', 'en'].includes(language)) throw new Error(`Unknown language: ${language}`);
  if (!workflows.includes(workflow)) throw new Error(`Unknown workflow: ${workflow}`);
  const root = join(builtinsRoot, language);
  const read = path => readFileSync(join(root, path), 'utf8');
  const definition = parse(read(`workflows/${workflow}.yaml`));
  const implementation = definition.steps.find(step => step.name === 'implement');
  const shared = parse(read('steps/development-core-implement.yaml'));
  const contract = shared.output_contracts.report.find(report => report.name === 'implementation-report.md');
  return {
    name: implementation.name,
    persona: read('facets/personas/coder.md'),
    instruction: '',
    passPreviousResponse: false,
    outputContracts: [{
      name: contract.name,
      format: read(`facets/output-contracts/${contract.format}.md`),
      order: read(`facets/output-contracts/${contract.order}.md`),
    }],
    rules: implementation.rules.filter(rule => !rule.interactive_only).map(rule => ({
      condition: parseWorkflowRuleCondition(rule.condition),
      ...(rule.next === undefined ? {} : { next: rule.next }),
      ...(rule.return === undefined ? {} : { returnValue: rule.return }),
    })),
  };
}

export function buildReportHandoffPrompt(step, input, cwd) {
  return `${step.persona}\n\n${new ReportInstructionBuilder(step, {
    cwd,
    task: input.task,
    reportDir: '.takt/runs/eval/reports',
    stepIteration: 1,
    language: input.language,
    targetFile: 'implementation-report.md',
    lastResponse: input.workResult,
    injectedReports: input.reports,
  }).build()}`;
}

export function resolveReportHandoffRoute(step, decision) {
  const matches = [...decision.matchAll(/\[IMPLEMENT:(\d+)\]/g)];
  if (matches.length !== 1) throw new Error('Expected one implementation judgment tag');
  const rule = step.rules[Number(matches[0][1]) - 1];
  if (rule === undefined) throw new Error('Implementation judgment is outside the available rules');
  return rule.returnValue ?? rule.next;
}

// Executes report generation followed by judgment; planning and implementation are fixed inputs.
export default class ImplementationReportHandoffProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.run = dependencies.run ?? runCliReview;
    this.prepare = dependencies.prepare ?? prepareWorkingDirectory;
  }

  id() {
    return `implementation-report-handoff:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, _context, options = {}) {
    let directory;
    try {
      const input = JSON.parse(prompt);
      const step = loadReportHandoffStep(input.language, input.workflow);
      directory = this.prepare(this.config);
      const execution = { cwd: directory.cwd, abortSignal: options.abortSignal };
      const report = await this.run(this.config, buildReportHandoffPrompt(step, input, directory.cwd), execution);
      const judgmentPrompt = new StatusJudgmentBuilder(step, {
        language: input.language,
        inputSource: 'report',
        reportContent: report,
      }).build();
      const decision = await this.run(this.config, judgmentPrompt, execution);
      return { output: JSON.stringify({ report, decision, route: resolveReportHandoffRoute(step, decision) }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      directory?.cleanup();
    }
  }
}
