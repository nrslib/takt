import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareWorkingDirectory,
  rewriteWorkingDirectoryPaths,
  createCliReviewSession,
} from './cli-review.mjs';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function renderAdjudicationPrompt(prompt, variables) {
  const values = {
    task: variables.task,
    previous_response: variables.previousResponse,
    scenario: variables.scenario,
  };
  return prompt.replaceAll(
    /{{(task|previous_response|scenario)}}/g,
    (_placeholder, name) => values[name],
  );
}

export function resolveAdjudicationPrompt(path, root = evalDirectory) {
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Adjudication prompt must be under the eval directory: ${path}`);
  }
  return resolved;
}

export function writeReviewerReport(cwd, fileName, content) {
  if (fileName.length === 0 || basename(fileName) !== fileName) {
    throw new Error(`Reviewer report must be a file name: ${fileName}`);
  }
  const reportDirectory = join(cwd, '.takt', 'runs', 'eval', 'reports');
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, fileName), content);
}

export function formatAdjudicationOutput(reviewerFile, reviewer, adjudicationFile, adjudication) {
  return [
    `# ${reviewerFile}`,
    reviewer,
    '',
    `# ${adjudicationFile}`,
    adjudication,
  ].join('\n');
}

function requiredVariable(context, name) {
  const value = context.vars?.[name];
  if (typeof value !== 'string') {
    throw new Error(`Review adjudication requires string variable "${name}"`);
  }
  return value;
}

export default class CliReviewAdjudicationProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.prepareWorkingDirectory = dependencies.prepareWorkingDirectory ?? prepareWorkingDirectory;
    this.createCliReviewSession = dependencies.createCliReviewSession ?? createCliReviewSession;
    this.readPrompt = dependencies.readPrompt ?? ((path) => readFileSync(path, 'utf8'));
  }

  id() {
    return `cli-review-adjudication:${this.config.cli}:${this.config.model}`;
  }

  async callApi(reviewerPrompt, context, options = {}) {
    let workingDirectory;

    try {
      workingDirectory = this.prepareWorkingDirectory(this.config);
      const { cwd } = workingDirectory;
      const variables = {
        task: requiredVariable(context, 'task'),
        previousResponse: '',
        scenario: '',
      };
      const reviewerSession = this.createCliReviewSession(this.config, {
        cwd,
        abortSignal: options.abortSignal,
      });
      const adjudicationSession = this.createCliReviewSession(this.config, {
        cwd,
        abortSignal: options.abortSignal,
      });
      const runStage = async (session, name, prompt) => {
        try {
          return await session.run(prompt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Review adjudication stage "${name}" failed: ${message}`, { cause: error });
        }
      };

      const reviewer = await runStage(
        reviewerSession,
        'reviewer-analysis',
        rewriteWorkingDirectoryPaths(reviewerPrompt, workingDirectory),
      );
      const reviewerReportTemplate = this.readPrompt(
        resolveAdjudicationPrompt(this.config.reviewer_report_prompt),
      );
      const reviewerReport = await runStage(
        reviewerSession,
        'reviewer-report',
        rewriteWorkingDirectoryPaths(
          renderAdjudicationPrompt(reviewerReportTemplate, {
            ...variables,
            previousResponse: reviewer,
          }),
          workingDirectory,
        ),
      );
      writeReviewerReport(cwd, this.config.reviewer_report, reviewerReport);

      const adjudicationTemplate = this.readPrompt(
        resolveAdjudicationPrompt(this.config.adjudication_prompt),
      );
      const adjudication = await runStage(
        adjudicationSession,
        'adjudication-analysis',
        rewriteWorkingDirectoryPaths(
          renderAdjudicationPrompt(adjudicationTemplate, variables),
          workingDirectory,
        ),
      );
      const adjudicationReportTemplate = this.readPrompt(
        resolveAdjudicationPrompt(this.config.adjudication_report_prompt),
      );
      const adjudicationReport = await runStage(
        adjudicationSession,
        'adjudication-report',
        rewriteWorkingDirectoryPaths(
          renderAdjudicationPrompt(adjudicationReportTemplate, {
            ...variables,
            previousResponse: adjudication,
          }),
          workingDirectory,
        ),
      );

      return {
        output: formatAdjudicationOutput(
          this.config.reviewer_report,
          reviewerReport,
          this.config.adjudication_report,
          adjudicationReport,
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
