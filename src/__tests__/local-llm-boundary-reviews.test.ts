import { createHash } from 'node:crypto';
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
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';

type Locale = 'ja' | 'en';

interface RawRule {
  condition: string;
  next?: string;
}

interface RawStep {
  name: string;
  uses?: string;
  call?: string;
  finding_contract_authority?: string;
  tags?: string[];
  parallel?: Array<{ name: string }>;
  rules?: RawRule[];
}

interface RawWorkflow {
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

const SHARED_CONTRACT_HASHES: Record<Locale, Record<string, string>> = {
  ja: {
    architecture: '5939c48f17e7592352691c978a9151ead2858d7973999deb944f4371e0673eed',
    'ai-antipattern': '49b3f41d6c35691d101cf2340486611e189d03c4edf7a778e767dec5392212d2',
    coding: '5a06c7bbfbfd421929d728c72c830f5ecdc8fe309036ee91dd27df4a50ffd1d4',
    'implementation-semantics': '340a77e69c157ceda5626ca235eb51fcdc6eeff044b9ba9d2f926f9da754ae74',
    'contract-lifecycle': '88ad553e74f32ccd5b58186b2feaa04b11f757564345120379fe129e94e5f07f',
    robustness: '7e44afd8884736ca632954fd716d8b304f956f142082031bce36314d1cf272c9',
  },
  en: {
    architecture: '92c38cf528a745bb9adc4c0caad45aedc4a9e9e170bf8964dc6df2c0a304a6e6',
    'ai-antipattern': 'a05c395d12d278ac836d3a8bfb5465198063fb8a37337e1bb9ab5dc91d1aa48e',
    coding: 'a4fecf3f2d46142ae6bf73e8ed2f04d33fdcce1c5efe1730d2e243378b73bd1f',
    'implementation-semantics': '33f49cfc8200fb9fa0d53a5bdf76cc667a282f7844c8a9e3104f7bce5bb00965',
    'contract-lifecycle': '7f3de629b7293d22cf6fdc0cd31b60fc252c439872ba83cd1d130a4f898198da',
    robustness: '77b5ed8c246d5167163d832089c415c1d03b7e98dc56d528fb01ee50fcb9e24a',
  },
};

const SHARED_CONTRACT_NAMES = Object.keys(SHARED_CONTRACT_HASHES.ja);
const EXPECTED_UNMONITORED_CYCLES = [
  ['plan', 'write_tests'],
  ['write_tests'],
];
const EXPECTED_CYCLES = [
  { cycle: ['replan', 'implement'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers'], threshold: 2 },
  { cycle: ['replan', 'implement', 'reviewers', 'fix'], threshold: 2 },
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
  { cycle: ['replan', 'reviewers'], threshold: 2 },
  { cycle: ['replan', 'reviewers', 'fix'], threshold: 2 },
  { cycle: ['replan', 'reviewers', 'local-review-integrity-gate'], threshold: 2 },
  {
    cycle: ['replan', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers'],
    threshold: 2,
  },
  {
    cycle: [
      'replan',
      'reviewers',
      'local-review-integrity-gate',
      'boundary-reviewers',
      'final-gate',
    ],
    threshold: 2,
  },
  { cycle: ['replan', 'reviewers', 'local-review-integrity-gate', 'fix'], threshold: 2 },
  {
    cycle: ['replan', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers', 'fix'],
    threshold: 2,
  },
  {
    cycle: [
      'replan',
      'reviewers',
      'local-review-integrity-gate',
      'boundary-reviewers',
      'final-gate',
      'fix',
    ],
    threshold: 2,
  },
  {
    cycle: [
      'replan',
      'reviewers',
      'local-review-integrity-gate',
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
      'reviewers',
      'local-review-integrity-gate',
      'reviewers',
      'local-review-integrity-gate',
    ],
    threshold: 1,
  },
  { cycle: ['reviewers', 'local-review-integrity-gate'], threshold: 2 },
  { cycle: ['boundary-reviewers', 'final-gate'], threshold: 2 },
  {
    cycle: [
      'replan',
      'implement',
      'reviewers',
      'local-review-integrity-gate',
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
      'local-review-integrity-gate',
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
      'local-review-integrity-gate',
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
      'local-review-integrity-gate',
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

const HIGH_WORKFLOW_NAMES = [
  'takt-default-high',
  'takt-default-team-high',
  'review-fix-takt-default-high',
] as const;

const HIGH_FINITE_STOP_MONITORS = [
  {
    cycle: ['replan', 'implement', 'reviewers', 'final-gate', 'fix'],
    path: ['final-gate', 'fix', 'replan', 'implement', 'reviewers', 'final-gate'],
    instruction: 'loop-monitor-fix-replan',
    nextSteps: ['replan', 'ABORT'],
    exit: 'reviewers',
  },
  {
    cycle: ['replan', 'reviewers', 'final-gate', 'fix'],
    path: ['final-gate', 'fix', 'replan', 'reviewers', 'final-gate'],
    instruction: 'loop-monitor-fix-replan',
    nextSteps: ['replan', 'ABORT'],
    exit: 'reviewers',
  },
  {
    cycle: ['reviewers', 'final-gate'],
    path: ['reviewers', 'final-gate', 'reviewers'],
    instruction: 'loop-monitor-gate-needs-review',
    nextSteps: ['reviewers', 'fix', 'replan', 'ABORT'],
    exit: 'COMPLETE',
  },
] as const;

let testRoot: string;
let previousTaktConfigDir: string | undefined;

function workflowPath(locale: Locale, name: string): string {
  return join(process.cwd(), 'builtins', locale, 'workflows', `${name}.yaml`);
}

function readRawWorkflow(locale: Locale, name = 'takt-default-localllm'): RawWorkflow {
  const path = workflowPath(locale, name);
  const workflow = parseYaml(readFileSync(path, 'utf-8')) as RawWorkflow;
  return resolveWorkflowStepFragments(workflow, {
    candidateDirs: buildStepFragmentLookupDirs({ lang: locale }),
    context: { lang: locale, projectDir: process.cwd() },
    workflowPath: path,
  }).raw as RawWorkflow;
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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

    expect(loadedWorkflow.findingContract).not.toHaveProperty('reviewerOutput');
    expect(transitionFor(
      reviewers,
      'findings.open.count == 0 && findings.provisional.count == 0 && findings.conflicts.count == 0',
    )).toBe('local-review-integrity-gate');
    expect(reviewers.rules?.some((rule) => /^(?:all|any)\(/u.test(rule.condition))).toBe(false);
    expect(transitionFor(localIntegrityGate, 'COMPLETE')).toBe('boundary-reviewers');
    expect(transitionFor(localIntegrityGate, 'needs_review')).toBe('reviewers');
    expect(transitionFor(
      boundary,
      'findings.open.count == 0 && findings.provisional.count == 0 && findings.conflicts.count == 0',
    )).toBe('final-gate');
    expect(transitionFor(
      boundary,
      'findings.open.count > 0 && findings.provisional.count == 0 && findings.conflicts.count == 0',
    )).toBe('fix');
    expect(boundary.rules?.some((rule) => /^(?:all|any)\(/u.test(rule.condition))).toBe(false);
    expect(transitionFor(finalGate, 'needs_review')).toBe('boundary-reviewers');
    expect(localIntegrityGate.call).toBe('merge-readiness-finding-contract-final-gate');
    expect(finalGate.call).toBe(localIntegrityGate.call);
    expect(localIntegrityGate.finding_contract_authority).toBe('terminal_adjudication');
    expect(finalGate.finding_contract_authority).toBe('terminal_adjudication');
    expect(transitionFor(reviewers, 'findings.provisional.dismissEligible.count > 0'))
      .toBe('local-review-integrity-gate');
    expect(transitionFor(boundary, 'findings.provisional.dismissEligible.count > 0'))
      .toBe('final-gate');

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

  it.each(['ja', 'en'] as const)('%s の共有6 Finding Contractは既存内容と完全一致する', (locale) => {
    for (const name of SHARED_CONTRACT_NAMES) {
      const path = join(
        process.cwd(),
        'builtins',
        locale,
        'facets',
        'output-contracts',
        `${name}-review-finding-contract.md`,
      );
      expect(sha256(readFileSync(path, 'utf-8'))).toBe(SHARED_CONTRACT_HASHES[locale][name]);
    }
  });

  it.each(['ja', 'en'] as const)('%s の全builtin Finding Contract outputは実行経路に応じた単一machine形式を要求する', (locale) => {
    const dir = join(process.cwd(), 'builtins', locale, 'facets', 'output-contracts');
    const names = readdirSync(dir).filter((name) => name.endsWith('-finding-contract.md'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const outputContract = readFileSync(join(dir, name), 'utf8');
      expect(outputContract.match(/^## Finding Contract Claims$/gmu)).toHaveLength(1);
      expect(outputContract).toContain('structured');
      expect(outputContract).not.toMatch(/^## (?:Observed Findings|Resolution Confirmations|観測した指摘|解消確認)/mu);
      expect(outputContract).not.toContain('| # | family_tag');
      expect(outputContract).not.toMatch(/(?:20|30|40) lines|(?:20|30|40)行/u);
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

      expect(outputContract).toContain('## Finding Contract Claims');
      expect(outputContract).not.toContain('| # | family_tag');
      expect(outputContract).toContain(`\`${name}\``);
      expect(outputContract).toContain('`file:line`');
      expect(outputContract).toContain('`file:line-line`');
      expect(outputContract).toMatch(locale === 'ja'
        ? /report に記載したすべての問題を structured output にも含める/
        : /every issue described in the report must also appear in that structured output/);
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

  it.each(['ja', 'en'] as const)('%s の既存high workflowは共有6契約の実効formatを維持する', (locale) => {
    for (const workflowName of ['takt-default-high', 'takt-default-team-high']) {
      const workflow = loadBuiltinWorkflow(locale, workflowName);
      expect(workflow.findingContract).not.toHaveProperty('reviewerOutput');
      const substeps = getParallelSubsteps(workflow, 'reviewers');
      const contracts = substeps.map((step) => step.outputContracts?.[0]);

      expect(contracts.map((contract) => contract?.formatRef)).toEqual(
        SHARED_CONTRACT_NAMES.map((name) => `${name}-review-finding-contract`),
      );
      for (const [index, contract] of contracts.entries()) {
        expect(sha256(contract?.format ?? '')).toBe(
          SHARED_CONTRACT_HASHES[locale][SHARED_CONTRACT_NAMES[index]!],
        );
      }
    }
  });

  it('high 3 workflowのfinite-stop monitorは英日で同じ構造を持つ', () => {
    const monitorStructure = (locale: Locale, workflowName: string) => {
      const monitors = readRawWorkflow(locale, workflowName).loop_monitors ?? [];
      return HIGH_FINITE_STOP_MONITORS.map(({ cycle }) => {
        const matches = monitors.filter((monitor) => (
          JSON.stringify(monitor.cycle) === JSON.stringify(cycle)
        ));
        expect(matches).toHaveLength(1);
        const monitor = matches[0]!;
        return {
          cycle: monitor.cycle,
          threshold: monitor.threshold,
          instruction: monitor.judge.instruction,
          nextSteps: monitor.judge.rules.map((rule) => rule.next),
        };
      });
    };

    const expected = HIGH_FINITE_STOP_MONITORS.map(({ cycle, instruction, nextSteps }) => ({
      cycle: [...cycle],
      threshold: 2,
      instruction,
      nextSteps: [...nextSteps],
    }));

    for (const workflowName of HIGH_WORKFLOW_NAMES) {
      expect(monitorStructure('en', workflowName)).toEqual(expected);
      expect(monitorStructure('ja', workflowName)).toEqual(expected);
    }
  });

  it.each(['ja', 'en'] as const)(
    '%s のhigh 3 workflowは対象cycleの自然遷移で初回を許容し、2回目だけ発火する',
    (locale) => {
      for (const workflowName of HIGH_WORKFLOW_NAMES) {
        const rawWorkflow = readRawWorkflow(locale, workflowName);
        const monitors = loadBuiltinWorkflow(locale, workflowName).loopMonitors ?? [];

        for (const { cycle, path, exit } of HIGH_FINITE_STOP_MONITORS) {
          expectReachablePath(rawWorkflow, path);
          const monitor = monitors.find((candidate) => (
            JSON.stringify(candidate.cycle) === JSON.stringify(cycle)
          ));
          expect(monitor).toBeDefined();
          expect(monitor?.threshold).toBe(2);

          const firstIteration = [...cycle, cycle[0]];
          expectReachablePath(rawWorkflow, firstIteration);
          expect(recordPath(new CycleDetector([monitor!]), firstIteration)
            .every((result) => !result.triggered)).toBe(true);

          const secondIteration = [...cycle, ...cycle, cycle[0]];
          expectReachablePath(rawWorkflow, secondIteration);
          const results = recordPath(new CycleDetector([monitor!]), secondIteration);
          expect(results.slice(0, -1).every((result) => !result.triggered)).toBe(true);
          expect(results.at(-1)).toEqual({
            triggered: true,
            cycleCount: 2,
            monitor,
          });

          const naturalExit = [...cycle, ...cycle, exit];
          expectReachablePath(rawWorkflow, naturalExit);
          expect(recordPath(new CycleDetector([monitor!]), naturalExit)
            .every((result) => !result.triggered)).toBe(true);
        }
      }
    },
  );

  it.each(['ja', 'en'] as const)('%s のraw rulesにある未監視cycleは意図した2件だけである', (locale) => {
    const workflow = readRawWorkflow(locale);
    const monitoredCycleKeys = new Set(
      (workflow.loop_monitors ?? []).map((monitor) => cycleKey(monitor.cycle)),
    );
    const unmonitoredCycles = enumerateSimpleCycles(workflow)
      .filter((cycle) => !monitoredCycleKeys.has(cycleKey(cycle)));

    expect(unmonitoredCycles).toEqual(EXPECTED_UNMONITORED_CYCLES);
  });

  it.each(['ja', 'en'] as const)(
    '%s のreplanからreviewersへ直行する全経路はimplement経由と同じ有限停止判定を持つ',
    (locale) => {
      const monitors = readRawWorkflow(locale).loop_monitors ?? [];
      const implementCycles = monitors.filter(({ cycle }) => (
        cycle[0] === 'replan'
        && cycle[1] === 'implement'
        && cycle[2] === 'reviewers'
      ));

      expect(implementCycles).toHaveLength(10);
      for (const source of implementCycles) {
        const companionCycle = [source.cycle[0]!, ...source.cycle.slice(2)];
        const companion = monitors.find(({ cycle }) => (
          cycleKey(cycle) === cycleKey(companionCycle)
        ));

        expect(companion).toMatchObject({
          threshold: source.threshold,
          judge: source.judge,
        });
      }
    },
  );

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
      ['fix', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers', 'final-gate', 'boundary-reviewers'],
      ['replan', 'implement', 'reviewers', 'local-review-integrity-gate', 'boundary-reviewers', 'final-gate', 'boundary-reviewers'],
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
        nextSteps: ['reviewers', 'fix', 'replan', 'ABORT'],
      },
      {
        cycle: ['boundary-reviewers', 'final-gate'],
        threshold: 2,
        instruction: 'loop-monitor-gate-needs-review',
        nextSteps: ['boundary-reviewers', 'fix', 'replan', 'ABORT'],
      },
    ]);
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
