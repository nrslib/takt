import { readFileSync } from 'node:fs';
import {
  createCliReviewSession,
  prepareWorkingDirectory,
  rewriteWorkingDirectoryPaths,
} from './cli-review.mjs';
import {
  renderAdjudicationPrompt,
  resolveAdjudicationPrompt,
} from './cli-review-adjudication.mjs';

export default class CliPlanReportProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.prepareWorkingDirectory = dependencies.prepareWorkingDirectory ?? prepareWorkingDirectory;
    this.createCliReviewSession = dependencies.createCliReviewSession ?? createCliReviewSession;
    this.readPrompt = dependencies.readPrompt ?? ((path) => readFileSync(path, 'utf8'));
  }

  id() {
    return `cli-plan-report:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, context, options = {}) {
    let workingDirectory;
    let phase = 'phase1';
    try {
      const { task, output_phase: outputPhase } = context.vars;
      if (typeof task !== 'string' || !['phase1', 'phase2'].includes(outputPhase)) {
        throw new Error('Plan report requires task and output_phase (phase1 or phase2)');
      }
      workingDirectory = this.prepareWorkingDirectory(this.config);
      const session = this.createCliReviewSession(this.config, {
        cwd: workingDirectory.cwd,
        abortSignal: options.abortSignal,
      });
      const analysis = await session.run(rewriteWorkingDirectoryPaths(prompt, workingDirectory));
      if (outputPhase === 'phase1') return { output: analysis };

      phase = 'phase2';
      const template = this.readPrompt(resolveAdjudicationPrompt(this.config.report_prompt));
      const reportPrompt = rewriteWorkingDirectoryPaths(renderAdjudicationPrompt(template, {
        task,
        previousResponse: analysis,
        scenario: '',
      }), workingDirectory);
      const report = await session.run(reportPrompt);
      return { output: report, metadata: { phase1_response: analysis } };
    } catch (error) {
      return { error: `Plan report ${phase} failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
