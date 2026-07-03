import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { getRepertoireDir } from '../infra/config/paths.js';

interface WorkflowStepRaw {
  name?: string;
  call?: string;
  args?: Record<string, unknown>;
  provider_options?: unknown;
  parallel?: WorkflowStepRaw[];
  rules?: Array<{ condition?: string; next?: string; return?: string }>;
  output_contracts?: {
    report?: Array<{ format?: string }>;
  };
}

interface BuiltinWorkflowRaw {
  finding_contract?: unknown;
  workflow_config?: {
    provider_options?: unknown;
  };
  knowledge?: Record<string, string>;
  steps?: WorkflowStepRaw[];
}

interface ProviderOptionsPresetRaw {
  claude?: {
    allowed_tools?: string[];
  };
  opencode?: {
    allowed_tools?: string[];
  };
}

const REVIEW_READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
const REVIEW_READONLY_OPENCODE_TOOLS = ['read', 'glob', 'grep', 'bash', 'websearch', 'webfetch'];
const REVIEW_FILES_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'];
const REVIEW_FILES_OPENCODE_TOOLS = ['read', 'glob', 'grep'];
const EDIT_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'];
const EDIT_OPENCODE_TOOLS = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'todowrite', 'websearch', 'webfetch'];
const REVIEW_READONLY_PROVIDER_OPTIONS = {
  claude: { allowedTools: REVIEW_READONLY_CLAUDE_TOOLS },
  opencode: { allowedTools: REVIEW_READONLY_OPENCODE_TOOLS },
};
const REVIEW_FILES_PROVIDER_OPTIONS = {
  claude: { allowedTools: REVIEW_FILES_CLAUDE_TOOLS },
  opencode: { allowedTools: REVIEW_FILES_OPENCODE_TOOLS },
};
const EDIT_PROVIDER_OPTIONS = {
  claude: { allowedTools: EDIT_CLAUDE_TOOLS },
  opencode: { allowedTools: EDIT_OPENCODE_TOOLS },
};
const REVIEW_READONLY_EXTENDS = { extends: 'review-readonly' };
const REVIEW_FILES_EXTENDS = { extends: 'review-files' };
const EDIT_EXTENDS = { extends: 'edit' };
const PEER_REVIEW_PARALLEL_OUTPUT_CONTRACTS = [
  'architecture-review',
  'security-review',
  'qa-review',
  'testing-review',
  'coding-review',
  'ai-antipattern-review',
] as const;
const PEER_REVIEW_OUTPUT_CONTRACTS = [
  ...PEER_REVIEW_PARALLEL_OUTPUT_CONTRACTS,
  'merge-readiness-review',
] as const;

function workflowDir(locale: 'en' | 'ja'): string {
  return join(process.cwd(), 'builtins', locale, 'workflows');
}

function loadBuiltinWorkflow(locale: 'en' | 'ja', name: string): BuiltinWorkflowRaw {
  const filePath = join(workflowDir(locale), name);
  return parseYaml(readFileSync(filePath, 'utf-8')) as BuiltinWorkflowRaw;
}

function loadProviderOptionsPreset(locale: 'en' | 'ja', name: string): ProviderOptionsPresetRaw {
  const filePath = join(process.cwd(), 'builtins', locale, 'provider-options', name);
  return parseYaml(readFileSync(filePath, 'utf-8')) as ProviderOptionsPresetRaw;
}

function outputFormats(steps: WorkflowStepRaw[]): string[] {
  return steps.flatMap((step) =>
    (step.output_contracts?.report ?? [])
      .map((entry) => entry.format)
      .filter((format): format is string => format !== undefined),
  );
}

function outputContractPath(locale: 'en' | 'ja', name: string): string {
  return join(process.cwd(), 'builtins', locale, 'facets', 'output-contracts', `${name}.md`);
}

function instructionPath(locale: 'en' | 'ja', name: string): string {
  return join(process.cwd(), 'builtins', locale, 'facets', 'instructions', `${name}.md`);
}

function personaPath(locale: 'en' | 'ja', name: string): string {
  return join(process.cwd(), 'builtins', locale, 'facets', 'personas', `${name}.md`);
}

function normalizeBuiltinWorkflow(workflow: BuiltinWorkflowRaw, locale: 'en' | 'ja', projectDir?: string) {
  const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-builtin-provider-options-global-'));
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;
  try {
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    const context = {
      lang: locale,
      ...(projectDir ? { projectDir } : {}),
      workflowDir: workflowDir(locale),
      repertoireDir: getRepertoireDir(),
    };
    return normalizeWorkflowConfig({
      ...workflow,
      knowledge: {
        ...workflow.knowledge,
        takt: 'placeholder',
        architecture: 'placeholder',
        'task-decomposition': 'placeholder',
      },
    }, workflowDir(locale), context);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    rmSync(globalConfigDir, { recursive: true, force: true });
  }
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
      expect(loadProviderOptionsPreset(locale, 'review-readonly.yaml')).toEqual({
        claude: { allowed_tools: REVIEW_READONLY_CLAUDE_TOOLS },
        opencode: { allowed_tools: REVIEW_READONLY_OPENCODE_TOOLS },
      });
      expect(loadProviderOptionsPreset(locale, 'review-files.yaml')).toEqual({
        claude: { allowed_tools: REVIEW_FILES_CLAUDE_TOOLS },
        opencode: { allowed_tools: REVIEW_FILES_OPENCODE_TOOLS },
      });
      expect(loadProviderOptionsPreset(locale, 'edit.yaml')).toEqual({
        claude: { allowed_tools: EDIT_CLAUDE_TOOLS },
        opencode: { allowed_tools: EDIT_OPENCODE_TOOLS },
      });
      expect(steps.get('plan')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(steps.get('write_tests')?.provider_options).toEqual(EDIT_EXTENDS);
      expect(steps.get('supervise')).toBeUndefined();
      expect(steps.get('peer-review')?.rules?.find((rule) => rule.condition === 'COMPLETE')?.next).toBe('COMPLETE');
      expect(normalizedSteps.get('plan')?.providerOptions).toMatchObject(REVIEW_READONLY_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('write_tests')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
    });

    it(`${locale} draft subworkflow should resolve provider_options refs for OpenCode tools`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'draft.yaml');
      const steps = new Map((workflow.steps ?? []).map((step) => [step.name, step]));
      const normalized = normalizeBuiltinWorkflow(workflow, locale);
      const normalizedSteps = new Map(normalized.steps.map((step) => [step.name, step]));

      expect(steps.get('implement')?.provider_options).toEqual(EDIT_EXTENDS);
      expect(steps.get('ai-antipattern-review-1st')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(steps.get('ai-antipattern-fix')?.provider_options).toEqual(EDIT_EXTENDS);
      expect(steps.get('ai-antipattern-no-fix')?.provider_options).toEqual(REVIEW_FILES_EXTENDS);
      expect(normalizedSteps.get('implement')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('ai-antipattern-review-1st')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
      expect(normalizedSteps.get('ai-antipattern-fix')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);
      expect(normalizedSteps.get('ai-antipattern-no-fix')?.providerOptions).toMatchObject(
        REVIEW_FILES_PROVIDER_OPTIONS,
      );
    });

    it(`${locale} builtin workflow provider_options refs should be shadowed by project presets`, () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'takt-builtin-provider-options-shadow-'));
      try {
        const projectProviderOptionsDir = join(projectDir, '.takt', 'provider-options');
        mkdirSync(projectProviderOptionsDir, { recursive: true });
        writeFileSync(
          join(projectProviderOptionsDir, 'review-files.yaml'),
          'claude:\n  allowed_tools:\n    - Write\nopencode:\n  allowed_tools:\n    - write\n',
          'utf-8',
        );

        const workflow = loadBuiltinWorkflow(locale, 'draft.yaml');
        const normalized = normalizeBuiltinWorkflow(workflow, locale, projectDir);
        const normalizedSteps = new Map(normalized.steps.map((step) => [step.name, step]));

        expect(normalizedSteps.get('ai-antipattern-no-fix')?.providerOptions?.claude?.allowedTools).toEqual(['Write']);
        expect(normalizedSteps.get('ai-antipattern-no-fix')?.providerOptions?.opencode?.allowedTools).toEqual(['write']);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
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
        expect(reviewerSteps.get(name)?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
        expect(normalizedReviewerSteps.get(name)?.providerOptions).toMatchObject(
          REVIEW_READONLY_PROVIDER_OPTIONS,
        );
      }
      expect(reviewerSteps.get('ai-antipattern-review-2nd')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(normalizedReviewerSteps.get('ai-antipattern-review-2nd')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
      expect(steps.get('final-gate')?.call).toBe('merge-readiness-final-gate');
      expect(steps.get('fix')?.provider_options).toEqual(EDIT_EXTENDS);
      expect(normalizedSteps.get('fix')?.providerOptions).toMatchObject(EDIT_PROVIDER_OPTIONS);

      const finalGateWorkflow = loadBuiltinWorkflow(locale, 'merge-readiness-final-gate.yaml');
      const finalGate = finalGateWorkflow.steps?.find((step) => step.name === 'final_gate');
      const finalGateSteps = new Map((finalGate?.parallel ?? []).map((step) => [step.name, step]));
      const normalizedFinalGate = normalizeBuiltinWorkflow(finalGateWorkflow, locale);
      const normalizedFinalGateStep = normalizedFinalGate.steps.find((step) => step.name === 'final_gate');
      const normalizedFinalGateSteps = new Map(
        (normalizedFinalGateStep?.parallel ?? []).map((step) => [step.name, step]),
      );

      expect(finalGateSteps.get('merge-readiness-review')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(finalGateSteps.get('supervise')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(normalizedFinalGateSteps.get('merge-readiness-review')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
      expect(normalizedFinalGateSteps.get('supervise')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
    });

    it(`${locale} takt-default should not enable Finding Contract`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'takt-default.yaml');
      const normalized = normalizeBuiltinWorkflow(workflow, locale);

      expect(workflow.finding_contract).toBeUndefined();
      expect(normalized.findingContract).toBeUndefined();
    });

    it(`${locale} peer-review subworkflow should not enable Finding Contract`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');
      const normalized = normalizeBuiltinWorkflow(workflow, locale);

      expect(workflow.finding_contract).toBeUndefined();
      expect(normalized.findingContract).toBeUndefined();
    });

    it(`${locale} peer-review-with-fc subworkflow should enable Finding Contract`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review-with-fc.yaml');
      const normalized = normalizeBuiltinWorkflow(workflow, locale);

      expect(workflow.finding_contract).toEqual({
        ledger_path: '.takt/findings/peer-review-with-fc.json',
        raw_findings_path: '.takt/findings/peer-review-with-fc/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      });
      expect(normalized.findingContract).toMatchObject({
        ledgerPath: '.takt/findings/peer-review-with-fc.json',
        rawFindingsPath: '.takt/findings/peer-review-with-fc/raw',
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'findings-manager',
          personaPath: personaPath(locale, 'findings-manager'),
          instruction: readFileSync(instructionPath(locale, 'findings-manager'), 'utf-8'),
          outputContract: readFileSync(outputContractPath(locale, 'findings-manager'), 'utf-8'),
        },
      });
      const reviewers = normalized.steps.find((step) => step.name === 'reviewers');
      expect(reviewers?.rules?.map((rule) => rule.condition)).toEqual([
        'all("approved") && findings.open.count == 0 && findings.conflicts.count == 0',
        'any("needs_fix") && findings.conflicts.count == 0',
        'findings.conflicts.count == 0 && findings.open.count > 0',
        expect.stringContaining('findings.conflicts'),
        'findings.conflicts.count > 0',
      ]);
      expect(reviewers?.rules?.[0]).toMatchObject({
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
        aggregateGuardCondition: 'findings.open.count == 0 && findings.conflicts.count == 0',
      });
      expect(reviewers?.rules?.[1]).toMatchObject({
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateConditionText: 'needs_fix',
        aggregateGuardCondition: 'findings.conflicts.count == 0',
      });

      const mergeReadiness = normalized.steps.find((step) => step.name === 'merge-readiness-review');
      expect(mergeReadiness?.rules).toEqual([
        expect.objectContaining({
          condition: 'approved && findings.open.count == 0 && findings.conflicts.count == 0',
          next: 'COMPLETE',
        }),
        expect.objectContaining({
          condition: 'needs_fix && findings.conflicts.count == 0',
          next: 'fix',
        }),
        expect.objectContaining({
          condition: 'findings.conflicts.count == 0 && findings.open.count > 0',
          next: 'fix',
        }),
        expect.objectContaining({
          condition: expect.stringContaining('findings.conflicts'),
          next: 'fix',
          isAiCondition: true,
        }),
        expect.objectContaining({
          condition: 'findings.conflicts.count > 0',
          next: '',
          returnValue: 'need_replan',
        }),
      ]);
    });

    it(`${locale} peer-review should use standard output contracts`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const finalGateWorkflow = loadBuiltinWorkflow(locale, 'merge-readiness-final-gate.yaml');
      const finalGate = finalGateWorkflow.steps?.find((step) => step.name === 'final_gate');
      const mergeReadiness = finalGate?.parallel?.find((step) => step.name === 'merge-readiness-review');
      const reviewerFormats = outputFormats(reviewers);
      const formats = outputFormats([...reviewers, ...(mergeReadiness ? [mergeReadiness] : [])]);

      expect(reviewerFormats).toEqual([...PEER_REVIEW_PARALLEL_OUTPUT_CONTRACTS]);
      expect(formats).toEqual([...PEER_REVIEW_OUTPUT_CONTRACTS]);
    });

    it(`${locale} peer-review should forward arch_knowledge into final-gate supervise knowledge`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');
      const finalGate = workflow.steps?.find((step) => step.name === 'final-gate');

      expect(finalGate?.args).toEqual({
        supervise_knowledge: { $param: 'arch_knowledge' },
      });
    });

    it(`${locale} peer-review-with-fc should use Finding Contract-specific output contracts`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review-with-fc.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const mergeReadiness = workflow.steps?.find((step) => step.name === 'merge-readiness-review');
      const reviewerFormats = outputFormats(reviewers);
      const formats = outputFormats([...reviewers, ...(mergeReadiness ? [mergeReadiness] : [])]);

      expect(reviewerFormats).toEqual(
        PEER_REVIEW_PARALLEL_OUTPUT_CONTRACTS.map((contract) => `${contract}-finding-contract`),
      );
      expect(formats).toEqual(PEER_REVIEW_OUTPUT_CONTRACTS.map((contract) => `${contract}-finding-contract`));

      for (const contract of PEER_REVIEW_OUTPUT_CONTRACTS) {
        const findingContractContent = readFileSync(outputContractPath(locale, `${contract}-finding-contract`), 'utf-8');
        const legacyContent = readFileSync(outputContractPath(locale, contract), 'utf-8');

        expect(findingContractContent).not.toContain('finding_id');
        expect(findingContractContent).not.toContain('persists');
        expect(findingContractContent).not.toContain('resolved');
        expect(findingContractContent).not.toContain('reopened');
        expect(legacyContent).toContain('finding_id');
      }
    });
  }
});
