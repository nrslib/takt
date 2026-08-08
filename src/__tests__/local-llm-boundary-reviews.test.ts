import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { validateWorkflowCallContracts } from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';

type Locale = 'ja' | 'en';

interface RawRule {
  condition: string;
  next?: string;
  return?: string;
}

interface RawStep {
  name: string;
  kind?: string;
  uses?: string;
  call?: string;
  finding_contract_authority?: string;
  args?: Record<string, unknown>;
  tags?: string[];
  parallel?: Array<{ name: string }>;
  rules?: RawRule[] | {
    self?: RawRule[];
    parallel?: Record<string, RawRule[]>;
  };
  team_leader?: { mode?: string };
}

interface RawWorkflow {
  finding_contract?: unknown;
  subworkflow?: {
    callable?: boolean;
    requires_finding_contract?: boolean;
  };
  loop_monitors?: Array<{
    cycle: string[];
    threshold: number;
    judge: {
      instruction: string;
      rules: Array<{ next: string }>;
    };
  }>;
  steps: RawStep[];
}

const REGULAR_CONTRACT_NAMES = [
  'architecture',
  'ai-antipattern',
  'coding',
  'implementation-semantics',
  'contract-lifecycle',
  'robustness',
] as const;

const COMPOSED_WORKFLOWS = [
  'finding-contract-local-review',
  'finding-contract-boundary-review',
  'finding-contract-remediation',
  'peer-review-finding-contract-localllm',
] as const;

let testRoot: string;
let previousTaktConfigDir: string | undefined;

function workflowPath(locale: Locale, name: string): string {
  return join(process.cwd(), 'builtins', locale, 'workflows', `${name}.yaml`);
}

function readRawWorkflow(
  locale: Locale,
  name: string,
  resolveFragments = false,
): RawWorkflow {
  const path = workflowPath(locale, name);
  const workflow = parseYaml(readFileSync(path, 'utf-8')) as RawWorkflow;
  if (!resolveFragments) return workflow;

  return resolveWorkflowStepFragments(workflow, {
    candidateDirs: buildStepFragmentLookupDirs({ lang: locale }),
    context: { lang: locale, projectDir: process.cwd() },
    workflowPath: path,
  }).raw as RawWorkflow;
}

function loadBuiltinWorkflow(locale: Locale, name: string): WorkflowConfig {
  const projectDir = join(testRoot, `project-${locale}`);
  const projectConfigDir = join(projectDir, '.takt');
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(join(projectConfigDir, 'config.yaml'), `language: ${locale}\n`);
  invalidateAllResolvedConfigCache();
  return loadWorkflowFromFile(workflowPath(locale, name), projectDir);
}

function getRawStep(workflow: RawWorkflow, name: string): RawStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing raw step: ${name}`);
  return step;
}

function getLoadedStep(workflow: WorkflowConfig, name: string): WorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing loaded step: ${name}`);
  return step;
}

function getParallelSubsteps(workflow: WorkflowConfig, name: string): WorkflowStep[] {
  const parallel = getLoadedStep(workflow, name).parallel;
  if (!parallel) throw new Error(`Missing parallel substeps: ${name}`);
  return parallel;
}

function selfRules(step: RawStep): RawRule[] {
  return Array.isArray(step.rules) ? step.rules : step.rules?.self ?? [];
}

function transitionFor(step: RawStep, conditionFragment: string): RawRule | undefined {
  return selfRules(step).find((rule) => rule.condition.includes(conditionFragment));
}

beforeAll(() => {
  previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  testRoot = mkdtempSync(join(tmpdir(), 'takt-local-llm-composition-'));
  const globalConfigDir = join(testRoot, 'global');
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n');
  process.env.TAKT_CONFIG_DIR = globalConfigDir;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

afterAll(() => {
  if (previousTaktConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('takt-default-localllm composition', () => {
  it.each(['ja', 'en'] as const)('%s root は development-core へ FC peer review を注入する', (locale) => {
    const source = readFileSync(workflowPath(locale, 'takt-default-localllm'), 'utf-8');
    const workflow = readRawWorkflow(locale, 'takt-default-localllm');
    const develop = getRawStep(workflow, 'develop');

    expect(source.split('\n').length).toBeLessThan(60);
    expect(workflow.finding_contract).toBeDefined();
    expect(develop).toMatchObject({
      kind: 'workflow_call',
      call: 'development-core',
      args: {
        peer_review_workflow: 'peer-review-finding-contract-localllm',
      },
    });
    expect(source).not.toMatch(/^\s+(?:provider|model):/m);
  });

  it.each(['ja', 'en'] as const)('%s の全 workflow_call 契約は root ledger 継承込みで解決できる', (locale) => {
    const projectDir = join(testRoot, `project-${locale}`);
    const root = loadBuiltinWorkflow(locale, 'takt-default-localllm');

    expect(root.findingContract).toBeDefined();
    expect(() => validateWorkflowCallContracts(root, projectDir)).not.toThrow();

    for (const name of COMPOSED_WORKFLOWS) {
      const child = loadBuiltinWorkflow(locale, name);
      expect(child.findingContract).toBeUndefined();
      expect(child.subworkflow).toMatchObject({
        callable: true,
        requiresFindingContract: true,
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s は local integrity 後だけ boundary review へ進む', (locale) => {
    const local = readRawWorkflow(locale, 'finding-contract-local-review', true);
    const reviewers = getRawStep(local, 'reviewers');
    const gate = getRawStep(local, 'integrity-gate');

    expect(reviewers.parallel?.map((step) => step.name)).toEqual([
      'arch-review',
      'ai-antipattern-review',
      'coding-review',
      'implementation-semantics-review',
      'contract-lifecycle-review',
      'robustness-review',
    ]);
    expect(transitionFor(reviewers, 'findings.open.count == 0')).toMatchObject({
      next: 'integrity-gate',
    });
    expect(gate).toMatchObject({
      kind: 'workflow_call',
      call: 'merge-readiness-finding-contract-final-gate',
      finding_contract_authority: 'terminal_adjudication',
    });
    expect(transitionFor(gate, 'COMPLETE')).toMatchObject({ next: 'COMPLETE' });
    expect(transitionFor(gate, 'needs_review')).toMatchObject({ next: 'reviewers' });
  });

  it.each(['ja', 'en'] as const)('%s は3境界レビュー後に terminal final gate を通す', (locale) => {
    const boundary = readRawWorkflow(locale, 'finding-contract-boundary-review', true);
    const reviewers = getRawStep(boundary, 'boundary-reviewers');
    const gate = getRawStep(boundary, 'final-gate');

    expect(reviewers.tags).toEqual(['review', 'boundary-review']);
    expect(reviewers.parallel?.map((step) => step.name)).toEqual([
      'contract-wiring-review',
      'resource-ownership-review',
      'failure-boundary-review',
    ]);
    expect(transitionFor(reviewers, 'findings.open.count == 0')).toMatchObject({
      next: 'final-gate',
    });
    expect(gate).toMatchObject({
      kind: 'workflow_call',
      call: 'merge-readiness-finding-contract-final-gate',
      finding_contract_authority: 'terminal_adjudication',
    });
    expect(transitionFor(gate, 'needs_review')).toMatchObject({ next: 'boundary-reviewers' });
  });

  it.each(['ja', 'en'] as const)('%s remediation は inherited ledger の FC fix mode を使う', (locale) => {
    const remediation = readRawWorkflow(locale, 'finding-contract-remediation');
    const fix = getRawStep(remediation, 'fix');

    expect(fix.team_leader?.mode).toBe('finding_contract_fix');
    expect(transitionFor(fix, 'structured.fix.decision == "complete"')).toMatchObject({
      next: 'COMPLETE',
    });
    expect(transitionFor(fix, 'structured.fix.decision == "replan"')).toMatchObject({
      return: 'need_replan',
    });
  });

  it.each(['ja', 'en'] as const)('%s の gate retry monitor は初回を許容して2回目で発火する', (locale) => {
    for (const [name, cycle] of [
      ['finding-contract-local-review', ['reviewers', 'integrity-gate']],
      ['finding-contract-boundary-review', ['boundary-reviewers', 'final-gate']],
    ] as const) {
      const workflow = loadBuiltinWorkflow(locale, name);
      const monitor = workflow.loopMonitors?.find((candidate) => (
        JSON.stringify(candidate.cycle) === JSON.stringify(cycle)
      ));
      expect(monitor).toBeDefined();
      expect(monitor?.threshold).toBe(2);

      const detector = new CycleDetector([monitor!]);
      expect(detector.recordAndCheck(cycle[0], cycle[1]).triggered).toBe(false);
      expect(detector.recordAndCheck(cycle[1], cycle[0]).triggered).toBe(false);
      expect(detector.recordAndCheck(cycle[0], cycle[1]).triggered).toBe(false);
      expect(detector.recordAndCheck(cycle[1], cycle[0])).toMatchObject({
        triggered: true,
        cycleCount: 2,
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s の provider routing は local と high-assurance 経路を分離する', (locale) => {
    const local = loadBuiltinWorkflow(locale, 'finding-contract-local-review');
    const boundary = loadBuiltinWorkflow(locale, 'finding-contract-boundary-review');
    const finalGate = loadBuiltinWorkflow(locale, 'merge-readiness-finding-contract-final-gate');
    const providerRouting = {
      tags: {
        review: { provider: 'opencode' as const, model: 'ollama-cloud/gemma4:31b' },
        'boundary-review': { provider: 'codex' as const, model: 'gpt-5.2-codex' },
        'final-gate': { provider: 'codex' as const, model: 'gpt-5.2-codex' },
      },
    };

    for (const step of getParallelSubsteps(local, 'reviewers')) {
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'opencode',
        model: 'ollama-cloud/gemma4:31b',
      });
    }
    for (const step of getParallelSubsteps(boundary, 'boundary-reviewers')) {
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.2-codex',
      });
    }
    for (const stepName of ['merge-readiness-review', 'supervise']) {
      const step = getLoadedStep(finalGate, stepName);
      expect(step.tags).toEqual(expect.arrayContaining(['review', 'final-gate']));
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.2-codex',
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s の Finding Contract は単一machine形式と非省略規則を保つ', (locale) => {
    const dir = join(process.cwd(), 'builtins', locale, 'facets', 'output-contracts');
    const names = readdirSync(dir).filter((name) => name.endsWith('-finding-contract.md'));

    for (const name of names) {
      const contract = readFileSync(join(dir, name), 'utf-8');
      expect(contract.match(/^## Finding Contract Claims$/gmu)).toHaveLength(1);
      // claim の機械形式は1つだけ: 注入された指示のラベル付きフィールド。
      // レビュアーは観察専任なので、分類欄はこの形に含めない。
      expect(contract).toContain(locale === 'ja'
        ? 'ラベル付きフィールド形式（Target files / Description / Evidence）'
        : 'labelled fields of the injected Finding Contract instructions (Target files / Description / Evidence)');
      expect(contract).not.toMatch(/^## (?:Observed Findings|観測した指摘)$/mu);
    }

    for (const name of REGULAR_CONTRACT_NAMES) {
      const contract = readFileSync(join(dir, `${name}-review-finding-contract.md`), 'utf-8');
      expect(contract.match(locale === 'ja'
        ? /^## 解消確認$/gmu
        : /^## Resolution Confirmations$/gmu)).toHaveLength(1);
      expect(contract).toMatch(locale === 'ja'
        ? /省略|すべて/u
        : /every|do not omit/iu);
    }
  });

  it.each(['ja', 'en'] as const)('%s の既存 high workflow も共有6 FC format を維持する', (locale) => {
    for (const workflowName of ['takt-default-high', 'takt-default-team-high']) {
      const workflow = loadBuiltinWorkflow(locale, workflowName);
      const formats = getParallelSubsteps(workflow, 'reviewers')
        .map((step) => step.outputContracts?.[0]?.formatRef);
      expect(formats).toEqual(
        REGULAR_CONTRACT_NAMES.map((name) => `${name}-review-finding-contract`),
      );
    }
  });
});
