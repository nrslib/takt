import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { getRepertoireDir } from '../infra/config/paths.js';

interface WorkflowStepRaw {
  name?: string;
  tags?: string[];
  edit?: boolean;
  persona?: string;
  instruction?: string;
  session?: string;
  session_key?: string;
  provider?: string;
  model?: string;
  policy?: string | string[];
  knowledge?: string[] | { $param: string };
  pass_previous_response?: boolean;
  call?: string;
  args?: Record<string, unknown>;
  provider_options?: unknown;
  parallel?: WorkflowStepRaw[];
  rules?: Array<{ condition?: string; next?: string; return?: string; appendix?: unknown }>;
  output_contracts?: {
    report?: Array<{ name?: string; format?: string; use_judge?: boolean }>;
  };
}

interface BuiltinWorkflowRaw {
  finding_contract?: unknown;
  subworkflow?: {
    requires_finding_contract?: boolean;
  };
  loop_monitors?: Array<{
    cycle?: string[];
    threshold?: number;
    judge?: {
      rules?: Array<{ condition?: string; next?: string }>;
    };
  }>;
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

function collectSteps(steps: WorkflowStepRaw[], parentPath = ''): Array<{ path: string; step: WorkflowStepRaw }> {
  return steps.flatMap((step) => {
    const path = parentPath ? `${parentPath}/${step.name ?? 'unnamed'}` : step.name ?? 'unnamed';
    return [{ path, step }, ...collectSteps(step.parallel ?? [], path)];
  });
}

function outputContractPath(locale: 'en' | 'ja', name: string): string {
  return join(process.cwd(), 'builtins', locale, 'facets', 'output-contracts', `${name}.md`);
}

function reviewStepConfiguration(reviewer: WorkflowStepRaw) {
  return {
    name: reviewer.name,
    persona: reviewer.persona,
    policy: reviewer.policy,
    knowledge: reviewer.knowledge,
    instruction: reviewer.instruction,
    session: reviewer.session,
    session_key: reviewer.session_key,
    provider: reviewer.provider,
    model: reviewer.model,
    provider_options: reviewer.provider_options,
    report: reviewer.output_contracts?.report,
  };
}

function reviewerOutputFormat(reviewer: WorkflowStepRaw): string {
  const formats = outputFormats([reviewer]);
  expect(formats, `${reviewer.name} should have exactly one report format`).toHaveLength(1);
  return formats[0];
}

function markdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start, `missing ${heading}`).toBeGreaterThanOrEqual(0);
  const next = content.indexOf('\n## ', start + heading.length);
  return content.slice(start, next === -1 ? undefined : next);
}

function markdownTableCount(content: string): number {
  return (content.match(/^\|[^\n]+\|\n\|[-| ]+\|$/gm) ?? []).length;
}

function markdownContractLineCount(content: string): number {
  const match = content.match(/^```markdown\n([\s\S]*?)\n```$/m);
  expect(match, 'output contract should have a markdown code block').not.toBeNull();
  return match![1].split('\n').length;
}

function ruleSignatures(step: WorkflowStepRaw): Array<{ condition: string | undefined; next: string | undefined }> {
  return (step.rules ?? []).map(({ condition, next, return: returnValue }) => ({
    condition,
    next: next ?? returnValue,
  }));
}

type Locale = 'en' | 'ja';
type ReviewRuleCategory =
  | 'approved'
  | 'needs-fix'
  | 'need-replan'
  | 'ai-no-issues'
  | 'ai-issues'
  | 'fix-required'
  | 'no-fix-needed'
  | 'all-approved'
  | 'anomaly'
  | 'anomaly-vote'
  | 'fixpoint'
  | 'budget-exhausted'
  | 'provisional'
  | 'any-needs-fix'
  | 'open-findings'
  | 'unadjudicated-conflicts'
  | 'conflicts';

interface ReviewStepExpectation {
  name: string;
  persona: string | undefined;
  policy: string | string[] | undefined;
  knowledge: string[] | { $param: string } | undefined;
  instruction: string | undefined;
  session: string | undefined;
  session_key: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  provider_options: unknown;
  report: Array<{ name?: string; format?: string; use_judge?: boolean }> | undefined;
}

function expectedReviewStep(overrides: Omit<ReviewStepExpectation, 'provider' | 'model'>): ReviewStepExpectation {
  return { ...overrides, provider: undefined, model: undefined };
}

function reviewRuleCategory(rule: NonNullable<WorkflowStepRaw['rules']>[number], locale: Locale): ReviewRuleCategory {
  const condition = rule.condition;
  expect(condition, 'review rules must have a condition').toBeDefined();
  const aiNoIssues = locale === 'ja' ? 'AI特有の問題なし' : 'No AI-specific issues';
  const aiIssues = locale === 'ja' ? 'AI特有の問題あり' : 'AI-specific issues found';

  if (condition === 'approved' || condition?.startsWith('approved &&')) return 'approved';
  if (condition === 'needs_fix' || condition?.startsWith('needs_fix &&')) return 'needs-fix';
  if (condition === 'need_replan' || condition?.startsWith('need_replan &&')) return 'need-replan';
  if (condition === aiNoIssues) return 'ai-no-issues';
  if (condition === aiIssues) return 'ai-issues';
  if (condition?.includes(locale === 'ja' ? '修正すべき' : 'fix required')) return 'fix-required';
  if (condition?.includes(locale === 'ja' ? '修正不要' : 'no fix needed')) return 'no-fix-needed';
  if (condition?.includes('findings.provisional.fixpoint')) return 'fixpoint';
  if (condition?.includes('findings.rounds.budgetExhausted')) return 'budget-exhausted';
  if (condition?.includes('findings.provisional.count')) return 'provisional';
  if (condition?.includes('findings.conflicts.unadjudicated')) return 'unadjudicated-conflicts';
  if (condition?.includes('findings.open.count > 0')) return 'open-findings';
  if (condition?.includes('findings.conflicts.count > 0')) return 'conflicts';
  if (condition?.includes('reviewerAnomalies')) return condition.includes('any(') ? 'anomaly-vote' : 'anomaly';
  if (condition?.includes('all(')) return 'all-approved';
  if (condition?.includes('any(')) return 'any-needs-fix';
  throw new Error(`unknown review-rule category: ${condition}`);
}

function expectReviewRules(
  step: WorkflowStepRaw,
  locale: Locale,
  categories: ReviewRuleCategory[],
  next: Array<string | undefined>,
): void {
  const rules = step.rules ?? [];
  expect(rules).toHaveLength(categories.length);
  expect(rules.map((rule) => rule.next ?? rule.return)).toEqual(next);
  expect(rules.map((rule) => reviewRuleCategory(rule, locale))).toEqual(categories);
  for (const rule of rules) {
    expect(rule).not.toHaveProperty('appendix');
  }
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
      const finalGateSteps = new Map((finalGateWorkflow.steps ?? []).map((step) => [step.name, step]));
      const normalizedFinalGate = normalizeBuiltinWorkflow(finalGateWorkflow, locale);
      const normalizedFinalGateSteps = new Map(normalizedFinalGate.steps.map((step) => [step.name, step]));

      expect(finalGateSteps.get('merge-readiness-review')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(finalGateSteps.get('supervise')?.provider_options).toEqual(REVIEW_READONLY_EXTENDS);
      expect(normalizedFinalGateSteps.get('merge-readiness-review')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
      expect(normalizedFinalGateSteps.get('supervise')?.providerOptions).toMatchObject(
        REVIEW_READONLY_PROVIDER_OPTIONS,
      );
    });

    it(`${locale} should run merge-readiness before every final supervisor`, () => {
      let sequentialGateCount = 0;

      for (const file of readdirSync(workflowDir(locale)).filter((name) => name.endsWith('.yaml'))) {
        const workflow = loadBuiltinWorkflow(locale, file);
        const steps = workflow.steps ?? [];

        for (const step of steps) {
          const parallel = step.parallel ?? [];
          const hasMergeReadiness = parallel.some((child) => child.name === 'merge-readiness-review');
          const hasSupervisor = parallel.some((child) => (
            child.name !== 'merge-readiness-review'
            && ((child.tags ?? []).includes('supervise') || ['supervisor', 'dual-supervisor'].includes(child.persona ?? ''))
          ));
          expect(hasMergeReadiness && hasSupervisor, `${file}:${step.name} must not race evidence production`).toBe(false);
        }

        const mergeReadinessIndex = steps.findIndex((step) => step.name === 'merge-readiness-review');
        if (mergeReadinessIndex < 0) continue;
        const supervisor = steps[mergeReadinessIndex + 1];
        expect(supervisor, `${file}: supervisor must follow merge-readiness-review`).toBeDefined();
        expect(
          (supervisor?.tags ?? []).includes('supervise')
            || ['supervisor', 'dual-supervisor'].includes(supervisor?.persona ?? ''),
          `${file}: merge-readiness consumer`,
        ).toBe(true);
        const approvedRule = steps[mergeReadinessIndex].rules?.find((rule) => rule.condition?.startsWith('approved'));
        expect(approvedRule?.next, `${file}: approved merge-readiness transition`).toBe(supervisor?.name);
        sequentialGateCount += 1;
      }

      expect(sequentialGateCount).toBe(12);
    });

    it(`${locale} loop monitors should reference existing workflow steps`, () => {
      for (const file of readdirSync(workflowDir(locale)).filter((name) => name.endsWith('.yaml'))) {
        const workflow = loadBuiltinWorkflow(locale, file);
        const stepNames = new Set((workflow.steps ?? []).map((step) => step.name));

        for (const monitor of workflow.loop_monitors ?? []) {
          for (const stepName of monitor.cycle ?? []) {
            expect(stepNames.has(stepName), `${file}: loop monitor step ${stepName}`).toBe(true);
          }
        }
      }
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

    it(`${locale} peer-review should abort both unproductive fix loops`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');

      expect(workflow.loop_monitors?.map((monitor) => monitor.cycle)).toEqual([
        ['reviewers', 'fix'],
        ['reviewers', 'final-gate', 'fix'],
      ]);
      for (const monitor of workflow.loop_monitors ?? []) {
        expect(monitor.threshold).toBe(5);
        expect(monitor.judge?.rules?.map((rule) => rule.next)).toEqual([
          'reviewers',
          'ABORT',
        ]);
      }
    });

    it(`${locale} takt-default-for-local-llm should enable Finding Contract`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'takt-default-for-local-llm.yaml');
      const normalized = normalizeBuiltinWorkflow(workflow, locale);

      expect(workflow.finding_contract).toEqual({
        ledger_path: '.takt/findings/takt-default-for-local-llm.json',
        raw_findings_path: '.takt/findings/takt-default-for-local-llm/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          output_contract: 'findings-manager',
        },
      });
      expect(normalized.findingContract).toMatchObject({
        ledgerPath: '.takt/findings/takt-default-for-local-llm.json',
        rawFindingsPath: '.takt/findings/takt-default-for-local-llm/raw',
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'findings-manager',
          providerRoutingPersonaKey: 'findings-manager',
          personaPath: personaPath(locale, 'findings-manager'),
          instruction: readFileSync(instructionPath(locale, 'findings-manager'), 'utf-8'),
          outputContract: readFileSync(outputContractPath(locale, 'findings-manager'), 'utf-8'),
        },
        // Phase B (codex B6): finding-conflict-adjudication を配線しているため、
        // supervisor persona が facet ファイルまで解決されている（personaPath が
        // 無いと facet 本文が system prompt に載らない）。
        adjudicator: {
          providerRoutingPersonaKey: 'supervisor',
          personaPath: personaPath(locale, 'supervisor'),
        },
      });
      const antipatternOk = locale === 'ja' ? 'AI特有の問題なし' : 'No AI-specific issues';
      const antipatternNg = locale === 'ja' ? 'AI特有の問題あり' : 'AI-specific issues found';
      const reviewers = normalized.steps.find((step) => step.name === 'reviewers');
      expect(reviewers?.rules?.map((rule) => rule.condition)).toEqual([
        `all("approved", "${antipatternOk}", "approved", "approved", "approved", "approved") && when(findings.open.count == 0 && findings.conflicts.count == 0)`,
        // codex 対策#4 / 検証ブロッカー#1: product gate が空でも未昇格 anomaly が
        // 残るなら fix へ落とさず merge-readiness-review（再レビュー/裁定）へ渡す。
        `any("approved", "needs_fix", "${antipatternOk}", "${antipatternNg}") && when(findings.open.count == 0 && findings.conflicts.count == 0 && findings.reviewerAnomalies.count > 0)`,
        // 対策バッチ B1: provisional が直前ラウンドから意味的な変化の無い
        // fixpoint に達した場合、再計画では解消し得ない。plan への差し戻しの
        // 前に、要人手裁定の終端状態へルーティングする。
        'when(findings.provisional.fixpoint == true && findings.conflicts.count == 0)',
        // 有限停止予算（codex 裁定・対策バッチ B1 の拡張）: fixpoint が成立
        // しない churn でも、累積ラウンド数の上限超過で同じ終端へ収束させる。
        'when(findings.rounds.budgetExhausted == true && findings.conflicts.count == 0)',
        // v2 梯子設計: provisional（意味を確定できなかった観測）は fixer が直接
        // 直せないため、fix ループへ入れず再計画へ返す。
        'when(findings.provisional.count > 0 && findings.conflicts.count == 0)',
        `any("needs_fix", "${antipatternNg}") && when(findings.conflicts.count == 0)`,
        'when(findings.conflicts.count == 0 && findings.open.count > 0)',
        // Phase B (codex B1): actionable かどうかの判断は裁定ステップ自身が
        // 構造化出力で担うため、旧 ai() conflict ルールは削除済み。未裁定の
        // conflict は ABORT の前に合成ステップで1回だけ裁定を試みる。
        'when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)',
        'when(findings.conflicts.count > 0)',
      ]);
      expect(reviewers?.rules?.[0]).toMatchObject({
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateGuardCondition: 'findings.open.count == 0 && findings.conflicts.count == 0',
      });
      // review-integrity ルール（index 1）を差し込んだぶん any 集約は index 5 へ。
      expect(reviewers?.rules?.[5]).toMatchObject({
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateGuardCondition: 'findings.conflicts.count == 0',
      });

      const finalGateStep = normalized.steps.find((step) => step.name === 'final-gate');
      expect(finalGateStep).toMatchObject({
        kind: 'workflow_call',
        call: 'merge-readiness-finding-contract-final-gate-for-local-llm',
      });
      const finalGate = normalizeBuiltinWorkflow(
        loadBuiltinWorkflow(locale, 'merge-readiness-finding-contract-final-gate-for-local-llm.yaml'),
        locale,
      );
      expect(finalGate.subworkflow).toMatchObject({
        callable: true,
        requiresFindingContract: true,
      });
      const mergeReadiness = finalGate.steps.find((step) => step.name === 'merge-readiness-review');
      const supervise = finalGate.steps.find((step) => step.name === 'supervise');
      expect(mergeReadiness?.rules?.find((rule) => rule.condition === 'approved')).toMatchObject({
        guardCondition: 'findings.open.count == 0 && findings.conflicts.count == 0',
        next: 'supervise',
      });
      expect(mergeReadiness?.rules?.find((rule) => rule.condition === 'needs_fix')).toMatchObject({
        guardCondition: 'findings.conflicts.count == 0',
        returnValue: 'needs_fix',
      });
      expect(supervise?.rules?.find((rule) => rule.condition === 'approved')).toMatchObject({
        guardCondition: 'findings.open.count == 0 && findings.conflicts.count == 0',
        next: 'COMPLETE',
      });
      expect(supervise?.rules?.find((rule) => rule.condition === 'need_replan')).toMatchObject({
        guardCondition: 'findings.conflicts.count == 0',
        returnValue: 'need_replan',
      });
    });

    it(`${locale} peer-review should use standard output contracts`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'peer-review.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const finalGateWorkflow = loadBuiltinWorkflow(locale, 'merge-readiness-final-gate.yaml');
      const mergeReadiness = finalGateWorkflow.steps?.find((step) => step.name === 'merge-readiness-review');
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

    it(`${locale} every for-local-llm workflow should share the FC gate rule contract`, () => {
      const family = [
        'takt-default-for-local-llm',
        'frontend-for-local-llm',
        'backend-for-local-llm',
        'backend-cqrs-for-local-llm',
        'dual-for-local-llm',
      ] as const;
      const aiApproved = locale === 'ja' ? 'AI特有の問題なし' : 'No AI-specific issues';
      const aiNeedsFix = locale === 'ja' ? 'AI特有の問題あり' : 'AI-specific issues found';
      const rule = (condition: string, next: string) => ({ condition, next });
      const reviewers = (allVotes: string[], anomaly: string, needsFixVotes: string[]) => [
        rule(`all(${allVotes.map((vote) => `"${vote}"`).join(', ')}) && when(findings.open.count == 0 && findings.conflicts.count == 0)`, 'final-gate'),
        rule(anomaly, 'final-gate'),
        rule('when(findings.provisional.fixpoint == true && findings.conflicts.count == 0)', 'NEEDS_ADJUDICATION'),
        rule('when(findings.rounds.budgetExhausted == true && findings.conflicts.count == 0)', 'NEEDS_ADJUDICATION'),
        rule('when(findings.provisional.count > 0 && findings.conflicts.count == 0)', 'plan'),
        rule(`any(${[...new Set(needsFixVotes)].map((vote) => `"${vote}"`).join(', ')}) && when(findings.conflicts.count == 0)`, 'fix'),
        rule('when(findings.conflicts.count == 0 && findings.open.count > 0)', 'fix'),
        rule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
        rule('when(findings.conflicts.count > 0)', 'ABORT'),
      ];
      const finalGateRules = (successTarget: 'supervise' | 'COMPLETE', includeNeedReplan: boolean) => [
        rule('when(findings.open.count == 0 && findings.conflicts.count == 0 && findings.reviewerAnomalies.count > 0 && findings.reviewerAnomalies.budgetExhausted == true)', 'NEEDS_ADJUDICATION'),
        rule('when(findings.open.count == 0 && findings.conflicts.count == 0 && findings.reviewerAnomalies.count > 0)', 'needs_review'),
        rule('approved && when(findings.open.count == 0 && findings.conflicts.count == 0)', successTarget),
        rule('when(findings.provisional.fixpoint == true && findings.conflicts.count == 0)', 'NEEDS_ADJUDICATION'),
        rule('when(findings.rounds.budgetExhausted == true && findings.conflicts.count == 0)', 'NEEDS_ADJUDICATION'),
        rule('when(findings.provisional.count > 0 && findings.conflicts.count == 0)', 'need_replan'),
        ...(includeNeedReplan ? [rule('need_replan && when(findings.conflicts.count == 0)', 'need_replan')] : []),
        rule('needs_fix && when(findings.conflicts.count == 0)', 'needs_fix'),
        rule('when(findings.conflicts.count == 0 && findings.open.count > 0)', 'needs_fix'),
        rule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'needs_conflict_adjudication'),
        rule('when(findings.conflicts.count > 0)', 'ABORT'),
      ];
      const anomaly = 'when(findings.open.count == 0 && findings.conflicts.count == 0 && findings.reviewerAnomalies.count > 0)';
      const defaultAnomaly = `any("approved", "needs_fix", "${aiApproved}", "${aiNeedsFix}") && ${anomaly}`;
      const expectedReviewerRules: Record<typeof family[number], ReturnType<typeof reviewers>> = {
        'takt-default-for-local-llm': reviewers(
          ['approved', aiApproved, 'approved', 'approved', 'approved', 'approved'],
          defaultAnomaly,
          ['needs_fix', aiNeedsFix, 'needs_fix', 'needs_fix', 'needs_fix', 'needs_fix'],
        ),
        'frontend-for-local-llm': reviewers(['approved', aiApproved, 'approved', 'approved'], anomaly, ['needs_fix', aiNeedsFix, 'needs_fix', 'needs_fix']),
        'backend-for-local-llm': reviewers(['approved', aiApproved, 'approved', 'approved'], anomaly, ['needs_fix', aiNeedsFix, 'needs_fix', 'needs_fix']),
        'backend-cqrs-for-local-llm': reviewers(['approved', aiApproved, 'approved', 'approved'], anomaly, ['needs_fix', aiNeedsFix, 'needs_fix', 'needs_fix']),
        'dual-for-local-llm': reviewers(['approved', 'approved', aiApproved, 'approved', 'approved'], anomaly, ['needs_fix', 'needs_fix', aiNeedsFix, 'needs_fix', 'needs_fix']),
      };
      const finalGateWorkflow = loadBuiltinWorkflow(
        locale,
        'merge-readiness-finding-contract-final-gate-for-local-llm.yaml',
      );
      const mergeReadiness = finalGateWorkflow.steps?.find((step) => step.name === 'merge-readiness-review');
      const supervise = finalGateWorkflow.steps?.find((step) => step.name === 'supervise');
      expect(ruleSignatures(mergeReadiness ?? {}), 'FC final gate:merge-readiness-review')
        .toEqual(finalGateRules('supervise', false));
      expect(ruleSignatures(supervise ?? {}), 'FC final gate:supervise')
        .toEqual(finalGateRules('COMPLETE', true));
      for (const name of family) {
        const workflow = loadBuiltinWorkflow(locale, `${name}.yaml`);
        const rawReviewers = workflow.steps?.find((step) => step.name === 'reviewers');
        const finalGate = workflow.steps?.find((step) => step.name === 'final-gate');
        expect(ruleSignatures(rawReviewers ?? {}), `${name}:reviewers`).toEqual(expectedReviewerRules[name]);
        expect(finalGate?.call, `${name}:final-gate call`).toBe(
          'merge-readiness-finding-contract-final-gate-for-local-llm',
        );
      }

      const expectedNeedsFixCondition = `any("needs_fix", "${aiNeedsFix}")`;
      for (const name of ['default-peer-review', 'takt-default-high'] as const) {
        const workflow = loadBuiltinWorkflow(locale, `${name}.yaml`);
        const rawReviewers = workflow.steps?.find((step) => step.name === 'reviewers');
        const fixRule = rawReviewers?.rules?.find((candidate) => candidate.next === 'fix');
        expect(fixRule?.condition, `${name}:reviewers should use unique any() conditions`).toBe(
          name === 'takt-default-high'
            ? `${expectedNeedsFixCondition} && when(findings.conflicts.count == 0)`
            : expectedNeedsFixCondition,
        );
      }
    });

    it(`${locale} takt-default-for-local-llm should use Finding Contract-specific output contracts`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'takt-default-for-local-llm.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const finalGateWorkflow = loadBuiltinWorkflow(
        locale,
        'merge-readiness-finding-contract-final-gate-for-local-llm.yaml',
      );
      const mergeReadiness = finalGateWorkflow.steps?.find((step) => step.name === 'merge-readiness-review');
      const reviewerFormats = outputFormats(reviewers);
      const formats = outputFormats([...reviewers, ...(mergeReadiness ? [mergeReadiness] : [])]);

      const expectedReviewerContracts = [
        'architecture-review',
        'ai-antipattern-review',
        'coding-review',
        'implementation-semantics-review',
        'contract-lifecycle-review',
        'robustness-review',
      ];
      expect(reviewerFormats).toEqual(
        expectedReviewerContracts.map((contract) => `${contract}-finding-contract`),
      );
      expect(formats).toEqual(
        [...expectedReviewerContracts, 'merge-readiness-review'].map((contract) => `${contract}-finding-contract`),
      );

      for (const contract of [...expectedReviewerContracts, 'merge-readiness-review']) {
        const findingContractContent = readFileSync(outputContractPath(locale, `${contract}-finding-contract`), 'utf-8');

        expect(findingContractContent).not.toContain('finding_id');
        expect(findingContractContent).not.toContain('persists');
        expect(findingContractContent).not.toContain('reopened');
      }
    });

    it(`${locale} local-llm reviewer contracts should preserve raw-relation, re-scan, and table boundaries`, () => {
      const policy = readFileSync(join(process.cwd(), 'builtins', locale, 'facets', 'policies', 'review.md'), 'utf-8');
      const findingInstruction = readFileSync(
        join(process.cwd(), 'src', 'shared', 'prompts', locale, 'parts', 'finding_contract_instruction.md'),
        'utf-8',
      );
      for (const relation of ['new', 'persists', 'resolution_confirmation', 'reopened']) {
        expect(policy).toContain(`\`${relation}\``);
        expect(findingInstruction).toContain(`\`${relation}\``);
      }
      expect(policy).toContain(locale === 'ja'
        ? 'lifecycle 判定と finding ID の対応づけは findings-manager とエンジンの責務である'
        : 'belong to the findings-manager and engine');
      expect(findingInstruction).toContain(locale === 'ja'
        ? '最終 lifecycle 判定と finding ID の対応づけは findings-manager とエンジンが行う'
        : 'The findings-manager and engine make final lifecycle decisions and finding-ID matches');

      expect(policy).toContain(locale === 'ja'
        ? 'この節と後続の再オープン条件・ID意味固定は Finding Contract workflow には適用しない'
        : 'This section and the following reopen and immutable-meaning rules do not apply to Finding');

      const workflow = loadBuiltinWorkflow(locale, 'takt-default-for-local-llm.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const reportFormatByInstruction = new Map(
        reviewers.map((reviewer) => [reviewer.instruction, reviewerOutputFormat(reviewer)]),
      );
      const reScanReviewers = [
        ['review-arch-for-local-llm', 'architecture-review-finding-contract'],
        ['ai-antipattern-review-for-local-llm', 'ai-antipattern-review-finding-contract'],
        ['review-coding-for-local-llm', 'coding-review-finding-contract'],
        ['review-implementation-semantics-for-local-llm', 'implementation-semantics-review-finding-contract'],
      ] as const;
      const reScanHeading = locale === 'ja' ? '## 再走査証跡' : '## Re-scan Evidence';
      const reScanColumns = locale === 'ja'
        ? ['確認章数', '未確認章（ある場合のみ）', '確認経路', '現在の証跡', '結果']
        : ['Checked Chapters', 'Unverified Chapters (only when any)', 'Checked Route', 'Current Evidence', 'Result'];
      const reScanCount = locale === 'ja' ? '確認章数 N/N' : 'Checked Chapters N/N';

      for (const [instruction, contract] of reScanReviewers) {
        expect(reportFormatByInstruction.get(instruction)).toBe(contract);
        const instructionContent = readFileSync(instructionPath(locale, instruction), 'utf-8');
        const contractSection = markdownSection(
          readFileSync(outputContractPath(locale, contract), 'utf-8'),
          reScanHeading,
        );

        expect(instructionContent).not.toContain(reScanHeading.slice(3));
        expect(instructionContent).not.toContain(reScanCount);
        expect(contractSection).toContain(reScanCount);
        for (const column of reScanColumns) {
          expect(contractSection).toContain(column);
        }
        expect(markdownTableCount(contractSection)).toBe(1);
      }

      const twoTableReviewers = [
        ['contract-lifecycle-review-for-local-llm', 'contract-lifecycle-review-finding-contract'],
        ['robustness-review-for-local-llm', 'robustness-review-finding-contract'],
      ] as const;
      for (const [instruction, contract] of twoTableReviewers) {
        const instructionContent = readFileSync(instructionPath(locale, instruction), 'utf-8');
        const evidenceSection = markdownSection(
          readFileSync(outputContractPath(locale, contract), 'utf-8'),
          locale === 'ja' ? '## 検証証跡' : '## Verification Evidence',
        );

        expect(instructionContent).not.toContain(locale === 'ja' ? '合計2表だけ' : 'exactly two specialist tables in total');
        expect(instructionContent).not.toContain(locale === 'ja' ? '1行にして' : 'one row per');
        expect(evidenceSection).toContain(locale === 'ja' ? '合計2表だけ' : 'exactly two specialist tables in total');
        expect(markdownTableCount(evidenceSection)).toBe(2);
      }

      const supervisorContract = readFileSync(outputContractPath(locale, 'supervisor-validation-finding-contract'), 'utf-8');
      expect(supervisorContract).toContain(locale === 'ja'
        ? '## 結果: APPROVE / REJECT / NEED_REPLAN'
        : '## Result: APPROVE / REJECT / NEED_REPLAN');
      expect(supervisorContract).toContain(locale === 'ja'
        ? 'APPROVE は issue 0 件かつ必須証跡の確認完了、REJECT は現在の観測欠陥 issue が1件以上、NEED_REPLAN は issue 0 件のまま'
        : 'APPROVE means zero issues and required evidence is confirmed; REJECT means one or more currently observed defect issues; NEED_REPLAN means zero issues');

      const supervisorGateSummary = readFileSync(
        outputContractPath(locale, 'supervisor-gate-summary-finding-contract'),
        'utf-8',
      );
      expect(supervisorGateSummary).toContain(locale === 'ja'
        ? '## 結果: APPROVE / REJECT / NEED_REPLAN'
        : '## Result: APPROVE / REJECT / NEED_REPLAN');
      expect(supervisorGateSummary).toContain(locale === 'ja'
        ? '## 次アクションまたは未完了理由'
        : '## Next Action or Unfinished Reason');
      expect(supervisorGateSummary).not.toContain(locale === 'ja' ? '## 結果: 完了' : '## Result: Completed');

      for (const contract of ['frontend-review-finding-contract', 'cqrs-es-review-finding-contract']) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');
        expect(content).toContain(locale === 'ja'
          ? 'APPROVE かつ解消確認なし → サマリーのみ'
          : 'APPROVE with no resolution confirmations → Summary only');
        expect(content).toContain(locale === 'ja'
          ? 'APPROVE かつ解消確認あり → サマリーと解消確認のみ'
          : 'APPROVE with resolution confirmations → Summary and Resolution Confirmations only');
        expect(content).toContain(locale === 'ja'
          ? 'REJECT → 関連する指摘行と必要な解消確認のみ'
          : 'REJECT → Include only related finding rows and necessary resolution confirmations');
      }
    });

    it(`${locale} takt-default-for-local-llm should refresh exactly six aligned specialist reviewers`, () => {
      const workflow = loadBuiltinWorkflow(locale, 'takt-default-for-local-llm.yaml');
      const reviewers = workflow.steps?.find((step) => step.name === 'reviewers')?.parallel ?? [];
      const expected = [
        'arch-review',
        'ai-antipattern-review',
        'coding-review',
        'implementation-semantics-review',
        'contract-lifecycle-review',
        'robustness-review',
      ];

      expect(reviewers).toHaveLength(6);
      expect(reviewers.map((reviewer) => reviewer.name)).toEqual(expected);
      expect(reviewers.map((reviewer) => reviewer.session)).toEqual(Array(6).fill('refresh'));
      expect(reviewers.map((reviewer) => ({
        name: reviewer.name,
        instruction: reviewer.instruction,
        reportFormat: reviewerOutputFormat(reviewer),
      }))).toEqual([
        {
          name: 'arch-review',
          instruction: 'review-arch-for-local-llm',
          reportFormat: 'architecture-review-finding-contract',
        },
        {
          name: 'ai-antipattern-review',
          instruction: 'ai-antipattern-review-for-local-llm',
          reportFormat: 'ai-antipattern-review-finding-contract',
        },
        {
          name: 'coding-review',
          instruction: 'review-coding-for-local-llm',
          reportFormat: 'coding-review-finding-contract',
        },
        {
          name: 'implementation-semantics-review',
          instruction: 'review-implementation-semantics-for-local-llm',
          reportFormat: 'implementation-semantics-review-finding-contract',
        },
        {
          name: 'contract-lifecycle-review',
          instruction: 'contract-lifecycle-review-for-local-llm',
          reportFormat: 'contract-lifecycle-review-finding-contract',
        },
        {
          name: 'robustness-review',
          instruction: 'robustness-review-for-local-llm',
          reportFormat: 'robustness-review-finding-contract',
        },
      ]);
      expect(workflow.steps?.find((step) => step.name === 'merge-readiness-review')?.session).toBeUndefined();
      expect(workflow.steps?.find((step) => step.name === 'supervise')?.session).toBeUndefined();

      const contractNames = [
        'architecture-review-finding-contract',
        'ai-antipattern-review-finding-contract',
        'coding-review-finding-contract',
        'implementation-semantics-review-finding-contract',
        'contract-lifecycle-review-finding-contract',
        'robustness-review-finding-contract',
        'merge-readiness-review-finding-contract',
        'supervisor-validation-finding-contract',
        'supervisor-gate-summary-finding-contract',
      ];
      for (const contract of contractNames) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');
        const observedHeading = locale === 'ja' ? '## 観測した指摘' : '## Observed Findings';
        const resolutionHeading = locale === 'ja' ? '## 解消確認' : '## Resolution Confirmations';
        const oldObservedHeading = locale === 'ja' ? '## 観測 issue' : '## Observed Issues';

        expect(content).toContain(locale === 'ja' ? '出力整合性' : 'Output Consistency');
        expect(content).toContain(observedHeading);
        expect(content).toContain(resolutionHeading);
        expect(content).not.toContain(oldObservedHeading);
        expect(content).toContain('structured issue');
        expect(content).toContain('structured confirmation');
        expect(content).toContain('APPROVE');
        expect(content).toContain('REJECT');
      }

      const columnContracts = [
        ['contract-lifecycle-review-finding-contract', locale === 'ja'
          ? ['要件単位', '公開入口・実行モード', 'producer', 'validator', 'consumer', '対応テスト', '資源', 'owner・移譲', 'last consumer', 'release・persist', '成功・失敗・中断・再試行']
          : ['Requirement Unit', 'Public Entry / Execution Mode', 'Producer', 'Validator', 'Consumer', 'Corresponding Test', 'Resource', 'Owner / Transfer', 'Last Consumer', 'Release / Persist', 'Success / Failure / Interruption / Retry']],
        ['robustness-review-finding-contract', locale === 'ja'
          ? ['外部入力', 'hard cap', '強制位置', 'cap 前コスト', 'metadata 異常', '対応テスト', '失敗操作', '失敗型', '継続可否', 'caller・user 可視性', '部分成功結果']
          : ['External Input', 'Hard Cap', 'Enforcement Point', 'Cost Before Cap', 'Metadata Anomaly', 'Corresponding Test', 'Failed Operation', 'Failure Type', 'May Continue', 'Caller / User Visibility', 'Partial-Success Result']],
        ['coding-review-finding-contract', locale === 'ja'
          ? ['公開入口・実行モード', '成功・失敗', '対応テスト', '資源 API', '成功・失敗・中断', 'cleanup・残留物']
          : ['Public Entry / Execution Mode', 'Success / Failure', 'Corresponding Test', 'Resource API', 'Success / Failure / Interruption', 'Cleanup / Residual Artifacts']],
        ['implementation-semantics-review-finding-contract', locale === 'ja'
          ? ['状態または生成識別子', '既存名前空間', '下流構文', '壊れる具体的条件', '結果']
          : ['State or Generated Identifier', 'Existing Namespace', 'Downstream Syntax', 'Concrete Failure Condition', 'Result']],
      ] as const;
      for (const [contract, columns] of columnContracts) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');
        for (const column of columns) {
          expect(content).toContain(column);
        }
      }

      const supervisorContract = readFileSync(outputContractPath(locale, 'supervisor-validation-finding-contract'), 'utf-8');
      expect(supervisorContract).toContain('NEED_REPLAN');
      expect(supervisorContract).toContain(locale === 'ja' ? '## 監査' : '## Audit');
      expect(supervisorContract).toContain(locale === 'ja' ? '未確認範囲' : 'Unverified Scope');
      expect(supervisorContract).toContain(locale === 'ja' ? '次に必要な検証' : 'Next Required Verification');
      expect(readFileSync(outputContractPath(locale, 'architecture-review-finding-contract'), 'utf-8')).not.toContain('IMPROVE');

      const findingInstruction = readFileSync(
        join(process.cwd(), 'src', 'shared', 'prompts', locale, 'parts', 'finding_contract_instruction.md'),
        'utf-8',
      );
      expect(findingInstruction).toContain('rawFindings: []');
      expect(findingInstruction).toContain('structured issue');
      expect(findingInstruction).toContain('structured confirmation');
      expect(findingInstruction).toContain(locale === 'ja' ? '## 観測した指摘' : '## Observed Findings');
      expect(findingInstruction).toContain(locale === 'ja' ? '## 解消確認' : '## Resolution Confirmations');
      expect(findingInstruction).toContain('locationless');

      const superviseInstruction = readFileSync(instructionPath(locale, 'supervise-finding-contract'), 'utf-8');
      expect(superviseInstruction).toContain('NEED_REPLAN');
      expect(superviseInstruction).toContain(locale === 'ja' ? '現在の review snapshot 上のコードを正本' : 'current review snapshot as authoritative');
    });

    it(`${locale} Finding Contract assignments should be isolated and aligned across every builtin workflow`, () => {
      const family = [
        'backend-cqrs-for-local-llm',
        'backend-for-local-llm',
        'dual-for-local-llm',
        'frontend-for-local-llm',
        'takt-default-for-local-llm',
      ];
      const reviewerNamesByWorkflow: Record<string, string[]> = {
        'takt-default-for-local-llm': [
          'arch-review', 'ai-antipattern-review', 'coding-review', 'implementation-semantics-review',
          'contract-lifecycle-review', 'robustness-review',
        ],
        'frontend-for-local-llm': [
          'frontend-review', 'ai-antipattern-review', 'coding-review', 'implementation-semantics-review',
        ],
        'backend-for-local-llm': [
          'arch-review', 'ai-antipattern-review', 'coding-review', 'implementation-semantics-review',
        ],
        'backend-cqrs-for-local-llm': [
          'cqrs-es-review', 'ai-antipattern-review', 'coding-review', 'implementation-semantics-review',
        ],
        'dual-for-local-llm': [
          'arch-review', 'frontend-review', 'ai-antipattern-review', 'coding-review', 'implementation-semantics-review',
        ],
      };
      const reviewerExpectations: Record<string, ReviewStepExpectation> = {
        'arch-review': expectedReviewStep({
          name: 'arch-review', persona: 'architecture-reviewer-for-local-llm', policy: ['review'], knowledge: ['architecture'],
          instruction: 'review-arch-for-local-llm', session: undefined, session_key: undefined, provider_options: undefined,
          report: [{ name: 'architect-review.md', format: 'architecture-review-finding-contract' }],
        }),
        'frontend-review': expectedReviewStep({
          name: 'frontend-review', persona: 'frontend-reviewer', policy: ['review'], knowledge: ['frontend', 'react'],
          instruction: 'review-frontend', session: undefined, session_key: undefined, provider_options: undefined,
          report: [{ name: 'frontend-review.md', format: 'frontend-review-finding-contract' }],
        }),
        'cqrs-es-review': expectedReviewStep({
          name: 'cqrs-es-review', persona: 'cqrs-es-reviewer', policy: ['review'], knowledge: ['cqrs-es'],
          instruction: 'review-cqrs-es', session: undefined, session_key: undefined, provider_options: undefined,
          report: [{ name: 'cqrs-es-review.md', format: 'cqrs-es-review-finding-contract' }],
        }),
        'ai-antipattern-review': expectedReviewStep({
          name: 'ai-antipattern-review', persona: 'ai-antipattern-reviewer', policy: ['review', 'ai-antipattern'],
          knowledge: undefined, instruction: 'ai-antipattern-review-for-local-llm', session: undefined,
          session_key: 'ai-antipattern-review-finding-contract', provider_options: undefined,
          report: [{ name: 'ai-antipattern-review.md', format: 'ai-antipattern-review-finding-contract' }],
        }),
        'coding-review': expectedReviewStep({
          name: 'coding-review', persona: 'coding-reviewer', policy: ['review', 'coding'], knowledge: undefined,
          instruction: 'review-coding-for-local-llm', session: undefined, session_key: undefined, provider_options: undefined,
          report: [{ name: 'coding-review.md', format: 'coding-review-finding-contract' }],
        }),
        'implementation-semantics-review': expectedReviewStep({
          name: 'implementation-semantics-review', persona: 'implementation-semantics-reviewer', policy: ['review'],
          knowledge: ['implementation-semantics'], instruction: 'review-implementation-semantics-for-local-llm', session: undefined,
          session_key: undefined, provider_options: undefined,
          report: [{ name: 'implementation-semantics-review.md', format: 'implementation-semantics-review-finding-contract' }],
        }),
        'contract-lifecycle-review': expectedReviewStep({
          name: 'contract-lifecycle-review', persona: 'contract-lifecycle-reviewer', policy: ['review'],
          knowledge: ['contract-lifecycle'], instruction: 'contract-lifecycle-review-for-local-llm', session: undefined,
          session_key: undefined, provider_options: undefined,
          report: [{ name: 'contract-lifecycle-review.md', format: 'contract-lifecycle-review-finding-contract' }],
        }),
        'robustness-review': expectedReviewStep({
          name: 'robustness-review', persona: 'robustness-reviewer', policy: ['review'], knowledge: ['robustness'],
          instruction: 'robustness-review-for-local-llm', session: undefined, session_key: undefined, provider_options: undefined,
          report: [{ name: 'robustness-review.md', format: 'robustness-review-finding-contract' }],
        }),
      };
      const superviseKnowledgeByWorkflow: Record<string, string[]> = {
        'takt-default-for-local-llm': ['architecture', 'takt'],
        'frontend-for-local-llm': ['frontend', 'react', 'architecture'],
        'backend-for-local-llm': ['backend', 'architecture'],
        'backend-cqrs-for-local-llm': ['backend', 'cqrs-es', 'architecture'],
        'dual-for-local-llm': ['frontend', 'react', 'backend', 'architecture'],
      };
      const genericInstructions = [
        'review-arch',
        'ai-antipattern-review',
        'review-implementation-semantics',
        'review-coding',
        'contract-lifecycle-review',
        'robustness-review',
        'supervise',
      ];

      for (const instruction of genericInstructions) {
        const content = readFileSync(instructionPath(locale, instruction), 'utf-8');
        expect(content).not.toContain('-for-local-llm');
      }
      expect(readFileSync(instructionPath(locale, 'review-coding-for-local-llm'), 'utf-8')).not.toMatch(/表を使う|table|2表|two.*tables/i);

      const finalGateWorkflow = loadBuiltinWorkflow(
        locale,
        'merge-readiness-finding-contract-final-gate-for-local-llm.yaml',
      );
      const finalGateSteps = collectSteps(finalGateWorkflow.steps ?? []);
      const mergeReadinessEntry = finalGateSteps.find(({ path }) => path === 'merge-readiness-review');
      const superviseEntry = finalGateSteps.find(({ path }) => path === 'supervise');
      expect(mergeReadinessEntry, 'FC final gate should include merge-readiness review').toBeDefined();
      expect(superviseEntry, 'FC final gate should include supervisor').toBeDefined();
      if (mergeReadinessEntry === undefined || superviseEntry === undefined) {
        throw new Error('FC final gate is missing a required review step');
      }

      for (const name of readdirSync(workflowDir(locale)).filter((file) => file.endsWith('.yaml'))) {
        const workflow = loadBuiltinWorkflow(locale, name);
        const steps = collectSteps(workflow.steps ?? []);
        const formats = steps.flatMap(({ step }) => outputFormats([step]));
        if (
          workflow.finding_contract === undefined
          && workflow.subworkflow?.requires_finding_contract !== true
        ) {
          expect(formats, name).not.toContainEqual(expect.stringMatching(/-finding-contract$/));
        }
      }

      for (const name of family) {
        const workflow = loadBuiltinWorkflow(locale, `${name}.yaml`);
        const steps = collectSteps(workflow.steps ?? []);
        const firstAiReviewEntry = steps.find(({ step }) => step.name === 'ai-antipattern-review-1st');
        const parallelAiReviewEntry = steps.find(({ path }) => path === 'reviewers/ai-antipattern-review');
        const reviewersEntry = steps.find(({ step }) => step.name === 'reviewers');
        const finalGateEntry = steps.find(({ path }) => path === 'final-gate');
        const aiAntipatternNoFixEntry = steps.find(({ path }) => path === 'ai-antipattern-no-fix');

        expect(firstAiReviewEntry, `${name} should include the first AI review step`).toBeDefined();
        expect(parallelAiReviewEntry, `${name} should include the parallel AI review step`).toBeDefined();
        expect(reviewersEntry, `${name} should include the reviewers step`).toBeDefined();
        expect(finalGateEntry, `${name} should include the FC final gate call`).toBeDefined();
        expect(aiAntipatternNoFixEntry, `${name} should include the AI antipattern adjudication step`).toBeDefined();
        if (
          firstAiReviewEntry === undefined
          || parallelAiReviewEntry === undefined
          || reviewersEntry === undefined
          || finalGateEntry === undefined
          || aiAntipatternNoFixEntry === undefined
        ) {
          throw new Error(`${name} is missing a required Finding Contract review step`);
        }
        expect(finalGateEntry.step.call).toBe(
          'merge-readiness-finding-contract-final-gate-for-local-llm',
        );
        expect(finalGateEntry.step.args).toEqual({
          supervise_knowledge: superviseKnowledgeByWorkflow[name],
        });

        expect(reviewStepConfiguration(firstAiReviewEntry.step)).toEqual(expectedReviewStep({
          name: 'ai-antipattern-review-1st', persona: 'ai-antipattern-reviewer', policy: ['review', 'ai-antipattern'],
          knowledge: undefined, instruction: 'ai-antipattern-review-for-local-llm', session: undefined,
          session_key: 'ai-antipattern-review-1st', provider_options: { extends: 'review-readonly' },
          report: [{ name: 'ai-antipattern-review-1st.md', format: 'ai-antipattern-review-finding-contract' }],
        }));
        expectReviewRules(firstAiReviewEntry.step, locale, ['ai-no-issues', 'ai-issues'], ['reviewers', 'ai-antipattern-fix']);

        expect(reviewStepConfiguration(aiAntipatternNoFixEntry.step)).toEqual(expectedReviewStep({
          name: 'ai-antipattern-no-fix', persona: 'architecture-reviewer-for-local-llm', policy: 'review', knowledge: undefined,
          instruction: 'arbitrate-review-1st', session: undefined, session_key: undefined,
          provider_options: { extends: 'review-files' }, report: undefined,
        }));
        expectReviewRules(aiAntipatternNoFixEntry.step, locale, ['fix-required', 'no-fix-needed'], ['ai-antipattern-fix', 'reviewers']);

        const reviewerChildren = reviewersEntry.step.parallel ?? [];
        expect(reviewerChildren.map((reviewer) => reviewer.name), `${name}:reviewers child composition`)
          .toEqual(reviewerNamesByWorkflow[name]);
        for (const reviewer of reviewerChildren) {
          const expectation = reviewerExpectations[reviewer.name ?? ''];
          expect(expectation, `${name}:reviewers/${reviewer.name} should be known`).toBeDefined();
          const session = name === 'takt-default-for-local-llm' ? 'refresh' : undefined;
          expect(reviewStepConfiguration(reviewer)).toEqual({ ...expectation, session });
          expectReviewRules(
            reviewer,
            locale,
            reviewer.name === 'ai-antipattern-review' ? ['ai-no-issues', 'ai-issues'] : ['approved', 'needs-fix'],
            [undefined, undefined],
          );
        }
        expectReviewRules(
          reviewersEntry.step,
          locale,
          [
            'all-approved', name === 'takt-default-for-local-llm' ? 'anomaly-vote' : 'anomaly',
            'fixpoint', 'budget-exhausted', 'provisional', 'any-needs-fix', 'open-findings',
            'unadjudicated-conflicts', 'conflicts',
          ],
          ['final-gate', 'final-gate', 'NEEDS_ADJUDICATION', 'NEEDS_ADJUDICATION', 'plan', 'fix', 'fix', 'finding-conflict-adjudication', 'ABORT'],
        );
        expect(reviewersEntry.step.rules?.[0].condition?.match(/"[^"]+"/g), `${name}:reviewers all() vote count`)
          .toHaveLength(reviewerChildren.length);
        const anyVotes = reviewersEntry.step.rules?.[5].condition?.match(/"[^"]+"/g) ?? [];
        expect(new Set(anyVotes).size, `${name}:reviewers any() values must be unique`).toBe(anyVotes.length);
        expect(anyVotes, `${name}:reviewers any() outcome set`).toHaveLength(2);

        expect(reviewStepConfiguration(mergeReadinessEntry.step)).toEqual(expectedReviewStep({
          name: 'merge-readiness-review', persona: 'merge-readiness-reviewer', policy: 'review', knowledge: undefined,
          instruction: 'review-merge-readiness', session: undefined, session_key: undefined,
          provider_options: { extends: 'review-readonly' },
          report: [{ name: 'merge-readiness-review.md', format: 'merge-readiness-review-finding-contract' }],
        }));
        expectReviewRules(
          mergeReadinessEntry.step,
          locale,
          ['anomaly', 'anomaly', 'approved', 'fixpoint', 'budget-exhausted', 'provisional', 'needs-fix', 'open-findings', 'unadjudicated-conflicts', 'conflicts'],
          ['NEEDS_ADJUDICATION', 'needs_review', 'supervise', 'NEEDS_ADJUDICATION', 'NEEDS_ADJUDICATION', 'need_replan', 'needs_fix', 'needs_fix', 'needs_conflict_adjudication', 'ABORT'],
        );

        expect(reviewStepConfiguration(superviseEntry.step)).toEqual(expectedReviewStep({
          name: 'supervise', persona: 'supervisor', policy: 'review', knowledge: { $param: 'supervise_knowledge' },
          instruction: 'supervise-finding-contract', session: undefined, session_key: undefined,
          provider_options: { extends: 'review-readonly' },
          report: [
            { name: 'supervisor-validation.md', format: 'supervisor-validation-finding-contract' },
            { name: 'supervisor-gate-summary.md', format: 'supervisor-gate-summary-finding-contract', use_judge: false },
          ],
        }));
        expectReviewRules(
          superviseEntry.step,
          locale,
          ['anomaly', 'anomaly', 'approved', 'fixpoint', 'budget-exhausted', 'provisional', 'need-replan', 'needs-fix', 'open-findings', 'unadjudicated-conflicts', 'conflicts'],
          ['NEEDS_ADJUDICATION', 'needs_review', 'COMPLETE', 'NEEDS_ADJUDICATION', 'NEEDS_ADJUDICATION', 'need_replan', 'need_replan', 'needs_fix', 'needs_fix', 'needs_conflict_adjudication', 'ABORT'],
        );
      }

      const findingContracts = new Set<string>();
      for (const name of family) {
        const workflow = loadBuiltinWorkflow(locale, `${name}.yaml`);
        for (const { step } of collectSteps(workflow.steps ?? [])) {
          for (const format of outputFormats([step])) {
            if (format.endsWith('-finding-contract')) {
              findingContracts.add(format);
            }
          }
        }
      }

      expect(findingContracts.size).toBeGreaterThan(0);
      for (const contract of findingContracts) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');

        expect(markdownContractLineCount(content), `${contract} body should stay within the style-guide limit`)
          .toBeLessThanOrEqual(30);

        expect(content, `${contract} should define observed findings`).toContain(
          locale === 'ja' ? '## 観測した指摘' : '## Observed Findings',
        );
        expect(content, `${contract} should define resolution confirmations`).toContain(
          locale === 'ja' ? '## 解消確認' : '## Resolution Confirmations',
        );
        const outputConsistency = markdownSection(content, locale === 'ja' ? '## 出力整合性' : '## Output Consistency');

        expect(outputConsistency, `${contract} should keep Markdown and structured findings one-to-one`)
          .toContain(locale === 'ja'
            ? 'Markdown の観測した指摘と structured issue、解消確認と structured confirmation はそれぞれ同じ集合にする。'
            : 'Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.');
        expect(outputConsistency, `${contract} should require zero issues for APPROVE`).toMatch(
          locale === 'ja' ? /APPROVE は issue 0 件/ : /APPROVE means zero issues/,
        );
        expect(outputConsistency, `${contract} should require one or more issues for REJECT`).toMatch(
          locale === 'ja' ? /REJECT は.*issue.*1\s*件以上/ : /REJECT means one or more.*issues/,
        );
      }

      for (const [instruction, contract] of [
        ['review-arch-for-local-llm', 'architecture-review-finding-contract'],
        ['ai-antipattern-review-for-local-llm', 'ai-antipattern-review-finding-contract'],
        ['review-implementation-semantics-for-local-llm', 'implementation-semantics-review-finding-contract'],
      ] as const) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');
        expect(content).toContain(locale === 'ja' ? '確認章数 N/N' : 'Checked Chapters N/N');
        expect(markdownTableCount(markdownSection(content, locale === 'ja' ? '## 再走査証跡' : '## Re-scan Evidence'))).toBe(1);
        expect(readFileSync(instructionPath(locale, instruction), 'utf-8')).not.toContain(locale === 'ja' ? '確認章数 N/N' : 'Checked Chapters N/N');
      }
      for (const contract of ['contract-lifecycle-review-finding-contract', 'robustness-review-finding-contract']) {
        const content = readFileSync(outputContractPath(locale, contract), 'utf-8');
        expect(markdownTableCount(markdownSection(content, locale === 'ja' ? '## 検証証跡' : '## Verification Evidence'))).toBe(2);
      }
      expect(readFileSync(instructionPath(locale, 'supervise'), 'utf-8')).not.toContain('NEED_REPLAN');
      expect(readFileSync(outputContractPath(locale, 'supervisor-validation'), 'utf-8')).not.toContain('NEED_REPLAN');
    });
  }
});
