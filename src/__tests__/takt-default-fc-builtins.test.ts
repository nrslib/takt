import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  FindingsRuleContext,
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import { hasFindingsReference } from '../core/models/workflow-rule-condition.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import {
  iterateWorkflowDir,
  loadAllWorkflowsWithSourcesFromDirs,
} from '../infra/config/loaders/workflowDiscovery.js';
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
  requiresGuaranteedPresentationCount: number;
  restatementReadyCount: number;
  claimBearingTerminalCount: number;
  protocolNoiseRejectedCount: number;
  conflicts: number;
  unadjudicated: number;
}

interface ExpectedRuleMatch {
  index: number;
  nextStep?: string;
  returnValue?: string;
}

const LANGUAGES = ['en', 'ja'] as const;
const EXPECTED_FC_LADDER_WORKFLOWS = [
  'finding-contract-boundary-review',
  'finding-contract-local-review',
  'merge-readiness-finding-contract-final-gate',
  'peer-review-suite-finding-contract-base',
  'review-fix-takt-default-high',
  'takt-default-high',
  'takt-default-team-high',
] as const;
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
const LOOP_MONITOR_TRANSITIONS = [
  ['reviewers', 'fix-plan', 'ABORT'],
  ['reviewers', 'fix-plan', 'ABORT'],
  ['fix-plan', 'ABORT'],
  ['fix-retry', 'fix-plan', 'ABORT'],
] as const;
const EMPTY_FINDING_COUNTS: FindingCounts = {
  open: 0,
  provisional: 0,
  dismissEligible: 0,
  provisionalFixpoint: false,
  roundBudgetExhausted: false,
  anomalies: 0,
  anomalyBudgetExhausted: false,
  requiresGuaranteedPresentationCount: 0,
  restatementReadyCount: 0,
  claimBearingTerminalCount: 0,
  protocolNoiseRejectedCount: 0,
  conflicts: 0,
  unadjudicated: 0,
};

let testRoot: string;

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

function collectBuiltinFindingLadderSteps(language: Language): Array<{
  workflow: string;
  step: WorkflowStep;
}> {
  return readdirSync(builtinPath(language, 'workflows'))
    .filter((file) => file.endsWith('.yaml'))
    .flatMap((file) => {
      const workflowName = file.replace(/\.yaml$/u, '');
      const raw = readWorkflow(language, workflowName);
      if (raw.finding_contract === undefined && raw.subworkflow?.requires_finding_contract !== true) {
        return [];
      }
      const workflow = loadWorkflow(language, workflowName);
      const step = workflow.steps.find((candidate) => (
          candidate.rules !== undefined
          && candidate.rules[0] !== undefined
          && hasFindingsReference(candidate.rules[0].condition)
        ));
      return step === undefined ? [] : [{ workflow: workflowName, step }];
    });
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
      requiresGuaranteedPresentationCount: counts.requiresGuaranteedPresentationCount,
      restatementReadyCount: counts.restatementReadyCount,
      claimBearingTerminalCount: counts.claimBearingTerminalCount,
      protocolNoiseRejectedCount: counts.protocolNoiseRejectedCount,
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

function ladderWorkflowState(step: WorkflowStep, counts: FindingCounts): WorkflowState {
  const state = workflowState(step, counts);
  if (Array.isArray(step.parallel)) {
    for (const subStep of step.parallel) {
      state.stepOutputs.set(subStep.name, {
        persona: subStep.personaDisplayName,
        status: 'done',
        content: '',
        timestamp: new Date(0),
        matchedRuleIndex: 0,
      } satisfies AgentResponse);
    }
  }
  return state;
}

function expectedRuleMatch(counts: FindingCounts): ExpectedRuleMatch {
  if (counts.conflicts > 0 && counts.unadjudicated > 0) {
    return { index: 0, nextStep: 'finding-conflict-adjudication' };
  }
  if (counts.conflicts > 0 && !counts.roundBudgetExhausted) {
    return { index: 1, returnValue: 'needs_review' };
  }
  if (counts.conflicts > 0) return { index: 2, nextStep: 'ABORT' };
  if (counts.claimBearingTerminalCount > 0) {
    // 言い直し予算を使い切った claim-bearing anomaly は再計画では直せない
    // （レビュアーの protocol 違反であってプロダクト側の欠陥ではない）ため、
    // final gate 経由で review_integrity_unresolved の可視的失敗へ送る。
    return { index: 3, returnValue: 'needs_terminal_adjudication' };
  }
  // 言い直しは slot 内で消化されるため、レビュー step 終了時に言い直し待ちが
  // 残るのは予算枯渇系だけ。修正可能な open finding があるならそちらを先に回す。
  if (counts.open > 0 && counts.provisional === 0) {
    return { index: 4, returnValue: 'needs_fix' };
  }
  if (counts.requiresGuaranteedPresentationCount > 0) {
    return { index: 5, returnValue: 'needs_review' };
  }
  if (counts.restatementReadyCount > 0) {
    return { index: 6, returnValue: 'needs_review' };
  }
  if (counts.dismissEligible > 0) {
    return { index: 7, returnValue: 'needs_terminal_adjudication' };
  }
  if (counts.provisionalFixpoint) return { index: 8, returnValue: 'need_replan' };
  if (counts.roundBudgetExhausted && counts.provisional > 0) {
    return { index: 9, returnValue: 'need_replan' };
  }
  if (counts.provisional > 0) return { index: 10, returnValue: 'need_replan' };
  // 予算枯渇の出口は open の有無で塞がない。open が残っている状態は上の
  // needs_fix / need_replan がすでに拾っているので、ここへ来る時点で open は 0。
  if (counts.anomalies > 0 && counts.anomalyBudgetExhausted) {
    return { index: 11, returnValue: 'need_replan' };
  }
  if (counts.anomalies > 0) {
    return { index: 12, returnValue: 'needs_review' };
  }
  return { index: 13, nextStep: 'COMPLETE' };
}

/**
 * 全域性検証用の状態空間。`enumerateFindingCounts` と違い、次元間の含意
 * （provisional <= open など）を一切課さない直積を列挙する。到達不能な組合せまで
 * 含めて必ずどれかのルールに一致することを示せば、実行時の rule_no_match は
 * 「ラダー定義のバグ」だけを表す検出器になる。
 */
function enumerateFindingCountProduct(): FindingCounts[] {
  const states: FindingCounts[] = [];
  for (const open of [0, 1, 2]) {
    for (const provisional of [0, 1, 2]) {
      for (const dismissEligible of [0, 1, 2]) {
        for (const conflicts of [0, 1, 2]) {
          for (const unadjudicated of [0, 1, 2]) {
            for (const anomalies of [0, 1, 2]) {
              for (const provisionalFixpoint of [false, true]) {
                for (const roundBudgetExhausted of [false, true]) {
                  for (const anomalyBudgetExhausted of [false, true]) {
                    for (const requiresGuaranteedPresentationCount of [0, 1]) {
                      for (const restatementReadyCount of [0, 1]) {
                        for (const claimBearingTerminalCount of [0, 1]) {
                          states.push({
                            open,
                            provisional,
                            dismissEligible,
                            provisionalFixpoint,
                            roundBudgetExhausted,
                            anomalies,
                            anomalyBudgetExhausted,
                            requiresGuaranteedPresentationCount,
                            restatementReadyCount,
                            claimBearingTerminalCount,
                            protocolNoiseRejectedCount: 0,
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
      }
    }
  }
  return states;
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
                  for (const requiresGuaranteedPresentationCount of [0, 1, 2]) {
                    for (const restatementReadyCount of [0, 1, 2]) {
                      for (const claimBearingTerminalCount of [0, 1, 2]) {
                        for (const anomalyBudgetExhausted of [false, true]) {
                          states.push({
                            open,
                            provisional,
                            dismissEligible,
                            provisionalFixpoint,
                            roundBudgetExhausted,
                            anomalies,
                            anomalyBudgetExhausted,
                            requiresGuaranteedPresentationCount,
                            restatementReadyCount,
                            claimBearingTerminalCount,
                            protocolNoiseRejectedCount: 0,
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
      }
    }
  }
  return states;
}

beforeEach(() => {
  const configDir = process.env.TAKT_CONFIG_DIR;
  if (configDir === undefined) throw new Error('TAKT_CONFIG_DIR must be set by test-setup.ts');
  testRoot = dirname(configDir);
  for (const language of LANGUAGES) {
    const projectConfigDir = join(testRoot, `project-${language}`, '.takt');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), `language: ${language}\n`);
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

afterEach(() => {
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

describe('takt-default-fc builtins', () => {
  it.each(LANGUAGES)('%s root owns FC and changes only FC-specialized call arguments', (language) => {
    const standard = rawStep(readWorkflow(language, 'takt-default'), 'develop');
    const fc = rawStep(readWorkflow(language, 'takt-default-fc'), 'develop');
    expect(fc.args).toEqual({
      ...standard.args,
      replan_instruction: 'replan-implementation-finding-contract',
      reviewer_suite: 'peer-review-suite-finding-contract-base',
      peer_review_workflow: 'peer-review-finding-contract',
    });

    const loaded = loadWorkflow(language, 'takt-default-fc');
    expect(loaded.findingContract).toMatchObject({
      manager: { providerRoutingPersonaKey: 'findings-manager' },
      adjudicator: {
        providerRoutingPersonaKey: 'supervisor',
        instruction: expect.stringContaining('ledger subject'),
      },
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

    expect(loaded).toHaveLength(LOOP_MONITOR_TRANSITIONS.length);
    for (const [monitorIndex, monitor] of loaded.entries()) {
      const expectedTransitions = LOOP_MONITOR_TRANSITIONS[monitorIndex];
      if (expectedTransitions === undefined) throw new Error(`Unexpected monitor: ${monitorIndex}`);
      expect(monitor.judge.rules).toHaveLength(expectedTransitions.length);
      const instruction = monitor.judge.instruction;
      if (instruction === undefined) throw new Error(`Missing monitor instruction: ${monitorIndex}`);

      const judgeStep: WorkflowStep = {
        name: `_loop_judge_test_${monitorIndex}`,
        personaDisplayName: 'loop-judge',
        instruction,
        rules: monitor.judge.rules,
      };
      for (const [ruleIndex, expectedNextStep] of expectedTransitions.entries()) {
        const condition = monitor.judge.rules[ruleIndex]?.condition;
        if (condition?.kind !== 'semantic') {
          throw new Error(`Expected semantic monitor rule: ${monitorIndex}:${ruleIndex}`);
        }
        const match = new RuleEvaluator(judgeStep, {
          state: workflowState(judgeStep, EMPTY_FINDING_COUNTS),
        }).evaluate({ label: condition.label, method: 'ai_judge' });
        expect(match?.index).toBe(ruleIndex);
        if (match === undefined) throw new Error(`Missing monitor rule match: ${monitorIndex}:${ruleIndex}`);
        expect(determineRuleTransition(judgeStep, match.index)).toEqual({
          nextStep: expectedNextStep,
        });
      }
    }
  });

  it.each(LANGUAGES)('%s suite when() rules partition every valid 0/1/2 state', (language) => {
    const reviewers = loadedStep(
      loadWorkflow(language, 'peer-review-suite-finding-contract-base'),
      'reviewers',
    );
    const reached = new Set<number>();
    const states = enumerateFindingCounts();
    expect(states).toHaveLength(38880);
    const rules = reviewers.rules;
    if (rules === undefined) throw new Error('Missing suite self rules');
    expect(rules).toHaveLength(14);

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

  it.each(LANGUAGES)('%s keeps unresolved conflicts in review while stop budget remains', (language) => {
    const reviewers = loadedStep(
      loadWorkflow(language, 'peer-review-suite-finding-contract-base'),
      'reviewers',
    );
    for (const [roundBudgetExhausted, expected] of [
      [false, { returnValue: 'needs_review' }],
      [true, { nextStep: 'ABORT' }],
    ] as const) {
      const counts = {
        ...EMPTY_FINDING_COUNTS,
        conflicts: 1,
        unadjudicated: 0,
        roundBudgetExhausted,
      };
      const match = new RuleEvaluator(reviewers, { state: workflowState(reviewers, counts) })
        .evaluate(undefined);
      if (match === undefined) throw new Error(`Missing rule match: ${JSON.stringify(counts)}`);
      expect(determineRuleTransition(reviewers, match.index)).toEqual(expected);
    }
  });

  it.each(LANGUAGES)('%s suite ladder is total over the finding state product', (language) => {
    const reviewers = loadedStep(
      loadWorkflow(language, 'peer-review-suite-finding-contract-base'),
      'reviewers',
    );
    const states = enumerateFindingCountProduct();
    expect(states).toHaveLength(46656);

    // 実測（run-13）: 予算枯渇の出口が open.count == 0 を前提にしていたため、
    // open が残る限りどの出口にも入れず reviewers を13周し、最後は
    // rule_no_match で abort した。全域性が保てていれば本番で fail-fast は起きない。
    // 1件も一致しないラダー穴は undefined ではなく RuleDetectionExhaustedError で出る
    // （undefined は rules 自体が空のときだけ）。捕捉しないと filter の中で例外が
    // 伝播し、どの FindingCounts が抜けたのか分からないまま落ちる。
    const unmatched = states.filter((counts) => {
      try {
        return new RuleEvaluator(reviewers, { state: workflowState(reviewers, counts) })
          .evaluate(undefined) === undefined;
      } catch (error) {
        if (error instanceof RuleDetectionExhaustedError) {
          return true;
        }
        throw error;
      }
    });
    expect(unmatched.slice(0, 3).map((counts) => JSON.stringify(counts))).toEqual([]);

    // 予算枯渇状態は open の有無によらず必ず前進する出口を持つ。
    for (const counts of states.filter((state) => (
      state.conflicts === 0 && state.anomalies > 0 && state.anomalyBudgetExhausted
    ))) {
      const match = new RuleEvaluator(reviewers, { state: workflowState(reviewers, counts) })
        .evaluate(undefined);
      if (match === undefined) throw new Error(`Missing rule match: ${JSON.stringify(counts)}`);
      const transition = determineRuleTransition(reviewers, match.index);
      expect(transition, JSON.stringify(counts)).not.toEqual({ nextStep: 'COMPLETE' });
    }
  });

  it.each(LANGUAGES)('%s all builtin FC control ladders are total over the finding state product', (language) => {
    const states = enumerateFindingCountProduct();
    const targets = collectBuiltinFindingLadderSteps(language);
    expect(targets.map(({ workflow }) => workflow).sort()).toEqual([...EXPECTED_FC_LADDER_WORKFLOWS]);

    for (const { workflow, step } of targets) {
      const unmatched = states.filter((counts) => {
        const selections = [
          undefined,
          { label: 'approved', method: 'auto_select' as const },
        ];
        for (const selection of selections) {
          try {
            if (new RuleEvaluator(step, { state: ladderWorkflowState(step, counts) })
              .evaluate(selection) !== undefined) {
              return false;
            }
          } catch (error) {
            if (!(error instanceof RuleDetectionExhaustedError)) {
              throw error;
            }
          }
        }
        return true;
      });
      expect(unmatched.slice(0, 3).map((counts) => JSON.stringify(counts)), workflow)
        .toEqual([]);
    }
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
    expect([...iterateWorkflowDir(builtinPath(language, 'workflows'), 'builtin')]
      .filter(({ name }) => name === 'takt-default-fc')).toHaveLength(1);
    expect(workflows.get('takt-default-fc')).toMatchObject({ source: 'builtin' });

    const catalogPath = join(process.cwd(), 'docs', language === 'ja'
      ? 'builtin-catalog.ja.md'
      : 'builtin-catalog.md');
    expect(readFileSync(catalogPath, 'utf-8').match(/\| `takt-default-fc` \|/gu)).toHaveLength(1);
  });
});
