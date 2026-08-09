import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../agents/runner.js', () => ({ runAgent: runAgentMock }));

import { getAllParallelSubSteps } from '../core/models/index.js';
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
import {
  hasFindingsReference,
  type WorkflowRuleCondition,
} from '../core/models/workflow-rule-condition.js';
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
import { WorkflowEngine } from './helpers/workflow-engine.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import {
  freshConflictAdjudicationSnapshot,
  refreshActiveConflictAdjudicationSnapshots,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import {
  captureConflictTargetContentDigests,
  captureReviewScopeProofSnapshot,
} from '../core/workflow/findings/snapshot.js';
import { conflictTargetPaths } from '../core/workflow/findings/conflict-target.js';

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
const EXPECTED_FC_LADDER_STEPS = [
  ['finding-contract-boundary-review', 'boundary-reviewers'],
  ['finding-contract-local-review', 'reviewers'],
  ['merge-readiness-finding-contract-final-gate', 'merge-readiness-review'],
  ['merge-readiness-finding-contract-final-gate', 'supervise'],
  ['peer-review-suite-finding-contract-base', 'reviewers'],
  ['review-fix-takt-default-high', 'reviewers'],
  ['takt-default-high', 'reviewers'],
  ['takt-default-team-high', 'reviewers'],
] as const;
const EXPECTED_RESTATEMENT_LADDER_STEPS = [
  ['merge-readiness-finding-contract-final-gate', 'merge-readiness-review'],
  ['merge-readiness-finding-contract-final-gate', 'supervise'],
  ['peer-review-suite-finding-contract-base', 'reviewers'],
] as const;
const RESTATEMENT_COUNT_KEYS = [
  'requiresGuaranteedPresentationCount',
  'restatementReadyCount',
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
let engineScenarioCwd: string | undefined;

const ENGINE_SCENARIO_OBSERVATION = {
  runId: 'builtin-fc-engine-scenario',
  stepName: 'reviewers',
  timestamp: '2026-08-09T00:00:00.000Z',
};

function createBuiltinEngineScenarioConfig(): WorkflowConfig {
  const builtin = loadWorkflow('en', 'takt-default-high');
  const reviewers = loadedStep(builtin, 'reviewers');
  const fix = loadedStep(builtin, 'fix');
  const reviewer = {
    name: 'reviewers',
    kind: 'agent' as const,
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    instruction: 'Review the current implementation.',
    passPreviousResponse: false,
    rules: reviewers.rules?.filter((rule) => (
      !containsAggregate(rule.condition)
      && ['finding-conflict-adjudication', 'fix', 'ABORT'].includes(rule.next ?? '')
    )),
  };
  return {
    ...builtin,
    name: 'builtin-fc-engine-scenario',
    initialStep: 'reviewers',
    maxSteps: 8,
    loopMonitors: [],
    findingContract: {
      ...builtin.findingContract,
      adjudicator: {
        persona: 'supervisor',
        instruction: 'adjudicate-finding-contract',
      },
    },
    steps: [{
      name: 'fix',
      kind: 'agent' as const,
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Apply the fix.',
      passPreviousResponse: false,
      rules: fix.rules?.filter((rule) => rule.next === 'reviewers'),
    }, reviewer],
  };
}

async function seedBuiltinEngineScenarioLedger(cwd: string) {
  const evidence = verifiedFindingEvidenceFixture({
    cwd,
    path: 'src/a.ts',
    startLine: 1,
    title: 'Disputed issue',
    description: 'Reviewers disagree about the implementation.',
    familyTag: 'bug',
    targetFindingId: 'F-0001',
  });
  const authorized = authorizeFindingLedgerFixture({
    workflowName: 'builtin-fc-engine-scenario',
    nextId: 2,
    updatedAt: ENGINE_SCENARIO_OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: 'Disputed issue',
      description: 'Reviewers disagree about the implementation.',
      evidenceIds: [evidence.record.evidenceId],
      reviewers: ['reviewer'],
      rawFindingIds: ['raw-1'],
      firstSeen: ENGINE_SCENARIO_OBSERVATION,
      lastSeen: ENGINE_SCENARIO_OBSERVATION,
    }],
    rawFindings: [{
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'reviewer',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      description: 'Reviewers disagree about the implementation.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: {
        targetFindingId: 'F-0001',
        targetRevision: 1,
        targetStatus: 'open',
        targetEvidenceHash: '0'.repeat(64),
      },
      evidence: [evidence.evidence],
    }],
    conflicts: [{
      id: 'C-FA2947446963',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-1'],
      description: 'Reviewers disagree about the implementation.',
      firstSeen: ENGINE_SCENARIO_OBSERVATION,
      lastSeen: ENGINE_SCENARIO_OBSERVATION,
      revision: 1,
    }],
    evidenceRecords: [evidence.record],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
  });
  const landed = landUnownedConflictRawClaims({
    ledger: authorized,
    observation: ENGINE_SCENARIO_OBSERVATION,
  });
  const snapshot = captureReviewScopeProofSnapshot(cwd);
  const queryInventoryByPath = new Map(
    snapshot.queryInventory.map((entry) => [entry.path, entry]),
  );
  const ledger = refreshActiveConflictAdjudicationSnapshots({
    ledger: landed,
    originStep: 'reviewers',
    createdAt: ENGINE_SCENARIO_OBSERVATION,
    targetContentDigestsByConflict: new Map([[
      'C-FA2947446963',
      captureConflictTargetContentDigests(
        queryInventoryByPath,
        conflictTargetPaths({ ledger: landed, conflictId: 'C-FA2947446963' }),
      ),
    ]]),
  });
  const store = createTestFindingLedgerStore({
    projectCwd: cwd,
    runId: 'test-report-dir',
    reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
    workflowName: 'builtin-fc-engine-scenario',
  });
  await store.updateLedger(() => ({ ledger, result: undefined }));
  return store;
}

async function refreshBuiltinEngineScenarioSnapshot(
  store: Awaited<ReturnType<typeof seedBuiltinEngineScenarioLedger>>,
  cwd: string,
): Promise<void> {
  const snapshot = captureReviewScopeProofSnapshot(cwd);
  const queryInventoryByPath = new Map(
    snapshot.queryInventory.map((entry) => [entry.path, entry]),
  );
  await store.updateLedger((ledger) => ({
    ledger: refreshActiveConflictAdjudicationSnapshots({
      ledger,
      originStep: 'reviewers',
      createdAt: {
        runId: 'builtin-fc-engine-scenario',
        stepName: 'reviewers',
        timestamp: new Date().toISOString(),
      },
      targetContentDigestsByConflict: new Map(
        ledger.conflicts
          .filter((conflict) => conflict.status === 'active')
          .map((conflict) => [
            conflict.id,
            captureConflictTargetContentDigests(
              queryInventoryByPath,
              conflictTargetPaths({ ledger, conflictId: conflict.id }),
            ),
          ] as const),
      ),
    }),
    result: undefined,
  }));
}

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

interface BuiltinFindingLadderStep {
  workflow: string;
  step: WorkflowStep;
}

function collectBuiltinFindingLadderSteps(language: Language): BuiltinFindingLadderStep[] {
  return readdirSync(builtinPath(language, 'workflows'))
    .filter((file) => file.endsWith('.yaml'))
    .flatMap((file) => {
      const workflowName = file.replace(/\.yaml$/u, '');
      const raw = readWorkflow(language, workflowName);
      if (raw.finding_contract === undefined && raw.subworkflow?.requires_finding_contract !== true) {
        return [];
      }
      const workflow = loadWorkflow(language, workflowName);
      return workflow.steps
        .filter((candidate) => candidate.rules?.some((rule) => hasFindingsReference(rule.condition)))
        .map((step) => ({ workflow: workflowName, step }));
    });
}

function conditionShape(condition: WorkflowRuleCondition): string {
  switch (condition.kind) {
    case 'semantic':
      return 'semantic';
    case 'when':
      return `when(${condition.expression})`;
    case 'aggregate':
      return `${condition.aggregate}(${condition.targetConditions.map(conditionShape).join(',')})`;
    case 'and':
      return `${conditionShape(condition.left)}&&${conditionShape(condition.right)}`;
  }
}

function containsAggregate(condition: WorkflowRuleCondition): boolean {
  switch (condition.kind) {
    case 'aggregate':
      return true;
    case 'and':
      return containsAggregate(condition.left) || containsAggregate(condition.right);
    default:
      return false;
  }
}

function ladderSignature(step: WorkflowStep): Array<{
  condition: string;
  transition: ReturnType<typeof determineRuleTransition>;
}> {
  return (step.rules ?? []).map((rule, index) => ({
    condition: conditionShape(rule.condition),
    transition: determineRuleTransition(step, index),
  }));
}

function findBuiltinLadderStep(
  targets: readonly BuiltinFindingLadderStep[],
  workflow: string,
  stepName: string,
  language: Language,
): WorkflowStep {
  const target = targets.find((candidate) => (
    candidate.workflow === workflow && candidate.step.name === stepName
  ));
  if (target === undefined) {
    throw new Error(`Missing ${language} finding ladder step: ${workflow}:${stepName}`);
  }
  return target.step;
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
  if (step.parallel !== undefined) {
    for (const subStep of getAllParallelSubSteps(step.parallel)) {
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
    return { index: 1, returnValue: 'needs_fix' };
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
  runAgentMock.mockReset();
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
  if (engineScenarioCwd !== undefined && existsSync(engineScenarioCwd)) {
    rmSync(engineScenarioCwd, { recursive: true, force: true });
  }
  engineScenarioCwd = undefined;
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

  it.each(LANGUAGES)('%s routes adjudicated unresolved conflicts to fix while stop budget remains', (language) => {
    const reviewers = loadedStep(
      loadWorkflow(language, 'peer-review-suite-finding-contract-base'),
      'reviewers',
    );
    for (const [roundBudgetExhausted, expected] of [
      [false, { returnValue: 'needs_fix' }],
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

  it('en/ja all builtin FC control ladders keep condition and transition symmetry', () => {
    const targetsByLanguage = Object.fromEntries(
      LANGUAGES.map((language) => [language, collectBuiltinFindingLadderSteps(language)]),
    ) as Record<Language, BuiltinFindingLadderStep[]>;

    for (const [workflow, stepName] of EXPECTED_FC_LADDER_STEPS) {
      const enStep = findBuiltinLadderStep(targetsByLanguage.en, workflow, stepName, 'en');
      const jaStep = findBuiltinLadderStep(targetsByLanguage.ja, workflow, stepName, 'ja');
      expect(ladderSignature(jaStep), `${workflow}:${stepName}`).toEqual(ladderSignature(enStep));
    }
  });

  it('executes the builtin FC conflict route through WorkflowEngine', async () => {
    engineScenarioCwd = mkdtempSync(join(tmpdir(), 'takt-default-fc-engine-'));
    mkdirSync(join(engineScenarioCwd, 'src'), { recursive: true });
    writeFileSync(join(engineScenarioCwd, 'src', 'a.ts'), 'export const value = true;\n');
    initializeGitFixture(engineScenarioCwd, ['src/a.ts']);
    const store = await seedBuiltinEngineScenarioLedger(engineScenarioCwd);
    let adjudicationCalls = 0;
    let fixCalls = 0;
    let codeChanges = 0;
    let engine: WorkflowEngine;
    runAgentMock.mockImplementation(async (...args: unknown[]) => {
      const persona = typeof args[0] === 'string' ? args[0] : 'unknown';
      const instruction = typeof args[1] === 'string' ? args[1] : '';
      const options = args[2];
      if (typeof options === 'object' && options !== null && 'onPromptResolved' in options
        && typeof options.onPromptResolved === 'function') {
        options.onPromptResolved({
          systemPrompt: 'system',
          userInstruction: typeof args[1] === 'string' ? args[1] : '',
        });
      }
      const outputSchema = typeof options === 'object' && options !== null
        && 'outputSchema' in options
        ? options.outputSchema
        : undefined;
      const taskManifestMatch = /## Task manifest\s+```json\s+([\s\S]*?)\s+```/u.exec(instruction);
      const taskManifest = taskManifestMatch?.[1] === undefined
        ? undefined
        : JSON.parse(taskManifestMatch[1]) as Record<string, unknown>;
      if (typeof taskManifest?.taskId === 'string'
        && Array.isArray(taskManifest.candidateIntents)) {
        const evaluations = taskManifest.candidateIntents.flatMap((intent) => {
          if (typeof intent !== 'object' || intent === null || typeof intent.intentId !== 'string') {
            return [];
          }
          return [{
            intentId: intent.intentId,
            result: { kind: 'no_action', reason: 'No manager action is required.' },
          }];
        });
        return {
          persona,
          status: 'done' as const,
          content: '{}',
          structuredOutput: {
            taskId: taskManifest.taskId,
            evaluations,
            selectedIntentId: null,
          },
          timestamp: new Date('2026-08-09T00:00:04.000Z'),
        };
      }
      if ((JSON.stringify(outputSchema) ?? '').includes('terminate_subject')) {
        adjudicationCalls += 1;
        const adjudicationSnapshot = freshConflictAdjudicationSnapshot(
          store.loadLedger(),
          'C-FA2947446963',
        );
        return {
          persona,
          status: 'done' as const,
          content: '{}',
          structuredOutput: {
            proposal: {
              kind: 'undetermined' as const,
              subjectIds: adjudicationSnapshot.subjects.map(({ subjectId }) => subjectId).sort(),
              rationale: 'No verified terminal authority is available.',
            },
          },
          timestamp: new Date('2026-08-09T00:00:02.000Z'),
        };
      }
      if (persona === 'coder' || persona.includes('fix')) {
        fixCalls += 1;
        if (fixCalls === 1) {
          codeChanges += 1;
          writeFileSync(join(engineScenarioCwd!, 'src', 'a.ts'), 'export const value = false;\n');
          await refreshBuiltinEngineScenarioSnapshot(store, engineScenarioCwd!);
          (engine as unknown as { refreshFindingsState: () => void }).refreshFindingsState();
        }
        return {
          persona,
          status: 'done' as const,
          content: 'Fixes are complete',
          timestamp: new Date('2026-08-09T00:00:03.000Z'),
        };
      }
      return {
        persona,
        status: 'done' as const,
        content: 'No findings.',
        timestamp: new Date('2026-08-09T00:00:01.000Z'),
      };
    });

    engine = new WorkflowEngine(
      createBuiltinEngineScenarioConfig(),
      engineScenarioCwd,
      'Exercise the builtin conflict route.',
      {
        projectCwd: engineScenarioCwd,
        provider: 'claude',
        reportDirName: 'test-report-dir',
      },
    );
    const result = await engine.run();

    expect(result.status).toBe('aborted');
    expect(adjudicationCalls).toBe(4);
    expect(fixCalls).toBe(2);
    expect(codeChanges).toBe(1);
  });

  it.each(LANGUAGES)('%s all builtin FC control ladders are total over the finding state product', (language) => {
    const states = enumerateFindingCountProduct();
    const targets = collectBuiltinFindingLadderSteps(language);
    expect(targets.map(({ workflow, step }) => `${workflow}:${step.name}`).sort()).toEqual(
      EXPECTED_FC_LADDER_STEPS.map(([workflow, step]) => `${workflow}:${step}`).sort(),
    );

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

  it.each(LANGUAGES)('%s restatement conditions return needs_review on every applicable ladder', (language) => {
    const targets = collectBuiltinFindingLadderSteps(language);

    for (const [workflow, stepName] of EXPECTED_RESTATEMENT_LADDER_STEPS) {
      const step = findBuiltinLadderStep(targets, workflow, stepName, language);
      const matchingRuleIndexes = RESTATEMENT_COUNT_KEYS.map((countKey) => {
        const indexes = (step.rules ?? []).flatMap((rule, index) => (
          rule.condition.kind === 'when'
            && rule.condition.expression.includes(`findings.reviewerAnomalies.${countKey} > 0`)
            && rule.returnValue === 'needs_review'
            ? [index]
            : []
        ));
        expect(indexes, `${language}:${workflow}:${stepName}:${countKey}`).toHaveLength(1);
        return { countKey, ruleIndex: indexes[0]! };
      });
      const openRuleIndex = (step.rules ?? []).findIndex((rule) => (
        rule.condition.kind === 'when'
        && rule.condition.expression.includes('findings.open.count > 0')
        && rule.returnValue === 'needs_fix'
      ));
      expect(openRuleIndex, `${language}:${workflow}:${stepName}`).toBeGreaterThanOrEqual(0);
      for (const { countKey, ruleIndex } of matchingRuleIndexes) {
        const condition = step.rules?.[ruleIndex]?.condition;
        if (condition?.kind !== 'when') {
          throw new Error(`Missing restatement condition: ${language}:${workflow}:${stepName}:${countKey}`);
        }
        if (workflow === 'merge-readiness-finding-contract-final-gate') {
          expect(condition.expression).toContain('findings.reviewerAnomalies.budgetExhausted == false');
          expect(ruleIndex).toBeGreaterThan(openRuleIndex);
        }
        expect(determineRuleTransition(step, ruleIndex)).toEqual({ returnValue: 'needs_review' });

        const counts: FindingCounts = {
          ...EMPTY_FINDING_COUNTS,
          [countKey]: 1,
        };
        const match = new RuleEvaluator(step, { state: ladderWorkflowState(step, counts) })
          .evaluate(undefined);
        expect(match?.index, `${language}:${workflow}:${stepName}:${countKey}`).toBe(ruleIndex);
        if (match === undefined) {
          throw new Error(`Missing restatement match: ${language}:${workflow}:${stepName}:${countKey}`);
        }
        expect(determineRuleTransition(step, match.index)).toEqual({ returnValue: 'needs_review' });

        if (workflow === 'merge-readiness-finding-contract-final-gate') {
          const openMatch = new RuleEvaluator(step, {
            state: ladderWorkflowState(step, {
              ...EMPTY_FINDING_COUNTS,
              open: 1,
              anomalies: 1,
              [countKey]: 1,
            }),
          }).evaluate(undefined);
          expect(openMatch?.index, `${language}:${workflow}:${stepName}:open-precedence`).toBe(openRuleIndex);
          const exhaustedMatch = new RuleEvaluator(step, {
            state: ladderWorkflowState(step, {
              ...EMPTY_FINDING_COUNTS,
              anomalies: 1,
              anomalyBudgetExhausted: true,
              [countKey]: 1,
            }),
          }).evaluate(undefined);
          expect(exhaustedMatch?.index, `${language}:${workflow}:${stepName}:budget-guard`).not.toBe(ruleIndex);
        }
      }
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
