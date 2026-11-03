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
import { writePhaseReportFixture } from './helpers/phase-report-fixture.js';
import { ReportPhaseGenerationError, runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
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
type Scenario =
  | 'no_fix' | 'missing_resolution' | 'fixed' | 'missing_fix_report'
  | 'missing_first_fix_report' | 'failed_fix_plan' | 'failed_verification_report'
  | 'failed_verification_replan' | 'failed_fix_retry';

function isReviewFix(name: string): boolean {
  return name.startsWith('review-fix-');
}

function loadFocusedWorkflow(project: string, language: string, name: string,
  initialStep: 'gather' | 'remediation' = 'remediation'): WorkflowConfig {
  const loaded = loadWorkflowFromFile(
    join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`),
    project,
  );
  return {
    ...loaded,
    initialStep,
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

  async function run(language: string, name: string, scenario: Scenario,
    initialStep: 'gather' | 'remediation' = 'remediation') {
    writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
    const config = loadFocusedWorkflow(project, language, name, initialStep);
    let preparingReviewer = initialStep === 'remediation' && isReviewFix(name);
    if (preparingReviewer) config.initialStep = 'reviewers';
    const prompts: Array<{ step: string; text: string }> = [];
    const writtenReports: string[] = [];
    let verificationCount = 0;
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
        : step.name === 'fix-verifier' && scenario === 'failed_fix_retry'
          ? verificationCount++ === 0 ? 2 : 0
        : step.name === 'fix-verifier' && scenario === 'failed_verification_replan'
          ? 1
        : step.name === 'reviewers' && preparingReviewer ? 2
        : step.name === 'supervise' || step.name === 'reviewers' ? 1 : 0;
      return { index, method: step.parallel === undefined ? 'phase3_tag' : 'aggregate' };
    });
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      for (const report of step.outputContracts ?? []) {
        if (
          scenario === 'missing_resolution' && report.name === 'review-resolution.md'
          || (scenario === 'missing_fix_report' || scenario === 'missing_first_fix_report') && report.name === 'fix-report.md'
          || scenario === 'failed_fix_plan' && step.name === 'fix-plan' && report.name === 'fix-plan.md'
          || scenario === 'failed_verification_report' && step.name === 'fix-verifier' && report.name === 'fix-verification.md'
          || scenario === 'failed_verification_replan' && step.name === 'verification-replan' && report.name === 'fix-plan.md'
          || scenario === 'failed_fix_retry' && step.name === 'fix-retry' && report.name === 'fix-report.md'
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
        writePhaseReportFixture(context, report.name, body);
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
    const abortFailures: Array<{ kind: string; failureCategory?: string }> = [];
    engine.on('workflow:abort', (_state, reason, kind, failure) => {
      abortReasons.push(String(reason));
      abortFailures.push({ kind, failureCategory: failure.failureCategory });
    });
    if (preparingReviewer) {
      const upstream = await engine.runSingleIteration();
      expect(upstream.nextStep).toBe('remediation');
      expect(upstream.abort).toBeUndefined();
      preparingReviewer = false;
      prompts.length = 0;
      writtenReports.length = 0;
    }
    const state = await engine.run();
    return { state, prompts, writtenReports, abortReasons, abortFailures };
  }

  it.each(cases.filter(({ name }) => isReviewFix(name)))(
    '$language/$name starts review without requiring repair reports', async ({ language, name }) => {
      const { state, prompts, abortReasons } = await run(language, name, 'fixed', 'gather');
      const review = prompts.find(prompt => prompt.step === 'coding-review');
      expect(state.status, abortReasons.join('; ')).toBe('completed');
      expect(review?.text).toBeDefined();
      expect(review?.text).not.toContain('FIX_PLAN_EVIDENCE');
      expect(review?.text).not.toContain('FIX_REPORT_EVIDENCE');
      expect(review?.text).not.toContain('fix-verification.md');
      expect(prompts.some(prompt => prompt.step === 'fix-plan')).toBe(false);
    },
  );

  it.each(cases)('$language/$name routes no_fix to independent judgment with its adjudication report', async ({ language, name }) => {
    const { state, prompts, writtenReports, abortReasons } = await run(language, name, 'no_fix');
    const destination = name === 'simple-mini' ? 'review' : 'supervise';
    const judge = prompts.find((prompt) => prompt.step === destination);
    expect(state.status, abortReasons.join('; ')).toBe('completed');
    expect(judge?.text).toContain('### remediation: review-resolution.md\nADJUDICATION_DECISION_EVIDENCE');
    expect(judge?.text).not.toContain('FIX_PLAN_EVIDENCE');
    expect(writtenReports).toContain('review-resolution.md');
    expect(writtenReports).not.toContain('fix-plan.md');
    expect(writtenReports).not.toContain('fix-report.md');
    expect(prompts.some((prompt) => prompt.step === 'follow-up-review' || prompt.step === 'coding-review')).toBe(false);
  });

  it.each(cases)('$language/$name rejects a missing adjudication report after no_fix', async ({ language, name }) => {
    const { state, prompts, abortReasons } = await run(language, name, 'missing_resolution');
    expect(state.status).toBe('aborted');
    expect(abortReasons.join('; ')).toContain('review-resolution.md');
    expect(prompts.some((prompt) => prompt.step === (name === 'simple-mini' ? 'review' : 'supervise'))).toBe(false);
  });

  it.each(cases)('$language/$name supplies both completed repair reports to follow-up review', async ({ language, name }) => {
    const { state, prompts, writtenReports, abortReasons } = await run(language, name, 'fixed');
    const reviewer = prompts.find((prompt) => prompt.step === (isReviewFix(name) ? 'coding-review' : 'follow-up-review'));
    expect(state.status, abortReasons.join('; ')).toBe('completed');
    expect(reviewer?.text).toContain('### remediation: fix-plan.md\nFIX_PLAN_EVIDENCE');
    expect(reviewer?.text).toContain('### remediation: fix-report.md\nFIX_REPORT_EVIDENCE');
    expect(reviewer?.text).toContain('### remediation: fix-verification.md\nOTHER_REPORT_fix-verification.md');
    expect(writtenReports).toContain('fix-plan.md');
    expect(writtenReports).toContain('fix-report.md');
  });

  it.each(cases)('$language/$name rejects a missing required repair report', async ({ language, name }) => {
    const { state, prompts, abortReasons } = await run(language, name, 'missing_fix_report');
    expect(state.status).toBe('aborted');
    expect(abortReasons.join('; ')).toContain('fix-report.md');
    expect(prompts.some((prompt) => prompt.step === (isReviewFix(name) ? 'coding-review' : 'follow-up-review'))).toBe(false);
  });

  it.each([{ language: 'ja', name: 'simple-core' }, { language: 'en', name: 'review-fix-frontend' }])(
    '$language/$name does not verify the old fix report after fix-retry report generation fails',
    async ({ language, name }) => {
      const { state, prompts, writtenReports, abortReasons, abortFailures } = await run(language, name, 'failed_fix_retry');
      expect(state.status, abortReasons.join('; ')).toBe('aborted');
      expect(abortFailures).toContainEqual({ kind: 'step_error', failureCategory: 'provider_error' });
      expect(prompts.filter((prompt) => prompt.step === 'fix-verifier')).toHaveLength(1);
      expect(writtenReports.filter((report) => report === 'fix-report.md')).toHaveLength(1);
      expect(prompts.some((prompt) => prompt.step === (isReviewFix(name) ? 'coding-review' : 'follow-up-review'))).toBe(false);
    },
  );

  it.each(['ja', 'en'])(
    '%s rejects the first missing fix report before dedicated verification',
    async (language) => {
      const { state, prompts, abortReasons } = await run(language, 'simple-core', 'missing_first_fix_report');
      expect(state.status, abortReasons.join('; ')).toBe('aborted');
      expect(prompts.some((prompt) => prompt.step === 'fix-verifier')).toBe(false);
    },
  );

  it.each(['ja', 'en'])(
    '%s rejects an absent fix plan before implementation',
    async (language) => {
      const { state, prompts, abortReasons } = await run(language, 'simple-core', 'failed_fix_plan');
      expect(state.status, abortReasons.join('; ')).toBe('aborted');
      expect(prompts.some((prompt) => prompt.step === 'fix')).toBe(false);
    },
  );

  it.each(['ja', 'en'])(
    '%s rejects a missing verification report before returning to the parent',
    async (language) => {
      const { state, prompts, abortReasons } = await run(language, 'simple-core', 'failed_verification_report');
      expect(state.status, abortReasons.join('; ')).toBe('aborted');
      expect(prompts.some((prompt) => prompt.step === 'follow-up-review')).toBe(false);
    },
  );

  it.each(['ja', 'en'])(
    '%s rejects a failed verification replan instead of reusing the old fix plan',
    async (language) => {
      const { state, prompts, writtenReports, abortReasons } = await run(language, 'simple-core', 'failed_verification_replan');
      expect(state.status, abortReasons.join('; ')).toBe('aborted');
      expect(prompts.filter((prompt) => prompt.step === 'fix')).toHaveLength(1);
      expect(writtenReports.filter((name) => name === 'fix-plan.md')).toHaveLength(1);
    },
  );

  it.each([
    { runOtherProducer: false, aliasOrder: 'none', expected: 'missing' },
    { runOtherProducer: true, aliasOrder: 'none', expected: 'missing' },
    { runOtherProducer: true, aliasOrder: 'before', expected: 'missing' },
    { runOtherProducer: true, aliasOrder: 'after', expected: 'current' },
    { runOtherProducer: true, aliasOrder: 'none', expected: 'partial', partialOutput: true },
  ] as const)(
    'uses the latest same-name attempt with optional producer=$runOtherProducer alias=$aliasOrder result=$expected',
    async ({ runOtherProducer, aliasOrder, expected, ...testCase }) => {
      const partialOutput = 'partialOutput' in testCase && testCase.partialOutput;
      const alias = {
        name: 'alias', persona: 'alias', instruction: 'Write replacement review',
        output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
        rules: [{ condition: 'done', next: aliasOrder === 'before' ? 'review' : 'decision' }],
      };
      const config = normalizeWorkflowConfig({
        name: 'report-ownership',
        initial_step: aliasOrder === 'before' ? 'alias' : 'review',
        max_steps: aliasOrder === 'none' ? 3 : 4,
        steps: [
          ...(aliasOrder === 'before' ? [alias] : []),
          {
            name: 'review', persona: 'reviewer', instruction: 'Review',
            output_contracts: { report: [
              { name: 'review.md', format: 'review-format' },
              ...(partialOutput ? [{ name: 'plan.md', format: 'review-format' }] : []),
            ] },
            rules: [{ condition: 'done', next: aliasOrder === 'after' ? 'alias'
              : runOtherProducer ? 'decision' : 'consume' }],
          },
          ...(aliasOrder === 'after' ? [alias] : []),
          {
            name: 'decision',
            parallel: {
              fixed: [],
              pool: [
                { name: 'same', persona: 'same', description: 'Same report', instruction: 'Same',
                  output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
                  rules: [{ condition: 'done' }] },
                { name: 'other', persona: 'other', description: 'Other report', instruction: 'Other',
                  output_contracts: { report: [{ name: 'other.md', format: 'review-format' }] },
                  rules: [{ condition: 'done' }] },
                ...(partialOutput ? [{ name: 'plan', persona: 'plan', description: 'Plan report', instruction: 'Plan',
                  output_contracts: { report: [{ name: 'plan.md', format: 'review-format' }] },
                  rules: [{ condition: 'done' }] }] : []),
              ],
              selection: { mode: 'replace' },
            },
            rules: [{ condition: 'all("done")', next: 'consume' }],
          },
          {
            name: 'consume', persona: 'consumer',
            instruction: partialOutput
              ? 'Read {report:review.md} and {report:plan.md}'
              : 'Read {report:review.md}',
            input_reports: { from_step: 'decision', reports: 'all', optional_if_unrun: true },
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
        report_formats: { 'review-format': 'Report' },
      }, project);
      const reportDir = join(project, '.takt', 'runs', 'test-report-dir', 'reports');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'review.md'), 'STALE_REVIEW');
      if (partialOutput) writeFileSync(join(reportDir, 'plan.md'), 'STALE_PLAN');
      writeFileSync(join(project, 'tracked.ts'), 'const value = 1;\n');
      execFileSync('git', ['add', 'tracked.ts'], { cwd: project });
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test',
        'commit', '--quiet', '-m', 'initial'], { cwd: project });
      const prompts: Array<{ step: string; text: string }> = [];
      vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
        if (options?.outputSchema !== undefined) {
          return makeResponse({ persona: 'selector', structuredOutput: {
            selected_ids: ['other'], rationale: 'Only the other report applies',
          } });
        }
        options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
        if (options?.executionPhase === 1 && options.workflowMeta?.currentStep) {
          prompts.push({ step: options.workflowMeta.currentStep, text: prompt });
        }
        return makeResponse({ persona: String(persona), content: 'done' });
      });
      vi.mocked(mockRuleEvaluation).mockImplementation((step) => ({
        index: 0, method: step.parallel === undefined ? 'phase3_tag' : 'aggregate',
      }));
      vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
      vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
        if (step.name === 'review') {
          if (partialOutput) {
            writePhaseReportFixture(context, 'review.md', 'CURRENT_PARTIAL_REVIEW');
            onReportWritten?.('review.md');
          }
          throw new ReportPhaseGenerationError('report failed', 'provider_error', {
            requiresFreshPhase1: false, failureReasons: ['provider_error'],
          });
        }
        for (const report of step.outputContracts ?? []) {
          writePhaseReportFixture(context, report.name, `CURRENT_${report.name}`);
          onReportWritten?.(report.name);
        }
      });
      engine = new WorkflowEngine(config, project, 'Review', createWorkflowCallOptions(project, {
        reportDirName: 'test-report-dir',
        selectorProvider: { provider: 'mock', model: undefined, providerOptions: {} },
      }));
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(String(reason)));
      const state = await engine.run();
      expect(state.status, abortReasons.join('; ')).toBe('completed');
      expect(engine.getResumePoint()?.missing_report_generations).toEqual(
        expected === 'current' ? {} : { '': [expected === 'partial' ? 'plan.md' : 'review.md'] },
      );
      const consumer = prompts.find(({ step }) => step === 'consume');
      expect(consumer?.text).toBeDefined();
      expect(consumer?.text).not.toContain('STALE_REVIEW');
      if (expected === 'partial') {
        expect(consumer?.text).toContain('CURRENT_PARTIAL_REVIEW');
        expect(consumer?.text).toContain('（参照先の報告 plan.md はこの run に存在しない）');
        expect(consumer?.text).not.toContain('STALE_PLAN');
      } else if (expected === 'missing') {
        expect(consumer?.text).toContain('（参照先の報告 review.md はこの run に存在しない）');
        expect(consumer?.text).not.toContain('CURRENT_review.md');
      } else {
        expect(consumer?.text).toContain('Read CURRENT_review.md');
      }
    },
  );

  it('lets a later mandatory all-reports producer supply the same name after an earlier soft failure', async () => {
    const config = normalizeWorkflowConfig({
      name: 'mandatory-report-ownership', initial_step: 'earlier', max_steps: 3,
      steps: [
        { name: 'earlier', persona: 'reviewer', instruction: 'Write first review',
          output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
          rules: [{ condition: 'done', next: 'later' }] },
        { name: 'later', persona: 'reviewer', instruction: 'Write second review',
          output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
          rules: [{ condition: 'done', next: 'consume' }] },
        { name: 'consume', persona: 'consumer', instruction: 'Read {report:review.md}',
          input_reports: { from_step: 'later', reports: 'all' },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
      report_formats: { 'review-format': 'Review' },
    }, project);
    const reportDir = join(project, '.takt', 'runs', 'test-report-dir', 'reports');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'review.md'), 'STALE_REVIEW');
    const prompts: Array<{ step: string; text: string }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      if (options?.executionPhase === 1 && options.workflowMeta?.currentStep) {
        prompts.push({ step: options.workflowMeta.currentStep, text: prompt });
      }
      return makeResponse({ persona: String(persona), content: 'done' });
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'earlier') {
        throw new ReportPhaseGenerationError('report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      writePhaseReportFixture(context, 'review.md', 'CURRENT_LATER_REVIEW');
      onReportWritten?.('review.md');
    });
    engine = new WorkflowEngine(config, project, 'Review', createWorkflowCallOptions(project, {
      reportDirName: 'test-report-dir',
    }));
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(String(reason)));
    const state = await engine.run();
    const consumer = prompts.find(({ step }) => step === 'consume');
    expect(state.status, abortReasons.join('; ')).toBe('completed');
    expect(prompts.map(({ step }) => step)).toEqual(['earlier', 'later', 'consume']);
    expect(consumer?.text).toContain('CURRENT_LATER_REVIEW');
    expect(consumer?.text).not.toContain('STALE_REVIEW');
  });

  it('requires the local report when a completed mandatory producer selected a different name', async () => {
    const config = normalizeWorkflowConfig({
      name: 'mandatory-report-other-name', initial_step: 'other-producer', max_steps: 3,
      steps: [
        { name: 'other-producer', persona: 'reviewer', instruction: 'Write another report',
          output_contracts: { report: [{ name: 'other.md', format: 'review-format' }] },
          rules: [{ condition: 'done', next: 'local-producer' }] },
        { name: 'local-producer', persona: 'reviewer', instruction: 'Write local review',
          output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
          rules: [{ condition: 'done', next: 'consume' }] },
        { name: 'consume', persona: 'consumer', instruction: 'Read {report:review.md}',
          input_reports: { from_step: 'other-producer', reports: 'all' },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
      report_formats: { 'review-format': 'Review' },
    }, project);
    const reportDir = join(project, '.takt', 'runs', 'test-report-dir', 'reports');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'review.md'), 'STALE_REVIEW');
    const promptedSteps: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      if (options?.executionPhase === 1 && options.workflowMeta?.currentStep) {
        promptedSteps.push(options.workflowMeta.currentStep);
      }
      return makeResponse({ persona: String(persona), content: 'done' });
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'local-producer') {
        throw new ReportPhaseGenerationError('report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      writePhaseReportFixture(context, 'other.md', 'CURRENT_OTHER_REPORT');
      onReportWritten?.('other.md');
    });
    engine = new WorkflowEngine(config, project, 'Review', createWorkflowCallOptions(project, {
      reportDirName: 'test-report-dir',
    }));
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(String(reason)));
    const state = await engine.run();
    expect(state.status).toBe('aborted');
    expect(abortReasons.join('; ')).toContain('review.md');
    expect(promptedSteps).toEqual(['other-producer', 'local-producer']);
  });

  it('does not pass a failed parent report through a child ancestor lookup', async () => {
    const childDir = join(project, '.takt', 'workflows');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'child.yaml'), [
      'name: child',
      'initial_step: consume',
      'subworkflow:',
      '  callable: true',
      'steps:',
      '  - name: consume',
      '    persona: consumer',
      '    instruction: "Read {report:review.md}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const config = normalizeWorkflowConfig({
      name: 'parent-report-failure', initial_step: 'review', max_steps: 2,
      steps: [
        { name: 'review', persona: 'reviewer', instruction: 'Review',
          output_contracts: { report: [{ name: 'review.md', format: 'review-format' }] },
          rules: [{ condition: 'done', next: 'delegate' }] },
        { name: 'delegate', kind: 'workflow_call', call: 'child',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
      ],
      report_formats: { 'review-format': 'Review' },
    }, project);
    const reportDir = join(project, '.takt', 'runs', 'test-report-dir', 'reports');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'review.md'), 'STALE_PARENT_REVIEW');
    const prompts: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      if (options?.executionPhase === 1 && options.workflowMeta?.currentStep === 'consume') {
        prompts.push(prompt);
      }
      return makeResponse({ persona: String(persona), content: 'done' });
    });
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    vi.mocked(runReportPhase).mockRejectedValue(new ReportPhaseGenerationError(
      'report failed', 'provider_error', { requiresFreshPhase1: false, failureReasons: ['provider_error'] },
    ));
    engine = new WorkflowEngine(config, project, 'Review', createWorkflowCallOptions(project, {
      reportDirName: 'test-report-dir',
    }));
    const reasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => reasons.push(String(reason)));
    const state = await engine.run();
    expect(state.status, reasons.join('; ')).toBe('completed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('（参照先の報告 review.md はこの run に存在しない）');
    expect(prompts[0]).not.toContain('STALE_PARENT_REVIEW');
  });
});
