import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

interface WorkflowStepRaw {
  name?: string;
  provider_options?: unknown;
  parallel?: WorkflowStepRaw[];
}

interface BuiltinWorkflowRaw {
  workflow_config?: {
    provider_options?: unknown;
  };
  knowledge?: Record<string, string>;
  steps?: WorkflowStepRaw[];
}

interface ProviderOptionsRefRaw {
  claude?: {
    allowed_tools?: string[];
  };
  opencode?: {
    allowed_tools?: string[];
  };
}

const REVIEW_READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
const REVIEW_READONLY_OPENCODE_TOOLS = ['read', 'glob', 'grep', 'bash', 'websearch', 'webfetch'];
const REVIEW_WEB_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const REVIEW_WEB_OPENCODE_TOOLS = ['read', 'glob', 'grep', 'websearch', 'webfetch'];
const REVIEW_FILES_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'];
const REVIEW_FILES_OPENCODE_TOOLS = ['read', 'glob', 'grep'];
const EDIT_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'];
const EDIT_OPENCODE_TOOLS = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'todowrite', 'websearch', 'webfetch'];
const REVIEW_READONLY_PROVIDER_OPTIONS = {
  claude: { allowedTools: REVIEW_READONLY_CLAUDE_TOOLS },
  opencode: { allowedTools: REVIEW_READONLY_OPENCODE_TOOLS },
};
const REVIEW_WEB_PROVIDER_OPTIONS = {
  claude: { allowedTools: REVIEW_WEB_CLAUDE_TOOLS },
  opencode: { allowedTools: REVIEW_WEB_OPENCODE_TOOLS },
};
const REVIEW_FILES_PROVIDER_OPTIONS = {
  claude: { allowedTools: REVIEW_FILES_CLAUDE_TOOLS },
  opencode: { allowedTools: REVIEW_FILES_OPENCODE_TOOLS },
};
const EDIT_PROVIDER_OPTIONS = {
  claude: { allowedTools: EDIT_CLAUDE_TOOLS },
  opencode: { allowedTools: EDIT_OPENCODE_TOOLS },
};
const REVIEW_READONLY_REF = { $ref: 'provider-options/review-readonly.yaml' };
const REVIEW_WEB_REF = { $ref: 'provider-options/review-web.yaml' };
const REVIEW_FILES_REF = { $ref: 'provider-options/review-files.yaml' };
const EDIT_REF = { $ref: 'provider-options/edit.yaml' };

function workflowDir(locale: 'en' | 'ja'): string {
  return join(process.cwd(), 'builtins', locale, 'workflows');
}

function loadBuiltinWorkflow(locale: 'en' | 'ja', name: string): BuiltinWorkflowRaw {
  const filePath = join(workflowDir(locale), name);
  return parseYaml(readFileSync(filePath, 'utf-8')) as BuiltinWorkflowRaw;
}

function loadProviderOptionsRef(locale: 'en' | 'ja', name: string): ProviderOptionsRefRaw {
  const filePath = join(workflowDir(locale), 'provider-options', name);
  return parseYaml(readFileSync(filePath, 'utf-8')) as ProviderOptionsRefRaw;
}

function normalizeBuiltinWorkflow(workflow: BuiltinWorkflowRaw, locale: 'en' | 'ja') {
  return normalizeWorkflowConfig({
    ...workflow,
    knowledge: {
      ...workflow.knowledge,
      takt: 'placeholder',
      architecture: 'placeholder',
      'task-decomposition': 'placeholder',
    },
  }, workflowDir(locale));
}

describe('builtin takt-default provider_options refs', () => {
  for (const locale of ['en', 'ja'] as const) {
    it(`${locale} takt-default should use provider_options refs with Claude and OpenCode tool sets`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'takt-default.yaml');
      const steps = new Map((workflow.steps ?? []).map((step) => [step.name, step]));
      const normalized = normalizeBuiltinWorkflow(workflow, locale);
      const normalizedSteps = new Map(normalized.steps.map((step) => [step.name, step]));

      expect(workflow.workflow_config?.provider_options).toEqual({
        codex: { network_access: true },
        opencode: { network_access: true },
      });
      expect(loadProviderOptionsRef(locale, 'review-readonly.yaml')).toEqual({
        claude: { allowed_tools: REVIEW_READONLY_CLAUDE_TOOLS },
        opencode: { allowed_tools: REVIEW_READONLY_OPENCODE_TOOLS },
      });
      expect(loadProviderOptionsRef(locale, 'review-web.yaml')).toEqual({
        claude: { allowed_tools: REVIEW_WEB_CLAUDE_TOOLS },
        opencode: { allowed_tools: REVIEW_WEB_OPENCODE_TOOLS },
      });
      expect(loadProviderOptionsRef(locale, 'review-files.yaml')).toEqual({
        claude: { allowed_tools: REVIEW_FILES_CLAUDE_TOOLS },
        opencode: { allowed_tools: REVIEW_FILES_OPENCODE_TOOLS },
      });
      expect(loadProviderOptionsRef(locale, 'edit.yaml')).toEqual({
        claude: { allowed_tools: EDIT_CLAUDE_TOOLS },
        opencode: { allowed_tools: EDIT_OPENCODE_TOOLS },
      });
      expect(steps.get('plan')?.provider_options).toEqual(REVIEW_READONLY_REF);
      expect(steps.get('write_tests')?.provider_options).toEqual(EDIT_REF);
      expect(steps.get('supervise')?.provider_options).toEqual(REVIEW_READONLY_REF);
      expect(normalizedSteps.get('plan')?.providerOptions).toMatchObject(REVIEW_READONLY_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('write_tests')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('supervise')?.providerOptions).toMatchObject(REVIEW_READONLY_PROVIDER_OPTIONS);
    });

    it(`${locale} draft subworkflow should resolve provider_options refs for OpenCode tools`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'draft.yaml');
      const steps = new Map((workflow.steps ?? []).map((step) => [step.name, step]));
      const normalized = normalizeBuiltinWorkflow(workflow, locale);
      const normalizedSteps = new Map(normalized.steps.map((step) => [step.name, step]));

      expect(steps.get('implement')?.provider_options).toEqual(EDIT_REF);
      expect(steps.get('ai-antipattern-review-1st')?.provider_options).toEqual(REVIEW_WEB_REF);
      expect(steps.get('ai-antipattern-fix')?.provider_options).toEqual(EDIT_REF);
      expect(steps.get('ai-antipattern-no-fix')?.provider_options).toEqual(REVIEW_FILES_REF);
      expect(normalizedSteps.get('implement')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('ai-antipattern-review-1st')?.providerOptions).toMatchObject(
        REVIEW_WEB_PROVIDER_OPTIONS,
      );
      expect(normalizedSteps.get('ai-antipattern-fix')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('ai-antipattern-no-fix')?.providerOptions).toMatchObject(
        REVIEW_FILES_PROVIDER_OPTIONS,
      );
    });

    it(`${locale} peer-review subworkflow should resolve provider_options refs for OpenCode tools`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');
      const steps = new Map((workflow.steps ?? []).map((step) => [step.name, step]));
      const reviewersStep = steps.get('reviewers');
      const reviewerSteps = new Map((reviewersStep?.parallel ?? []).map((step) => [step.name, step]));
      const normalized = normalizeBuiltinWorkflow(workflow, locale);
      const normalizedSteps = new Map(normalized.steps.map((step) => [step.name, step]));
      const normalizedReviewersStep = normalizedSteps.get('reviewers');
      const normalizedReviewerSteps = new Map(
        (normalizedReviewersStep?.parallel ?? []).map((step) => [step.name, step]),
      );
      const reviewerNames = [...reviewerSteps.keys()].filter((name) => name !== 'ai-antipattern-review-2nd');

      for (const name of reviewerNames) {
        expect(reviewerSteps.get(name)?.provider_options).toEqual(REVIEW_READONLY_REF);
        expect(normalizedReviewerSteps.get(name)?.providerOptions).toMatchObject(
          REVIEW_READONLY_PROVIDER_OPTIONS,
        );
      }
      expect(reviewerSteps.get('ai-antipattern-review-2nd')?.provider_options).toEqual(REVIEW_WEB_REF);
      expect(normalizedReviewerSteps.get('ai-antipattern-review-2nd')?.providerOptions).toMatchObject(
        REVIEW_WEB_PROVIDER_OPTIONS,
      );
      expect(steps.get('fix')?.provider_options).toEqual(EDIT_REF);
      expect(normalizedSteps.get('fix')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
    });
  }
});
