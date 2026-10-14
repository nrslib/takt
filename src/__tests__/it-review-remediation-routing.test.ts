import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/evaluation/index.js')>()),
  RuleEvaluator: (await import('./rule-evaluator-test-double.js')).MockRuleEvaluator,
}));
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { getAllParallelSubSteps, type WorkflowConfig } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { ReportPhaseGenerationError, runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { createWorkflowCallOptions } from './helpers/engine-workflow-call-shared.js';
import { cleanupWorkflowEngine, createTestTmpDir, makeResponse } from './engine-test-helpers.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';

const workflows = [
  'review-fix-frontend', 'review-fix-backend', 'review-fix-dual',
  'review-fix-dual-cqrs', 'review-fix-backend-cqrs',
  'simple-core', 'simple', 'simple-mini',
] as const;
const cases = (['en', 'ja'] as const).flatMap(language =>
  workflows.map(name => ({ language, name })));
type Scenario = 'no_fix' | 'missing_resolution' | 'fixed' | 'missing_fix_report';

function isReviewFix(name: string): boolean {
  return name.startsWith('review-fix-');
}

function loadFocusedWorkflow(project: string, language: string, name: string): WorkflowConfig {
  const loaded = loadWorkflowFromFile(
    join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`),
    project,
  );
  return {
    ...loaded,
    initialStep: 'remediation',
    steps: loaded.steps.map((step) => {
      if (step.name === 'reviewers' && step.parallel !== undefined) {
        const coding = getAllParallelSubSteps(step.parallel).find((child) => child.name === 'coding-review');
        if (coding === undefined) throw new Error(`Missing coding reviewer in ${name}`);
        return { ...step, parallel: [coding] };
      }
      if (step.name === 'follow-up-review') {
        return { ...step, dynamicFacets: undefined };
      }
      return step;
    }),
  };
}

describe('review-remediation return routing and report handoff', () => {
  let project: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    project = createTestTmpDir();
    execFileSync('git', ['init', '--quiet'], { cwd: project });
  });

  afterEach(() => {
    if (engine) cleanupWorkflowEngine(engine);
    engine = undefined;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(project, { recursive: true, force: true });
  });

  async function run(language: string, name: string, scenario: Scenario) {
    writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
    const config = loadFocusedWorkflow(project, language, name);
    const prompts: Array<{ step: string; text: string }> = [];
    const writtenReports: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      if (options?.executionPhase === 1 && options.workflowMeta?.currentStep) {
        prompts.push({ step: options.workflowMeta.currentStep, text: prompt });
      }
      return makeResponse({ persona: String(persona), content: 'approved' });
    });
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'approved', method: 'auto_select' });
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => {
      const index = step.name === 'review-adjudication'
        ? scenario === 'no_fix' || scenario === 'missing_resolution' ? 1 : 0
        : step.name === 'supervise' || step.name === 'reviewers' ? 1 : 0;
      return { index, method: step.parallel === undefined ? 'phase3_tag' : 'aggregate' };
    });
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      for (const report of step.outputContracts ?? []) {
        if (
          scenario === 'missing_resolution' && report.name === 'review-resolution.md'
          || scenario === 'missing_fix_report' && report.name === 'fix-report.md'
        ) {
          throw new ReportPhaseGenerationError('report failed', 'provider_error', {
            requiresFreshPhase1: false,
            failureReasons: ['provider_error'],
          });
        }
        mkdirSync(context.reportDir, { recursive: true });
        const body = report.name === 'review-resolution.md' ? 'ADJUDICATION_DECISION_EVIDENCE'
          : report.name === 'fix-plan.md' ? 'FIX_PLAN_EVIDENCE'
          : report.name === 'fix-report.md' ? 'FIX_REPORT_EVIDENCE'
          : `OTHER_REPORT_${report.name}`;
        writeFileSync(join(context.reportDir, report.name), body);
        onReportWritten?.(report.name);
        writtenReports.push(report.name);
      }
    });
    if (scenario === 'missing_resolution' || scenario === 'missing_fix_report') {
      writeFileSync(join(project, '.takt', 'runs', 'test-report-dir', 'reports',
        scenario === 'missing_resolution' ? 'review-resolution.md' : 'fix-report.md'), 'STALE_UNRELATED');
    }
    engine = new WorkflowEngine(config, project, 'Adjudicate and repair the review', createWorkflowCallOptions(project, {
      language,
      reportDirName: 'test-report-dir',
    }));
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(String(reason)));
    const state = await engine.run();
    return { state, prompts, writtenReports, abortReasons };
  }

  it.each(cases)('$language/$name routes no_fix to independent judgment with its adjudication report', async ({ language, name }) => {
    const { state, prompts, writtenReports, abortReasons } = await run(language, name, 'no_fix');
    const destination = name === 'simple-mini' ? 'review' : 'supervise';
    const judge = prompts.find((prompt) => prompt.step === destination);
    expect(state.status, abortReasons.join('; ')).toBe('completed');
    expect(judge?.text).toContain('### review-resolution.md\nADJUDICATION_DECISION_EVIDENCE');
    expect(judge?.text).not.toContain('### fix-plan.md');
    expect(writtenReports).toContain('review-resolution.md');
    expect(writtenReports).not.toContain('fix-plan.md');
    expect(writtenReports).not.toContain('fix-report.md');
    expect(prompts.some((prompt) => prompt.step === 'follow-up-review' || prompt.step === 'coding-review')).toBe(false);
  });

  it.each(cases)('$language/$name rejects a missing adjudication report after no_fix', async ({ language, name }) => {
    const { state, prompts, abortReasons } = await run(language, name, 'missing_resolution');
    expect(state.status).toBe('aborted');
    expect(abortReasons.join('; ')).toMatch(/not_produced:review-adjudication:review-resolution\.md/);
    expect(prompts.some((prompt) => prompt.step === (name === 'simple-mini' ? 'review' : 'supervise'))).toBe(false);
  });

  it.each(cases)('$language/$name supplies both completed repair reports to follow-up review', async ({ language, name }) => {
    const { state, prompts, writtenReports, abortReasons } = await run(language, name, 'fixed');
    const reviewer = prompts.find((prompt) => prompt.step === (isReviewFix(name) ? 'coding-review' : 'follow-up-review'));
    expect(state.status, abortReasons.join('; ')).toBe('completed');
    expect(reviewer?.text).toContain('### fix-plan.md\nFIX_PLAN_EVIDENCE');
    expect(reviewer?.text).toContain('### fix-report.md\nFIX_REPORT_EVIDENCE');
    expect(writtenReports).toContain('fix-plan.md');
    expect(writtenReports).toContain('fix-report.md');
  });

  it.each(cases)('$language/$name rejects a missing required repair report', async ({ language, name }) => {
    const { state, prompts, abortReasons } = await run(language, name, 'missing_fix_report');
    expect(state.status).toBe('aborted');
    expect(abortReasons.join('; ')).toMatch(/not_produced:fix:fix-report\.md/);
    expect(prompts.some((prompt) => prompt.step === (isReviewFix(name) ? 'coding-review' : 'follow-up-review'))).toBe(false);
  });
});
