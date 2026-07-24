import { execFileSync } from 'node:child_process';
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
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';

type Locale = 'ja' | 'en';

interface RawRule {
  condition: string;
  next?: string;
}

interface RawStep {
  name: string;
  call?: string;
  tags?: string[];
  parallel?: Array<{ name: string }>;
  rules?: RawRule[];
}

interface RawWorkflow {
  subworkflow?: {
    attestation?: {
      kind: string;
      approval_steps: string[];
    };
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

const SHARED_CONTRACT_NAMES = [
  'architecture',
  'ai-antipattern',
  'coding',
  'implementation-semantics',
  'contract-lifecycle',
  'robustness',
] as const;
const EXPECTED_UNMONITORED_CYCLES = [
  ['plan', 'write_tests'],
  ['write_tests'],
];
const EXPECTED_CYCLES = [
  { cycle: ['replan', 'implement'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers', 'boundary-reviewers'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers', 'boundary-reviewers', 'final-gate'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers', 'fix'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers', 'boundary-reviewers', 'fix'], threshold: 2 },
  {
    cycle: ['replan', 'implement', 'reviewers', 'boundary-reviewers', 'final-gate', 'fix'],
    threshold: 2,
  },
  { cycle: ['replan', 'implement', 'reviewers', 'local-review-integrity-gate'], threshold: 2 },
  {
    cycle: ['replan', 'implement', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers'],
    threshold: 2,
  },
  {
    cycle: [
      'replan',
      'implement',
      'reviewers',
      'local-review-integrity-gate',
      'boundary-reviewers',
      'final-gate',
    ],
    threshold: 2,
  },
  { cycle: ['replan', 'implement', 'reviewers', 'local-review-integrity-gate', 'fix'], threshold: 2 },
  {
    cycle: ['replan', 'implement', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers', 'fix'],
    threshold: 2,
  },
  {
    cycle: [
      'replan',
      'implement',
      'reviewers',
      'local-review-integrity-gate',
      'boundary-reviewers',
      'final-gate',
      'fix',
    ],
    threshold: 2,
  },
  { cycle: ['reviewers', 'local-review-integrity-gate'], threshold: 2 },
  { cycle: ['boundary-reviewers', 'final-gate'], threshold: 2 },
  {
    cycle: [
      'replan',
      'implement',
      'reviewers',
      'boundary-reviewers',
      'final-gate',
      'boundary-reviewers',
      'final-gate',
    ],
    threshold: 1,
  },
  {
    cycle: [
      'replan',
      'implement',
      'reviewers',
      'local-review-integrity-gate',
      'reviewers',
      'local-review-integrity-gate',
    ],
    threshold: 1,
  },
  { cycle: ['fix', 'reviewers'], threshold: 3 },
  { cycle: ['fix', 'reviewers', 'boundary-reviewers'], threshold: 3 },
  { cycle: ['fix', 'reviewers', 'boundary-reviewers', 'final-gate'], threshold: 3 },
  { cycle: ['fix', 'reviewers', 'local-review-integrity-gate'], threshold: 3 },
  { cycle: ['fix', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers'], threshold: 3 },
  {
    cycle: ['fix', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers', 'final-gate'],
    threshold: 3,
  },
  {
    cycle: [
      'fix',
      'reviewers',
      'boundary-reviewers',
      'final-gate',
      'boundary-reviewers',
      'final-gate',
    ],
    threshold: 1,
  },
  {
    cycle: [
      'fix',
      'reviewers',
      'local-review-integrity-gate',
      'reviewers',
      'local-review-integrity-gate',
    ],
    threshold: 1,
  },
];

const COMPOSITE_CLOSED_PATHS = [
  {
    path: [
      'fix',
      'reviewers',
      'boundary-reviewers',
      'final-gate',
      'boundary-reviewers',
      'final-gate',
      'fix',
    ],
    exit: 'COMPLETE',
  },
  {
    path: [
      'replan',
      'implement',
      'reviewers',
      'boundary-reviewers',
      'final-gate',
      'boundary-reviewers',
      'final-gate',
      'replan',
    ],
    exit: 'COMPLETE',
  },
  {
    path: [
      'fix',
      'reviewers',
      'local-review-integrity-gate',
      'reviewers',
      'local-review-integrity-gate',
      'fix',
    ],
    exit: 'boundary-reviewers',
  },
  {
    path: [
      'replan',
      'implement',
      'reviewers',
      'local-review-integrity-gate',
      'reviewers',
      'local-review-integrity-gate',
      'replan',
    ],
    exit: 'boundary-reviewers',
  },
] as const;

const INNER_GATE_MONITORS = [
  {
    cycle: ['reviewers', 'local-review-integrity-gate'],
    exits: ['boundary-reviewers', 'replan', 'fix', 'finding-conflict-adjudication', 'ABORT'],
  },
  {
    cycle: ['boundary-reviewers', 'final-gate'],
    exits: ['COMPLETE', 'replan', 'fix', 'finding-conflict-adjudication', 'ABORT'],
  },
] as const;

let testRoot: string;
let previousTaktConfigDir: string | undefined;

function workflowPath(locale: Locale, name: string): string {
  return join(process.cwd(), 'builtins', locale, 'workflows', `${name}.yaml`);
}

function readRawWorkflow(locale: Locale, name = 'takt-default-localllm'): RawWorkflow {
  return parseYaml(readFileSync(workflowPath(locale, name), 'utf-8')) as RawWorkflow;
}

function loadBuiltinWorkflow(locale: Locale, name = 'takt-default-localllm'): WorkflowConfig {
  const projectDir = join(testRoot, `project-${locale}`);
  const projectConfigDir = join(projectDir, '.takt');
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(join(projectConfigDir, 'config.yaml'), `language: ${locale}\n`);
  invalidateAllResolvedConfigCache();
  return loadWorkflowFromFile(workflowPath(locale, name), projectDir);
}

function getRawStep(workflow: RawWorkflow, name: string): RawStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing raw step: ${name}`);
  }
  return step;
}

function getLoadedStep(workflow: WorkflowConfig, name: string): WorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing loaded step: ${name}`);
  }
  return step;
}

function getParallelSubsteps(workflow: WorkflowConfig, name: string): WorkflowStep[] {
  const parallel = getLoadedStep(workflow, name).parallel;
  if (!parallel) {
    throw new Error(`Missing parallel substeps: ${name}`);
  }
  return parallel;
}

function transitionFor(step: RawStep, conditionFragment: string): string | undefined {
  return step.rules?.find((rule) => rule.condition.includes(conditionFragment))?.next;
}

function normalizeCycle(cycle: string[]): string[] {
  const rotations = cycle.map((_, index) => [
    ...cycle.slice(index),
    ...cycle.slice(0, index),
  ]);
  return rotations.reduce((smallest, candidate) => (
    JSON.stringify(candidate) < JSON.stringify(smallest) ? candidate : smallest
  ));
}

function cycleKey(cycle: string[]): string {
  return JSON.stringify(normalizeCycle(cycle));
}

function enumerateSimpleCycles(workflow: RawWorkflow): string[][] {
  const stepNames = new Set(workflow.steps.map((step) => step.name));
  const edges = new Map(workflow.steps.map((step) => [
    step.name,
    [...new Set(
      (step.rules ?? [])
        .map((rule) => rule.next)
        .filter((next): next is string => next !== undefined && stepNames.has(next)),
    )],
  ]));
  const cycles = new Map<string, string[]>();

  function visit(start: string, current: string, path: string[], visited: Set<string>): void {
    for (const next of edges.get(current) ?? []) {
      if (next === start) {
        const normalized = normalizeCycle(path);
        cycles.set(JSON.stringify(normalized), normalized);
      } else if (!visited.has(next)) {
        visited.add(next);
        visit(start, next, [...path, next], visited);
        visited.delete(next);
      }
    }
  }

  for (const start of stepNames) {
    visit(start, start, [start], new Set([start]));
  }

  return [...cycles.values()].sort((left, right) => cycleKey(left).localeCompare(cycleKey(right)));
}

function recordPath(
  detector: CycleDetector,
  path: readonly string[],
): Array<ReturnType<CycleDetector['recordAndCheck']>> {
  return path.slice(0, -1).map((step, index) => (
    detector.recordAndCheck(step, path[index + 1]!)
  ));
}

function expectReachablePath(workflow: RawWorkflow, path: readonly string[]): void {
  for (const [index, stepName] of path.slice(0, -1).entries()) {
    const nextStep = path[index + 1]!;
    expect(
      getRawStep(workflow, stepName).rules?.some((rule) => rule.next === nextStep),
      `${stepName} -> ${nextStep}`,
    ).toBe(true);
  }
}

beforeAll(() => {
  previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  testRoot = mkdtempSync(join(tmpdir(), 'takt-local-llm-boundary-'));
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

describe('takt-default-localllm boundary reviews', () => {
  it.each(['ja', 'en'] as const)('%s は通常レビュー後にintegrity gateと3境界レビューを配線する', (locale) => {
    const rawWorkflow = readRawWorkflow(locale);
    const loadedWorkflow = loadBuiltinWorkflow(locale);
    const reviewers = getRawStep(rawWorkflow, 'reviewers');
    const localIntegrityGate = getRawStep(rawWorkflow, 'local-review-integrity-gate');
    const boundary = getRawStep(rawWorkflow, 'boundary-reviewers');
    const finalGate = getRawStep(rawWorkflow, 'final-gate');

    expect(transitionFor(reviewers, 'all(')).toBe('boundary-reviewers');
    expect(transitionFor(reviewers, 'reviewerAnomalies.outstanding > 0')).toBe('local-review-integrity-gate');
    expect(reviewers.rules?.find((rule) => rule.condition.includes('all('))?.condition)
      .toContain('reviewerAnomalies.outstanding == 0');
    expect(transitionFor(localIntegrityGate, 'COMPLETE')).toBe('boundary-reviewers');
    expect(transitionFor(localIntegrityGate, 'needs_review')).toBe('reviewers');
    expect(transitionFor(boundary, 'all(')).toBe('final-gate');
    expect(transitionFor(boundary, 'any("needs_fix")')).toBe('fix');
    expect(transitionFor(finalGate, 'needs_review')).toBe('boundary-reviewers');
    expect(localIntegrityGate.call).toBe('merge-readiness-finding-contract-final-gate');
    expect(finalGate.call).toBe(localIntegrityGate.call);

    const expected = [
      {
        name: 'contract-wiring-review',
        persona: 'contract-lifecycle-reviewer',
        format: 'contract-wiring-review-finding-contract',
        heading: locale === 'ja' ? '# 契約配線レビュー' : '# Contract Wiring Review',
        knowledgeHeading: locale === 'ja' ? '# 契約ライフサイクル知識' : '# Contract Lifecycle Knowledge',
      },
      {
        name: 'resource-ownership-review',
        persona: 'resource-ownership-reviewer',
        format: 'resource-ownership-review-finding-contract',
        heading: locale === 'ja' ? '# 資源所有権レビュー' : '# Resource Ownership Review',
        knowledgeHeading: locale === 'ja' ? '# 資源所有権知識' : '# Resource Ownership Knowledge',
      },
      {
        name: 'failure-boundary-review',
        persona: 'failure-boundary-reviewer',
        format: 'failure-boundary-review-finding-contract',
        heading: locale === 'ja' ? '# 失敗境界レビュー' : '# Failure Boundary Review',
        knowledgeHeading: locale === 'ja' ? '# 失敗境界知識' : '# Failure Boundary Knowledge',
      },
    ];
    const substeps = getParallelSubsteps(loadedWorkflow, 'boundary-reviewers');

    expect(boundary.tags).toEqual(['review', 'boundary-review']);
    expect(boundary.parallel?.map((step) => step.name)).toEqual(expected.map((step) => step.name));
    for (const expectedStep of expected) {
      const step = substeps.find((candidate) => candidate.name === expectedStep.name);
      expect(step).toMatchObject({
        sessionKey: expectedStep.name,
        tags: ['review', 'boundary-review'],
        passPreviousResponse: false,
        providerRoutingPersonaKey: expectedStep.persona,
      });
      expect(step?.outputContracts?.[0]).toMatchObject({
        name: `${expectedStep.name}.md`,
        formatRef: expectedStep.format,
      });
      expect(step?.outputContracts?.[0]?.format).toContain(expectedStep.heading);
      expect(step?.knowledgeContents).toEqual([
        expect.stringContaining(expectedStep.knowledgeHeading),
      ]);
    }
  });

  it.each(['ja', 'en'] as const)('%s の共有 final gate は二段承認 attestation を持ち、anomaly budget だけでは replan しない', (locale) => {
    const rawWorkflow = readRawWorkflow(locale, 'merge-readiness-finding-contract-final-gate');
    const subworkflow = rawWorkflow.subworkflow;
    const mergeReadiness = getRawStep(rawWorkflow, 'merge-readiness-review');
    const supervise = getRawStep(rawWorkflow, 'supervise');

    expect(subworkflow?.attestation).toEqual({
      kind: 'reviewer_anomaly_acknowledgement',
      approval_steps: ['merge-readiness-review', 'supervise'],
    });
    expect(transitionFor(mergeReadiness, 'approved &&')).toBe('supervise');
    expect(transitionFor(supervise, 'approved &&')).toBe('COMPLETE');
    for (const step of [mergeReadiness, supervise]) {
      expect(step.rules?.some((rule) => rule.condition.includes('reviewerAnomalies.budgetExhausted')))
        .toBe(false);
    }
  });

  it.each(['ja', 'en'] as const)('%s の専用契約はscope・引用・Finding Contract整合性を要求する', (locale) => {
    for (const name of ['contract-wiring', 'resource-ownership', 'failure-boundary']) {
      const path = join(
        process.cwd(),
        'builtins',
        locale,
        'facets',
        'output-contracts',
        `${name}-review-finding-contract.md`,
      );
      const outputContract = readFileSync(path, 'utf-8');

      expect(outputContract).toContain(`| 1 | ${name} |`);
      expect(outputContract).toContain('`file:line`');
      expect(outputContract).toContain('`file:line-line`');
      expect(outputContract).toMatch(locale === 'ja'
        ? /観測した指摘と structured issue、解消確認と structured confirmation/
        : /Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations/);
      expect(outputContract).toMatch(locale === 'ja'
        ? /欠陥を記述したまま APPROVE しない/
        : /Do not describe a defect while returning APPROVE/);
    }
  });

  it.each(['ja', 'en'] as const)('%s の資源・失敗境界instructionは代表的な配線誤分類を除外する', (locale) => {
    const instructions = [
      'review-resource-ownership.md',
      'review-failure-boundary.md',
    ].map((name) => readFileSync(join(
      process.cwd(),
      'builtins',
      locale,
      'facets',
      'instructions',
      name,
    ), 'utf-8'));

    expect(instructions[0]).toMatch(locale === 'ja'
      ? /保存時に値を空配列へ置き換える欠陥は資源寿命ではないため除外/
      : /replaces a value with an empty array during persistence because it is not a resource-lifetime defect/);
    expect(instructions[1]).toMatch(locale === 'ja'
      ? /保存時に値を欠落させる欠陥は失敗境界ではないため除外/
      : /drops a value during persistence because it is not a failure-boundary defect/);
  });

  it.each(['ja', 'en'] as const)('%s の既存high workflowはformatRefが指す共有6契約を読み込む', (locale) => {
    for (const workflowName of ['takt-default-high', 'takt-default-team-high']) {
      const workflow = loadBuiltinWorkflow(locale, workflowName);
      const substeps = getParallelSubsteps(workflow, 'reviewers');
      const contracts = substeps.map((step) => step.outputContracts?.[0]);

      expect(contracts.map((contract) => contract?.formatRef)).toEqual(
        SHARED_CONTRACT_NAMES.map((name) => `${name}-review-finding-contract`),
      );
      for (const contract of contracts) {
        if (contract?.formatRef === undefined) {
          throw new Error('Shared review contract requires formatRef');
        }
        const source = readFileSync(join(
          process.cwd(),
          'builtins',
          locale,
          'facets',
          'output-contracts',
          `${contract.formatRef}.md`,
        ), 'utf-8');
        expect(contract.format).toBe(source);
      }
    }
  });

  it.each(['ja', 'en'] as const)('%s のraw rulesにある未監視cycleは意図した2件だけである', (locale) => {
    const workflow = readRawWorkflow(locale);
    const monitoredCycleKeys = new Set(
      (workflow.loop_monitors ?? []).map((monitor) => cycleKey(monitor.cycle)),
    );
    const unmonitoredCycles = enumerateSimpleCycles(workflow)
      .filter((cycle) => !monitoredCycleKeys.has(cycleKey(cycle)));

    expect(unmonitoredCycles).toEqual(EXPECTED_UNMONITORED_CYCLES);
  });

  it.each(['ja', 'en'] as const)('%s の全loop monitorは実CycleDetectorへ完全一致履歴を入れると発火する', (locale) => {
    const workflow = loadBuiltinWorkflow(locale);
    const monitors = workflow.loopMonitors ?? [];

    expect(monitors.map(({ cycle, threshold }) => ({ cycle, threshold }))).toEqual(EXPECTED_CYCLES);
    for (const monitor of monitors) {
      const detector = new CycleDetector([monitor]);
      let result = { triggered: false, cycleCount: 0 };

      for (let repetition = 0; repetition < monitor.threshold; repetition++) {
        for (const [index, step] of monitor.cycle.entries()) {
          const nextStep = monitor.cycle[(index + 1) % monitor.cycle.length]!;
          result = detector.recordAndCheck(step, nextStep);
          if (repetition < monitor.threshold - 1 || index < monitor.cycle.length - 1) {
            expect(result.triggered).toBe(false);
          }
        }
      }

      expect(result).toEqual({
        triggered: true,
        cycleCount: monitor.threshold,
        monitor,
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s はfinal gateとintegrity gateの最初の再レビューを許容する', (locale) => {
    const rawWorkflow = readRawWorkflow(locale);
    const workflow = loadBuiltinWorkflow(locale);
    const monitors = workflow.loopMonitors ?? [];
    const paths = [
      ['fix', 'reviewers', 'boundary-reviewers', 'final-gate', 'boundary-reviewers'],
      ['replan', 'implement', 'reviewers', 'boundary-reviewers', 'final-gate', 'boundary-reviewers'],
      ['fix', 'reviewers', 'local-review-integrity-gate', 'reviewers'],
      ['replan', 'implement', 'reviewers', 'local-review-integrity-gate', 'reviewers'],
    ];

    for (const path of paths) {
      expectReachablePath(rawWorkflow, path);
      expect(recordPath(new CycleDetector(monitors), path).every((result) => !result.triggered))
        .toBe(true);
    }
  });

  it.each(['ja', 'en'] as const)('%s のinner gate monitorは2回目の同一needs_reviewだけで発火する', (locale) => {
    const rawWorkflow = readRawWorkflow(locale);
    const monitors = loadBuiltinWorkflow(locale).loopMonitors ?? [];

    for (const { cycle } of INNER_GATE_MONITORS) {
      const monitor = monitors.find((candidate) => (
        JSON.stringify(candidate.cycle) === JSON.stringify(cycle)
      ));
      expect(monitor).toBeDefined();
      expect(monitor?.threshold).toBe(2);

      const firstRetryPath = [...cycle, cycle[0]];
      expectReachablePath(rawWorkflow, firstRetryPath);
      expect(recordPath(new CycleDetector(monitors), firstRetryPath)
        .every((result) => !result.triggered)).toBe(true);

      const secondRetryPath = [...cycle, ...cycle, cycle[0]];
      expectReachablePath(rawWorkflow, secondRetryPath);
      const results = recordPath(new CycleDetector(monitors), secondRetryPath);
      expect(results.slice(0, -1).every((result) => !result.triggered)).toBe(true);
      expect(results.at(-1)).toEqual({
        triggered: true,
        cycleCount: 2,
        monitor,
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s のinner gate monitorはgateからの自然な退出を横取りしない', (locale) => {
    const rawWorkflow = readRawWorkflow(locale);
    const monitors = loadBuiltinWorkflow(locale).loopMonitors ?? [];

    for (const { cycle, exits } of INNER_GATE_MONITORS) {
      for (const exit of exits) {
        const path = [...cycle, ...cycle, exit];
        expectReachablePath(rawWorkflow, path);
        expect(recordPath(new CycleDetector(monitors), path)
          .every((result) => !result.triggered)).toBe(true);
      }
    }
  });

  it('日英のinner gate monitorは同じ構造と発火意味を持つ', () => {
    const monitorStructure = (locale: Locale) => (readRawWorkflow(locale).loop_monitors ?? [])
      .filter((monitor) => INNER_GATE_MONITORS.some(({ cycle }) => (
        JSON.stringify(monitor.cycle) === JSON.stringify(cycle)
      )))
      .map((monitor) => ({
        cycle: monitor.cycle,
        threshold: monitor.threshold,
        instruction: monitor.judge.instruction,
        nextSteps: monitor.judge.rules.map((rule) => rule.next),
      }));

    expect(monitorStructure('ja')).toEqual(monitorStructure('en'));
    expect(monitorStructure('ja')).toEqual([
      {
        cycle: ['reviewers', 'local-review-integrity-gate'],
        threshold: 2,
        instruction: 'loop-monitor-gate-needs-review',
        nextSteps: ['reviewers', 'replan', 'ABORT'],
      },
      {
        cycle: ['boundary-reviewers', 'final-gate'],
        threshold: 2,
        instruction: 'loop-monitor-gate-needs-review',
        nextSteps: ['boundary-reviewers', 'replan', 'ABORT'],
      },
    ]);
  });

  it.each(['ja', 'en'] as const)('%s のanomaly-only inner gate monitorはfinding_contract_fixへ遷移しない', (locale) => {
    const monitors = readRawWorkflow(locale).loop_monitors ?? [];
    const anomalyOnlyMonitors = monitors.filter((monitor) => (
      INNER_GATE_MONITORS.some(({ cycle }) => (
        JSON.stringify(monitor.cycle) === JSON.stringify(cycle)
      ))
    ));

    expect(anomalyOnlyMonitors).toHaveLength(2);
    for (const monitor of anomalyOnlyMonitors) {
      expect(monitor.judge.rules.map((rule) => rule.next)).not.toContain('fix');
    }
  });

  it.each(['ja', 'en'] as const)('%s のanomaly-only台帳をloop judge promptへ注入しreviewersを選ぶ', async (locale) => {
    const workflow = loadBuiltinWorkflow(locale);
    const findingContract = workflow.findingContract;
    if (findingContract === undefined) {
      throw new Error('Missing finding contract');
    }
    const monitor = workflow.loopMonitors?.find((candidate) => (
      JSON.stringify(candidate.cycle)
        === JSON.stringify(['reviewers', 'local-review-integrity-gate'])
    ));
    if (monitor === undefined) {
      throw new Error('Missing anomaly-only inner gate monitor');
    }
    const observation = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    };
    const ledger: FindingLedger = {
      version: 1,
      workflowName: workflow.name,
      nextId: 1,
      updatedAt: observation.timestamp,
      rawFindings: [],
      conflicts: [],
      findings: [],
      reviewerAnomalies: [{
        id: 'RA-0001',
        kind: 'quote-mismatch',
        stableKey: 'anomaly-only',
        lineageKey: 'anomaly-only-lineage',
        sourceRawFindingIds: ['raw-anomaly-only'],
        reviewers: ['coding-review'],
        title: 'unverified claim',
        claimedExcerpt: 'UNVERIFIED_CLAIM_CONTENT',
        mismatchReason: 'quote mismatch',
        firstObserved: observation,
        lastObserved: observation,
        occurrences: 1,
      }],
    };
    const config: WorkflowConfig = {
      name: workflow.name,
      maxSteps: 10,
      initialStep: 'reviewers',
      findingContract,
      loopMonitors: [{
        ...monitor,
        threshold: 1,
        judge: {
          ...monitor.judge,
          personaPath: undefined,
        },
      }],
      steps: [
        {
          name: 'reviewers',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'Review the current evidence.',
          rules: [
            normalizeRule({ condition: 'needs_review', next: 'local-review-integrity-gate' }),
            normalizeRule({ condition: 'stop', next: 'ABORT' }),
          ],
        },
        {
          name: 'local-review-integrity-gate',
          persona: 'supervisor',
          personaDisplayName: 'supervisor',
          instruction: 'Evaluate review integrity.',
          rules: [
            normalizeRule({ condition: 'needs_review', next: 'reviewers' }),
            normalizeRule({ condition: 'stop', next: 'ABORT' }),
          ],
        },
        {
          name: 'replan',
          persona: 'planner',
          personaDisplayName: 'planner',
          instruction: 'Replan the evidence collection.',
          rules: [
            normalizeRule({ condition: 'when(true)', next: 'ABORT' }),
          ],
        },
      ],
    };
    const projectDir = join(testRoot, `anomaly-only-${locale}`);
    mkdirSync(projectDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
    execFileSync('git', [
      '-c', 'user.name=Test User',
      '-c', 'user.email=test@example.com',
      'commit', '--allow-empty', '-m', 'initial',
    ], { cwd: projectDir, stdio: 'pipe' });
    createFindingLedgerStore({
      projectCwd: projectDir,
      reportDir: projectDir,
      workflowName: config.name,
      ledgerPath: findingContract.ledgerPath,
      rawFindingsPath: findingContract.rawFindingsPath,
    }).saveLedger(ledger);
    const engine = new WorkflowEngine(config, projectDir, 'test anomaly-only gate', {
      projectCwd: projectDir,
      provider: 'mock',
      language: locale,
      reportDirName: `anomaly-only-${locale}`,
    });
    let selectedTransition: string | undefined;
    let judgePrompt: string | undefined;
    let reviewerRuns = 0;
    const expectedInstructionContract = locale === 'ja'
      ? 'reviewer anomaly は証拠不成立を示す非 actionable な状態であり、product finding ではありません。actionable な open finding がない限り修正を選ばず、anomaly の claimed content を修正根拠にしないでください。'
      : 'A reviewer anomaly is a non-actionable evidence failure, not a product finding. Do not choose a fix without an actionable open finding, and do not use the anomaly\'s claimed content as repair evidence.';
    const expectedAnomalyState = locale === 'ja'
      ? '現在は open 0件（substantive 0件、ゲートを塞ぐ provisional 0件）'
      : 'currently 0 open (0 substantive, 0 gate-blocking provisional)';
    engine.on('step:start', (step, _iteration, instruction) => {
      let selectedStep = 1;
      if (step.name === 'reviewers') {
        reviewerRuns += 1;
        selectedStep = reviewerRuns === 1 ? 1 : 2;
      } else if (step.name.startsWith('_loop_judge_')) {
        judgePrompt = instruction;
        const hasEngineComputedAnomalyState = [
          '## Findings state (engine-computed)',
          expectedInstructionContract,
          expectedAnomalyState,
          'findings.reviewerAnomalies.count: 1',
        ].every((expected) => instruction.includes(expected))
          && !instruction.includes('UNVERIFIED_CLAIM_CONTENT');
        selectedStep = hasEngineComputedAnomalyState ? 1 : 2;
      }
      setMockScenario([
        { status: 'done', content: `${step.name} response` },
        {
          status: 'done',
          content: `selected step ${selectedStep}`,
          structuredOutput: {
            step: selectedStep,
            reason: 'Selected from the observed prompt in this test',
          },
        },
      ]);
    });
    engine.on('step:complete', (step, response) => {
      if (step.name.startsWith('_loop_judge_') && response.matchedRuleIndex !== undefined) {
        selectedTransition = step.rules?.[response.matchedRuleIndex]?.next;
      }
    });

    try {
      const result = await engine.run();

      expect(judgePrompt).toContain('## Findings state (engine-computed)');
      expect(judgePrompt).toContain(expectedInstructionContract);
      expect(judgePrompt).toContain(expectedAnomalyState);
      expect(judgePrompt).toContain('findings.reviewerAnomalies.count: 1');
      expect(judgePrompt).not.toContain('UNVERIFIED_CLAIM_CONTENT');
      expect(result.status).toBe('aborted');
      expect(selectedTransition).toBe('reviewers');
    } finally {
      engine.removeAllListeners();
      resetScenario();
    }
  });

  it.each(['ja', 'en'] as const)('%s の複合閉路は完全一致して起点へ自然遷移するときだけ発火する', (locale) => {
    const rawWorkflow = readRawWorkflow(locale);
    const workflow = loadBuiltinWorkflow(locale);
    const monitors = workflow.loopMonitors ?? [];

    for (const { path, exit } of COMPOSITE_CLOSED_PATHS) {
      expectReachablePath(rawWorkflow, path);
      const cycle = path.slice(0, -1);
      const monitor = monitors.find((candidate) => (
        JSON.stringify(candidate.cycle) === JSON.stringify(cycle)
      ));
      expect(monitor).toBeDefined();

      const results = recordPath(new CycleDetector([monitor!]), path);
      expect(results.slice(0, -1).every((result) => !result.triggered)).toBe(true);
      expect(results.at(-1)).toEqual({
        triggered: true,
        cycleCount: 1,
        monitor,
      });

      const detector = new CycleDetector([monitor!]);
      let exitResult = { triggered: false, cycleCount: 0 };
      for (const [index, step] of cycle.entries()) {
        const nextStep = index === cycle.length - 1 ? exit : cycle[index + 1]!;
        exitResult = detector.recordAndCheck(step, nextStep);
      }
      expect(exitResult.triggered).toBe(false);
    }
  });

  it.each(['ja', 'en'] as const)('%s の複合monitorは起点に対応するjudge instructionと遷移だけを持つ', (locale) => {
    const monitors = readRawWorkflow(locale).loop_monitors ?? [];

    for (const { path } of COMPOSITE_CLOSED_PATHS) {
      const cycle = path.slice(0, -1);
      const monitor = monitors.find((candidate) => (
        JSON.stringify(candidate.cycle) === JSON.stringify(cycle)
      ));
      expect(monitor).toBeDefined();

      const nextSteps = monitor!.judge.rules.map((rule) => rule.next);
      if (cycle[0] === 'fix') {
        expect(monitor!.judge.instruction).toBe('loop-monitor-reviewers-fix-fc');
        expect(nextSteps).toEqual(['fix', 'replan', 'ABORT']);
      } else {
        expect(monitor!.judge.instruction).toBe('loop-monitor-fix-replan');
        expect(nextSteps).toEqual(['replan', 'ABORT']);
      }
    }
  });

  it.each(['ja', 'en'] as const)('%s の実provider routingは3経路を分離しfinal-gateを後勝ちさせる', (locale) => {
    const workflow = loadBuiltinWorkflow(locale);
    const finalGateWorkflow = loadBuiltinWorkflow(
      locale,
      'merge-readiness-finding-contract-final-gate',
    );
    const regularReviewers = getParallelSubsteps(workflow, 'reviewers');
    const boundaryReviewers = getParallelSubsteps(workflow, 'boundary-reviewers');
    const finalGateSteps = ['merge-readiness-review', 'supervise']
      .map((name) => getLoadedStep(finalGateWorkflow, name));
    const providerRouting = {
      tags: {
        review: { provider: 'opencode' as const, model: 'ollama-cloud/gemma4:31b' },
        'boundary-review': { provider: 'codex' as const, model: 'gpt-5.2-codex' },
        'final-gate': { provider: 'codex' as const, model: 'gpt-5.2-codex' },
      },
    };

    for (const step of regularReviewers) {
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'opencode',
        model: 'ollama-cloud/gemma4:31b',
        providerSource: 'provider_routing.tags',
        modelSource: 'provider_routing.tags',
      });
    }
    for (const step of boundaryReviewers) {
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.2-codex',
        providerSource: 'provider_routing.tags',
        modelSource: 'provider_routing.tags',
      });
    }
    for (const step of finalGateSteps) {
      expect(step.tags).toEqual(expect.arrayContaining(['review', 'final-gate']));
      expect(resolveStepProviderModel({ step, providerRouting })).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.2-codex',
        providerSource: 'provider_routing.tags',
        modelSource: 'provider_routing.tags',
      });
    }
  });

  it.each(['ja', 'en'] as const)('%s のbuiltinへprovider/modelを固定しない', (locale) => {
    const source = readFileSync(workflowPath(locale, 'takt-default-localllm'), 'utf-8');

    expect(source).not.toMatch(/^\s+(?:provider|model):/m);
  });
});
