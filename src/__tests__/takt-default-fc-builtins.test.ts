import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FindingsRuleContext,
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { loadAllWorkflowsWithSourcesFromDirs } from '../infra/config/loaders/workflowDiscovery.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';

type Language = 'en' | 'ja';

interface RawRule {
  condition: string;
  next?: string;
  return?: string;
}

interface RawStep {
  name?: string;
  uses?: string;
  call?: string;
  args?: Record<string, unknown>;
  with?: Record<string, unknown>;
  finding_contract_authority?: string;
  instruction?: unknown;
  output_contracts?: {
    report?: Array<{ name?: string; format?: string }>;
  };
  parallel?: RawStep[];
  rules?: RawRule[];
}

interface RawLoopMonitor {
  cycle: string[];
  ignore_steps?: string[];
  threshold: number;
  judge: {
    instruction: string;
    rules: RawRule[];
  };
}

interface RawWorkflow {
  finding_contract?: Record<string, unknown>;
  subworkflow?: {
    callable?: boolean;
    requires_finding_contract?: boolean;
    returns?: string[];
    params?: Record<string, { default?: unknown }>;
  };
  loop_monitors?: RawLoopMonitor[];
  steps: RawStep[];
}

interface FindingCounts {
  open: number;
  provisional: number;
  dismissEligible: number;
  provisionalFixpoint: boolean;
  roundBudgetExhausted: boolean;
  anomalies: number;
  anomalyBudgetExhausted: boolean;
  conflicts: number;
  unadjudicated: number;
}

interface ExpectedRuleMatch {
  index: number;
  nextStep?: string;
  returnValue?: string;
}

const LANGUAGES = ['en', 'ja'] as const;
const REVIEWERS = [
  ['arch-review', 'architecture-review-finding-contract'],
  ['security-review', 'security-review-finding-contract'],
  ['testing-review', 'testing-review-finding-contract'],
  ['coding-review', 'coding-review-finding-contract'],
  ['ai-antipattern-review-2nd', 'ai-antipattern-review-finding-contract'],
] as const;
const FORBIDDEN_FC_REFS = [
  'review-adjudication',
  'peer-review-adjudication',
  'adjudicate-review-findings',
  'review-resolution',
  'fix-plan-from-review-resolution',
  'apply-fix-plan',
] as const;

let testRoot: string;
let previousTaktConfigDir: string | undefined;

function builtinPath(language: Language, ...parts: string[]): string {
  return join(process.cwd(), 'builtins', language, ...parts);
}

function workflowPath(language: Language, name: string): string {
  return builtinPath(language, 'workflows', `${name}.yaml`);
}

function readWorkflow(language: Language, name: string): RawWorkflow {
  return parseYaml(readFileSync(workflowPath(language, name), 'utf-8')) as RawWorkflow;
}

function expandWorkflow(language: Language, name: string): RawWorkflow {
  const raw = readWorkflow(language, name);
  return resolveWorkflowStepFragments(raw, {
    candidateDirs: buildStepFragmentLookupDirs({ lang: language }),
    context: { lang: language, projectDir: join(testRoot, `project-${language}`) },
    workflowPath: workflowPath(language, name),
  }).raw as RawWorkflow;
}

function loadWorkflow(language: Language, name: string): WorkflowConfig {
  invalidateAllResolvedConfigCache();
  return loadWorkflowFromFile(
    workflowPath(language, name),
    join(testRoot, `project-${language}`),
  );
}

function rawStep(workflow: RawWorkflow, name: string): RawStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Missing raw step: ${name}`);
  return step;
}

function loadedStep(workflow: WorkflowConfig, name: string): WorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Missing loaded step: ${name}`);
  return step;
}

function resolveInstruction(language: Language, name: string): string {
  const projectDir = join(testRoot, `project-${language}`);
  const content = resolveRefToContent(name, undefined, projectDir, 'instructions', {
    projectDir,
    lang: language,
  });
  if (content === undefined) throw new Error(`Missing instruction: ${name}`);
  return content;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function findings(counts: FindingCounts): FindingsRuleContext {
  return {
    open: {
      count: counts.open,
      bySeverity: {} as FindingsRuleContext['open']['bySeverity'],
      items: [],
    },
    resolved: { count: 0 },
    waived: { count: 0 },
    invalidated: { count: 0 },
    superseded: { count: 0 },
    provisional: {
      count: counts.provisional,
      dismissEligible: { count: counts.dismissEligible },
      fixpoint: counts.provisionalFixpoint,
      items: [],
    },
    rounds: { budgetExhausted: counts.roundBudgetExhausted },
    reviewerAnomalies: {
      count: counts.anomalies,
      budgetExhausted: counts.anomalyBudgetExhausted,
    },
    conflicts: {
      count: counts.conflicts,
      items: [],
      unadjudicated: { count: counts.unadjudicated },
    },
  };
}

function workflowState(step: WorkflowStep, counts: FindingCounts): WorkflowState {
  return {
    workflowName: 'peer-review-suite-finding-contract-base',
    currentStep: step.name,
    iteration: 1,
    findings: findings(counts),
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function expectedRuleMatch(counts: FindingCounts): ExpectedRuleMatch {
  if (counts.conflicts > 0 && counts.unadjudicated > 0) {
    return { index: 0, nextStep: 'finding-conflict-adjudication' };
  }
  if (counts.conflicts > 0) return { index: 1, nextStep: 'ABORT' };
  if (counts.dismissEligible > 0) {
    return { index: 2, returnValue: 'needs_terminal_adjudication' };
  }
  if (counts.provisionalFixpoint) return { index: 3, returnValue: 'need_replan' };
  if (counts.roundBudgetExhausted && counts.provisional > 0) {
    return { index: 4, returnValue: 'need_replan' };
  }
  if (counts.provisional > 0) return { index: 5, returnValue: 'need_replan' };
  if (counts.open === 0 && counts.anomalies > 0 && counts.anomalyBudgetExhausted) {
    return { index: 6, returnValue: 'need_replan' };
  }
  if (counts.open === 0 && counts.anomalies > 0) {
    return { index: 7, returnValue: 'needs_review' };
  }
  if (counts.open === 0) return { index: 8, nextStep: 'COMPLETE' };
  return { index: 9, returnValue: 'needs_fix' };
}

function enumerateFindingCounts(): FindingCounts[] {
  const states: FindingCounts[] = [];
  for (let open = 0; open <= 2; open += 1) {
    for (let provisional = 0; provisional <= open; provisional += 1) {
      for (let dismissEligible = 0; dismissEligible <= provisional; dismissEligible += 1) {
        for (let conflicts = 0; conflicts <= 2; conflicts += 1) {
          for (let unadjudicated = 0; unadjudicated <= conflicts; unadjudicated += 1) {
            for (let anomalies = 0; anomalies <= 2; anomalies += 1) {
              for (const provisionalFixpoint of [false, true]) {
                for (const roundBudgetExhausted of [false, true]) {
                  for (const anomalyBudgetExhausted of [false, true]) {
                    states.push({
                      open,
                      provisional,
                      dismissEligible,
                      provisionalFixpoint,
                      roundBudgetExhausted,
                      anomalies,
                      anomalyBudgetExhausted,
                      conflicts,
                      unadjudicated,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return states;
}

beforeAll(() => {
  previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  testRoot = mkdtempSync(join(tmpdir(), 'takt-default-fc-builtins-'));
  const globalConfigDir = join(testRoot, 'global');
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n');
  process.env.TAKT_CONFIG_DIR = globalConfigDir;
  for (const language of LANGUAGES) {
    const projectConfigDir = join(testRoot, `project-${language}`, '.takt');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), `language: ${language}\n`);
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

afterAll(() => {
  if (previousTaktConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
  else process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('takt-default-fc builtins', () => {
  it.each(LANGUAGES)('%s root owns FC and changes only peer-review call arguments', (language) => {
    const standard = rawStep(readWorkflow(language, 'takt-default'), 'develop');
    const fc = rawStep(readWorkflow(language, 'takt-default-fc'), 'develop');
    expect(fc.args).toEqual({
      ...standard.args,
      reviewer_suite: 'peer-review-suite-finding-contract-base',
      peer_review_workflow: 'peer-review-finding-contract',
    });

    const loaded = loadWorkflow(language, 'takt-default-fc');
    expect(loaded.findingContract).toMatchObject({
      manager: { providerRoutingPersonaKey: 'findings-manager' },
      adjudicator: { providerRoutingPersonaKey: 'supervisor' },
      stopBudget: { maxRounds: 40 },
      reviewBudget: { maxReviewRounds: 6 },
    });
  });

  it.each(LANGUAGES)('%s callable FC chain and terminal authority are wired', (language) => {
    const standard = readWorkflow(language, 'peer-review');
    const peerReviewRaw = expandWorkflow(language, 'peer-review-finding-contract');
    const peerReview = loadWorkflow(language, 'peer-review-finding-contract');
    const suite = loadWorkflow(language, 'peer-review-suite-finding-contract-base');

    expect(peerReview.subworkflow?.requiresFindingContract).toBe(true);
    expect(Object.keys(peerReview.subworkflow?.params ?? {})).toEqual(
      Object.keys(loadWorkflow(language, 'peer-review').subworkflow?.params ?? {}),
    );
    expect(readWorkflow(language, 'peer-review-finding-contract').subworkflow?.params?.reviewer_suite?.default)
      .toBe('peer-review-suite-finding-contract-base');
    expect(suite.subworkflow).toMatchObject({
      callable: true,
      requiresFindingContract: true,
      returns: ['needs_fix', 'needs_review', 'needs_terminal_adjudication', 'need_replan'],
    });
    expect(rawStep(peerReviewRaw, 'final-gate').finding_contract_authority)
      .toBe('terminal_adjudication');

    const references = collectStrings(peerReviewRaw);
    for (const forbidden of FORBIDDEN_FC_REFS) {
      expect(references, forbidden).not.toContain(forbidden);
    }
    expect(standard.subworkflow?.params).toBeDefined();
  });

  it.each(LANGUAGES)('%s standard reviewers retain all fields except FC formats', (language) => {
    const standard = rawStep(expandWorkflow(language, 'peer-review-suite-base'), 'reviewers');
    const fc = rawStep(expandWorkflow(language, 'peer-review-suite-finding-contract-base'), 'reviewers');
    expect(fc.parallel).toHaveLength(REVIEWERS.length);

    for (const [index, [name, format]] of REVIEWERS.entries()) {
      const standardReviewer = standard.parallel?.[index];
      const fcReviewer = fc.parallel?.[index];
      expect(fcReviewer?.name).toBe(name);
      expect(fcReviewer).toEqual({
        ...standardReviewer,
        output_contracts: {
          report: [{
            ...standardReviewer?.output_contracts?.report?.[0],
            format,
          }],
        },
      });
      expect(fcReviewer?.output_contracts?.report).toHaveLength(1);
    }

    const loaded = loadedStep(loadWorkflow(language, 'peer-review-suite-finding-contract-base'), 'reviewers');
    expect(loaded.parallel?.map((step) => step.outputContracts?.[0]?.formatRef))
      .toEqual(REVIEWERS.map(([, format]) => format));
  });

  it.each(LANGUAGES)('%s resolves FC remediation facets and preserves non-FC verifier', (language) => {
    expect(rawStep(readWorkflow(language, 'peer-review-finding-contract'), 'fix-verifier').uses)
      .toBe('peer-review-fix-verifier-finding-contract');
    expect(rawStep(readWorkflow(language, 'peer-review'), 'fix-verifier').uses)
      .toBe('peer-review-fix-verifier');
    expect(rawStep(readWorkflow(language, 'review-remediation'), 'fix-verifier').uses)
      .toBe('peer-review-fix-verifier');

    const fc = loadWorkflow(language, 'peer-review-finding-contract');
    expect(loadedStep(fc, 'fix-plan').instruction)
      .toBe(resolveInstruction(language, 'fix-plan-finding-contract'));
    expect(loadedStep(fc, 'fix').instruction)
      .toBe(resolveInstruction(language, 'fix-finding-contract'));
    expect(loadedStep(fc, 'fix-verifier').instruction)
      .toBe(resolveInstruction(language, 'verify-fix-finding-contract'));

    const standardVerifier = resolveInstruction(language, 'verify-fix');
    expect(loadedStep(loadWorkflow(language, 'peer-review'), 'fix-verifier').instruction)
      .toBe(standardVerifier);
    expect(loadedStep(loadWorkflow(language, 'review-remediation'), 'fix-verifier').instruction)
      .toBe(standardVerifier);
  });

  it.each(LANGUAGES)('%s loop monitor cycles and specialized instructions match the design', (language) => {
    const raw = readWorkflow(language, 'peer-review-finding-contract').loop_monitors ?? [];
    const loaded = loadWorkflow(language, 'peer-review-finding-contract').loopMonitors ?? [];
    expect(raw.map(({ cycle, ignore_steps: ignoreSteps, threshold, judge }) => ({
      cycle,
      ignoreSteps,
      threshold,
      instruction: judge.instruction,
    }))).toEqual([
      {
        cycle: ['fix-plan', 'fix', 'reviewers'],
        ignoreSteps: ['fix-verifier', 'fix-retry'],
        threshold: 5,
        instruction: 'loop-monitor-reviewers-fix-fc',
      },
      {
        cycle: ['fix-plan', 'fix', 'reviewers', 'final-gate'],
        ignoreSteps: ['fix-verifier', 'fix-retry'],
        threshold: 5,
        instruction: 'loop-monitor-reviewers-fix-fc',
      },
      {
        cycle: ['fix-plan', 'fix'],
        ignoreSteps: ['fix-verifier', 'fix-retry'],
        threshold: 4,
        instruction: 'loop-monitor-fix-replan-finding-contract',
      },
      {
        cycle: ['fix-retry', 'fix-verifier'],
        ignoreSteps: undefined,
        threshold: 4,
        instruction: 'loop-monitor-fix-verifier-finding-contract',
      },
    ]);
    expect(loaded.map(({ judge }) => judge.instruction)).toEqual([
      resolveInstruction(language, 'loop-monitor-reviewers-fix-fc'),
      resolveInstruction(language, 'loop-monitor-reviewers-fix-fc'),
      resolveInstruction(language, 'loop-monitor-fix-replan-finding-contract'),
      resolveInstruction(language, 'loop-monitor-fix-verifier-finding-contract'),
    ]);

    const observationInstructions = loaded.map(({ judge }) => judge.instruction);
    for (const instruction of observationInstructions) {
      expect(instruction).toContain('Phase 1 response');
      expect(instruction).not.toMatch(/as supporting evidence|Use the latest reports|latest plan/iu);
      expect(instruction).not.toMatch(/補助証拠として|最新レビュー報告|直近の計画/u);
    }
  });

  it.each(LANGUAGES)('%s suite when() rules partition every valid 0/1/2 state', (language) => {
    const reviewers = loadedStep(
      loadWorkflow(language, 'peer-review-suite-finding-contract-base'),
      'reviewers',
    );
    const reached = new Set<number>();
    const states = enumerateFindingCounts();
    expect(states).toHaveLength(1440);
    const rules = reviewers.rules;
    if (rules === undefined) throw new Error('Missing suite self rules');
    expect(rules).toHaveLength(10);

    for (const counts of states) {
      const match = new RuleEvaluator(reviewers, { state: workflowState(reviewers, counts) })
        .evaluate(undefined);
      const expected = expectedRuleMatch(counts);
      expect(match?.index, JSON.stringify(counts)).toBe(expected.index);
      if (match === undefined) throw new Error(`Missing rule match: ${JSON.stringify(counts)}`);
      expect(determineRuleTransition(reviewers, match.index), JSON.stringify(counts)).toEqual({
        ...(expected.nextStep === undefined ? {} : { nextStep: expected.nextStep }),
        ...(expected.returnValue === undefined ? {} : { returnValue: expected.returnValue }),
      });
      reached.add(match.index);
    }
    expect([...reached].sort((left, right) => left - right)).toEqual(
      rules.map((_, index) => index),
    );
  });

  it.each(LANGUAGES)('%s category, discovery, and catalog contain one entry', (language) => {
    const categories = parseYaml(
      readFileSync(builtinPath(language, 'workflow-categories.yaml'), 'utf-8'),
    ) as { workflow_categories: Record<string, { workflows: string[] }> };
    const categoryEntries = Object.values(categories.workflow_categories)
      .flatMap(({ workflows }) => workflows)
      .filter((name) => name === 'takt-default-fc');
    expect(categoryEntries).toHaveLength(1);

    const workflows = loadAllWorkflowsWithSourcesFromDirs(
      join(testRoot, `project-${language}`),
      [{ dir: builtinPath(language, 'workflows'), source: 'builtin' }],
      undefined,
      undefined,
      true,
    );
    expect([...workflows.keys()].filter((name) => name === 'takt-default-fc')).toHaveLength(1);

    const catalogPath = join(process.cwd(), 'docs', language === 'ja'
      ? 'builtin-catalog.ja.md'
      : 'builtin-catalog.md');
    expect(readFileSync(catalogPath, 'utf-8').match(/\| `takt-default-fc` \|/gu)).toHaveLength(1);
  });
});
