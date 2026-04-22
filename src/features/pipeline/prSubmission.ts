import {
  buildPrBody,
  buildTaktManagedPrOptions,
  createPullRequestSafely,
  getGitProvider,
} from '../../infra/git/index.js';
import type { CreatePrResult, Issue } from '../../infra/git/index.js';
import type { PipelineConfig } from '../../core/models/index.js';
import type { PipelineExecutionOptions } from '../tasks/index.js';
import { error, info, success } from '../../shared/ui/index.js';
import { expandPipelineTemplate } from './templateExpander.js';

export interface PipelinePrTaskContent {
  issue?: Issue;
}

function buildPipelinePrBody(
  pipelineConfig: PipelineConfig | undefined,
  issue: Issue | undefined,
  report: string,
): string {
  const template = pipelineConfig?.prBodyTemplate;
  if (template) {
    return expandPipelineTemplate(template, {
      title: issue?.title ?? '',
      issue: issue ? String(issue.number) : '',
      issue_body: issue?.body || issue?.title || '',
      report,
    });
  }
  return buildPrBody(issue ? [issue] : undefined, report);
}

function requireBaseBranch(baseBranch: string | undefined): string {
  if (!baseBranch) {
    throw new Error('Base branch is required (pull request creation)');
  }
  return baseBranch;
}

export function submitPullRequest(
  projectCwd: string,
  branch: string,
  baseBranch: string | undefined,
  taskContent: PipelinePrTaskContent,
  workflow: string,
  pipelineConfig: PipelineConfig | undefined,
  options: Pick<PipelineExecutionOptions, 'task' | 'repo' | 'draftPr'>,
): string | undefined {
  info('Creating pull request...');
  const prTitle = taskContent.issue ? `[#${taskContent.issue.number}] ${taskContent.issue.title}` : (options.task ?? 'Pipeline task');
  const report = `Workflow \`${workflow}\` completed successfully.`;
  const prBody = buildPipelinePrBody(pipelineConfig, taskContent.issue, report);
  const managedPrOptions = buildTaktManagedPrOptions(prBody);

  const prResult: CreatePrResult = createPullRequestSafely(getGitProvider(), {
    branch,
    title: prTitle,
    ...managedPrOptions,
    base: requireBaseBranch(baseBranch),
    repo: options.repo,
    draft: options.draftPr,
  }, projectCwd);

  if (prResult.success) {
    success(`PR created: ${prResult.url}`);
    return prResult.url;
  }
  error(`PR creation failed: ${prResult.error}`);
  return undefined;
}
