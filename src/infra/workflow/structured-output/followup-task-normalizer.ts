import type {
  Language,
  WorkflowStep,
} from '../../../core/models/types.js';
import {
  createStructuredOutputNormalizerRegistry,
  type StructuredOutputFallbackContext,
  type StructuredOutputNormalizer,
  type StructuredOutputNormalizerRegistry,
} from '../../../core/workflow/engine/structured-output-normalizer.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('followup-task-output');
const FOLLOWUP_TASK_SCHEMA_REF = 'followup-task';
const FRESH_IMPROVEMENT_STEP = 'plan_fresh_improvement';
const ISSUE_PLANNING_FALLBACK_STEPS = new Set([
  'plan_from_issue',
  FRESH_IMPROVEMENT_STEP,
]);

type FollowupTaskType = 'feature' | 'bug' | 'chore' | 'docs';
type FollowupTaskAction = 'enqueue_new_task' | 'wait_before_next_scan';

interface FollowupTaskStructuredOutput {
  action: FollowupTaskAction;
  title: string;
  type: FollowupTaskType;
  scope: string;
  summary: string;
  goals: string[];
  acceptance_criteria: string[];
  labels?: string[];
  issue: {
    create: boolean;
  };
}

function stripMarkdownHeadingPrefix(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

function summarizeFallbackTask(taskMarkdown: string): string {
  const summary = taskMarkdown
    .split('\n')
    .map((line) => stripMarkdownHeadingPrefix(line))
    .find((line) => line.length > 0);
  if (summary === undefined) {
    throw new Error('Cannot build structured output fallback from empty task markdown');
  }
  return summary;
}

function requireStringArrayField(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`followup-task structured output requires string array field "${field}"`);
  }
  return value;
}

function requireFollowupTaskStructuredOutput(value: Record<string, unknown>): FollowupTaskStructuredOutput {
  const issue = value.issue;
  if (issue == null || typeof issue !== 'object' || Array.isArray(issue)) {
    throw new Error('followup-task structured output requires object field "issue"');
  }
  if (typeof (issue as Record<string, unknown>).create !== 'boolean') {
    throw new Error('followup-task structured output requires boolean field "issue.create"');
  }
  return {
    action: value.action as FollowupTaskAction,
    title: value.title as string,
    type: value.type as FollowupTaskType,
    scope: value.scope as string,
    summary: value.summary as string,
    goals: requireStringArrayField(value.goals, 'goals'),
    acceptance_criteria: requireStringArrayField(value.acceptance_criteria, 'acceptance_criteria'),
    ...(value.labels !== undefined ? { labels: requireStringArrayField(value.labels, 'labels') } : {}),
    issue: {
      create: (issue as Record<string, unknown>).create as boolean,
    },
  };
}

function renderFollowupTaskMarkdown(output: FollowupTaskStructuredOutput, language: Language | undefined): string {
  const headings = language === 'ja'
    ? { summary: '概要', goals: '目的', acceptanceCriteria: '受け入れ条件' }
    : { summary: 'Summary', goals: 'Goals', acceptanceCriteria: 'Acceptance Criteria' };
  return [
    `## ${headings.summary}`,
    output.summary,
    '',
    `## ${headings.goals}`,
    ...output.goals.map((goal) => `- ${goal}`),
    '',
    `## ${headings.acceptanceCriteria}`,
    ...output.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`),
  ].join('\n');
}

function createWaitStructuredOutput(): Record<string, unknown> {
  return {
    action: 'wait_before_next_scan',
    title: '',
    type: 'chore',
    scope: '',
    summary: '',
    goals: [],
    acceptance_criteria: [],
    labels: [],
    issue: {
      create: false,
    },
  };
}

function buildFollowupTaskStructuredFallback(
  stepName: string,
  taskMarkdown: string,
): Record<string, unknown> {
  const trimmedTask = taskMarkdown.trim();
  const summary = summarizeFallbackTask(trimmedTask);
  return {
    action: 'enqueue_new_task',
    title: summary,
    type: 'chore',
    scope: 'workflow',
    summary,
    goals: [summary],
    acceptance_criteria: [
      'Task requirements are captured in task_markdown.',
      'Completion can be verified against the task instruction.',
    ],
    labels: [],
    issue: {
      create: stepName === FRESH_IMPROVEMENT_STEP,
    },
  };
}

function hasFollowupTaskMetadataFields(value: Record<string, unknown> | undefined): boolean {
  return typeof value?.title === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.goals)
    && Array.isArray(value.acceptance_criteria)
    && value.issue != null
    && typeof value.issue === 'object'
    && !Array.isArray(value.issue);
}

function hasUnsupportedFollowupAction(value: Record<string, unknown> | undefined): boolean {
  return typeof value?.action === 'string'
    && value.action !== 'enqueue_new_task'
    && value.action !== 'wait_before_next_scan';
}

function shouldFallbackToWait(value: Record<string, unknown> | undefined): boolean {
  return value?.action === 'wait_before_next_scan';
}

function hasOnlyProviderErrorContent(context: StructuredOutputFallbackContext): boolean {
  const error = context.response.error?.trim();
  return error !== undefined
    && error.length > 0
    && context.response.content.trim() === error;
}

function normalizeFollowupTaskStructuredOutput(
  value: Record<string, unknown>,
  language: Language | undefined,
  options: { includeIssueTitle: boolean },
): Record<string, unknown> {
  const output = requireFollowupTaskStructuredOutput(value);
  return {
    ...value,
    task_markdown: renderFollowupTaskMarkdown(output, language),
    issue: {
      create: output.issue.create,
      ...(options.includeIssueTitle ? { title: output.title } : {}),
      labels: output.labels ?? [],
    },
  };
}

function assertFreshImprovementIssueCreation(step: WorkflowStep, output: FollowupTaskStructuredOutput): void {
  if (
    step.name === FRESH_IMPROVEMENT_STEP
    && output.action === 'enqueue_new_task'
    && output.issue.create !== true
  ) {
    throw new Error('plan_fresh_improvement enqueue_new_task requires issue.create to be true');
  }
}

function logStructuredOutputFallback(context: StructuredOutputFallbackContext): void {
  log.info('Structured output failed, falling back to task_markdown issue flow', {
    step: context.step.name,
    used_structured_output: false,
    structured_output_failure_reason: context.failureReason,
    error: context.detail,
  });
}

const followupTaskNormalizer: StructuredOutputNormalizer = {
  supports(step) {
    return step.structuredOutput?.schemaRef === FOLLOWUP_TASK_SCHEMA_REF;
  },

  normalize(value, context) {
    if (!hasFollowupTaskMetadataFields(value)) {
      return value;
    }
    const output = requireFollowupTaskStructuredOutput(value);
    assertFreshImprovementIssueCreation(context.step, output);
    return normalizeFollowupTaskStructuredOutput(value, context.language, { includeIssueTitle: true });
  },

  buildFailureFallback(context) {
    if (!ISSUE_PLANNING_FALLBACK_STEPS.has(context.step.name)) {
      return undefined;
    }
    if (hasUnsupportedFollowupAction(context.response.structuredOutput)) {
      return undefined;
    }
    if (shouldFallbackToWait(context.response.structuredOutput)) {
      const structuredOutput = createWaitStructuredOutput();
      context.validate(structuredOutput);
      logStructuredOutputFallback(context);
      return {
        ...context.response,
        status: 'done',
        error: undefined,
        failureCategory: undefined,
        structuredOutput: normalizeFollowupTaskStructuredOutput(
          structuredOutput,
          context.language,
          { includeIssueTitle: true },
        ),
      };
    }
    if (hasFollowupTaskMetadataFields(context.response.structuredOutput)) {
      return undefined;
    }
    if (context.response.content.trim().length === 0) {
      return undefined;
    }
    if (hasOnlyProviderErrorContent(context)) {
      return undefined;
    }

    const structuredOutput = buildFollowupTaskStructuredFallback(context.step.name, context.response.content);
    context.validate(structuredOutput);
    logStructuredOutputFallback(context);
    return {
      ...context.response,
      status: 'done',
      error: undefined,
      failureCategory: undefined,
      structuredOutput: normalizeFollowupTaskStructuredOutput(
        structuredOutput,
        context.language,
        { includeIssueTitle: false },
      ),
    };
  },
};

export function createDefaultStructuredOutputNormalizers(): StructuredOutputNormalizerRegistry {
  return createStructuredOutputNormalizerRegistry([followupTaskNormalizer]);
}
