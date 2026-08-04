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
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';

type Language = 'en' | 'ja';

interface RawStep {
  name?: string;
  call?: string;
  instruction?: unknown;
  args?: Record<string, unknown>;
}

interface RawWorkflow {
  finding_contract?: unknown;
  subworkflow?: { requires_finding_contract?: boolean };
  loop_monitors?: Array<{ cycle?: string[]; judge?: { instruction?: unknown } }>;
  steps?: RawStep[];
}

const LANGUAGES = ['en', 'ja'] as const;
const STANDARD_INSTRUCTIONS = [
  'fix',
  'fix-plan',
  'replan-implementation',
  'loop-monitor-fix-replan',
  'loop-monitor-gate-needs-review',
  'team-leader-fix',
] as const;
const SPECIALIZED_INSTRUCTIONS = [
  'fix-finding-contract',
  'fix-plan-finding-contract',
  'replan-implementation-finding-contract',
  'loop-monitor-fix-replan-finding-contract',
  'loop-monitor-gate-needs-review-finding-contract',
  'team-leader-finding-contract-fix',
] as const;
const COMMON_PARTIALS = [
  'fix-common',
  'fix-plan-common',
  'replan-implementation-common',
  'loop-monitor-fix-replan-common',
  'loop-monitor-gate-needs-review-common',
  'team-leader-fix-common',
] as const;
const SHARED_PURPOSE_PARTIALS = [
  ['fix-plan', 'fix-plan-finding-contract', 'fix-plan-purpose'],
  ['loop-monitor-fix-replan', 'loop-monitor-fix-replan-finding-contract', 'loop-monitor-fix-replan-purpose'],
  ['loop-monitor-gate-needs-review', 'loop-monitor-gate-needs-review-finding-contract', 'loop-monitor-gate-needs-review-purpose'],
] as const;
const FC_HIGH_WORKFLOWS = ['takt-default-high', 'review-fix-takt-default-high'] as const;
const FC_HIGH_MONITORS = [
  { cycle: ['replan', 'implement'], instruction: 'loop-monitor-fix-replan-finding-contract' },
  { cycle: ['replan', 'implement', 'reviewers'], instruction: 'loop-monitor-fix-replan-finding-contract' },
  { cycle: ['replan', 'implement', 'reviewers', 'final-gate'], instruction: 'loop-monitor-fix-replan-finding-contract' },
  { cycle: ['replan', 'implement', 'reviewers', 'fix'], instruction: 'loop-monitor-fix-replan-finding-contract' },
  { cycle: ['fix', 'reviewers'], instruction: 'loop-monitor-reviewers-fix-fc' },
  { cycle: ['fix', 'reviewers', 'final-gate'], instruction: 'loop-monitor-reviewers-fix-fc' },
] as const;
const EXPECTED_FC_MONITORS = {
  'takt-default-high': FC_HIGH_MONITORS,
  'review-fix-takt-default-high': FC_HIGH_MONITORS,
  'takt-default-team-high': FC_HIGH_MONITORS,
  'finding-contract-local-review': [
    {
      cycle: ['reviewers', 'integrity-gate'],
      instruction: 'loop-monitor-gate-needs-review-finding-contract',
    },
  ],
  'finding-contract-boundary-review': [
    {
      cycle: ['boundary-reviewers', 'final-gate'],
      instruction: 'loop-monitor-gate-needs-review-finding-contract',
    },
  ],
} as const;
const FORBIDDEN_STANDARD_TERMS = /Finding Contract|finding contract|findings-ledger|Disputed Findings/u;

let testRoot: string;
let previousTaktConfigDir: string | undefined;

function builtinPath(language: Language, ...parts: string[]): string {
  return join(process.cwd(), 'builtins', language, ...parts);
}

function workflowPath(language: Language, name: string): string {
  return builtinPath(language, 'workflows', `${name}.yaml`);
}

function readInstruction(language: Language, name: string): string {
  return readFileSync(builtinPath(language, 'facets', 'instructions', `${name}.md`), 'utf-8');
}

function readInstructionPartial(language: Language, name: string): string {
  return readFileSync(
    builtinPath(language, 'facets', 'partials', 'instructions', `${name}.md`),
    'utf-8',
  ).trim();
}

function resolveInstruction(language: Language, name: string): string {
  const projectDir = join(testRoot, `project-${language}`);
  return resolveRefToContent(name, undefined, projectDir, 'instructions', {
    projectDir,
    lang: language,
  });
}

function readWorkflow(language: Language, name: string): RawWorkflow {
  return parseYaml(readFileSync(workflowPath(language, name), 'utf-8')) as RawWorkflow;
}

function resolveStepFragments(language: Language, name: string): RawWorkflow {
  const raw = readWorkflow(language, name);
  return resolveWorkflowStepFragments(raw, {
    candidateDirs: buildStepFragmentLookupDirs({ lang: language }),
    context: { lang: language, projectDir: join(testRoot, `project-${language}`) },
    workflowPath: workflowPath(language, name),
  }).raw as RawWorkflow;
}

function loadBuiltinWorkflow(language: Language, name: string): WorkflowConfig {
  invalidateAllResolvedConfigCache();
  return loadWorkflowFromFile(
    workflowPath(language, name),
    join(testRoot, `project-${language}`),
  );
}

function getRawStep(workflow: RawWorkflow, name: string): RawStep {
  const step = workflow.steps?.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Missing raw builtin step: ${name}`);
  return step;
}

function getLoadedStep(workflow: WorkflowConfig, name: string): WorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Missing loaded builtin step: ${name}`);
  return step;
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(collectStringValues);
  }
  return [];
}

function expectSpecializedMonitorContent(
  language: Language,
  workflowName: keyof typeof EXPECTED_FC_MONITORS,
  raw: RawWorkflow,
  loaded: WorkflowConfig,
): void {
  const expectedMonitors = EXPECTED_FC_MONITORS[workflowName];
  const rawMonitors = (raw.loop_monitors ?? []).map((monitor) => ({
    cycle: monitor.cycle,
    instruction: monitor.judge?.instruction,
  }));
  expect(rawMonitors, workflowName).toEqual(expectedMonitors);
  expect(loaded.loopMonitors, workflowName).toHaveLength(expectedMonitors.length);
  for (const [index, monitor] of expectedMonitors.entries()) {
    expect(loaded.loopMonitors?.[index]?.judge.instruction, `${workflowName}:${index}`)
      .toBe(resolveInstruction(language, monitor.instruction));
  }
}

beforeAll(() => {
  previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  testRoot = mkdtempSync(join(tmpdir(), 'takt-fc-facet-specialization-'));
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

describe('builtin instruction Finding Contract specialization', () => {
  it.each(LANGUAGES)('%s standard instructions contain no Finding Contract vocabulary', (language) => {
    for (const name of STANDARD_INSTRUCTIONS) {
      expect(readInstruction(language, name), name).not.toMatch(FORBIDDEN_STANDARD_TERMS);
      expect(resolveInstruction(language, name), name).not.toMatch(FORBIDDEN_STANDARD_TERMS);
    }
  });

  it.each(LANGUAGES)('%s variants inject common behavior and purpose partials', (language) => {
    for (const [index, partial] of COMMON_PARTIALS.entries()) {
      const include = `{{include:instructions/${partial}}}`;
      expect(readInstruction(language, STANDARD_INSTRUCTIONS[index]!), partial).toContain(include);
      expect(readInstruction(language, SPECIALIZED_INSTRUCTIONS[index]!), partial).toContain(include);
    }
    for (const [standard, specialized, partial] of SHARED_PURPOSE_PARTIALS) {
      const include = `{{include:instructions/${partial}}}`;
      expect(readInstruction(language, standard), partial).toContain(include);
      expect(readInstruction(language, specialized), partial).toContain(include);
    }
    for (const name of SPECIALIZED_INSTRUCTIONS) {
      expect(resolveInstruction(language, name), name).not.toContain('{{include:instructions/');
    }
  });

  it.each(LANGUAGES)('%s preserves each legacy report-history contract', (language) => {
    const fix = resolveInstruction(language, 'fix');
    const historyMechanism = readInstructionPartial(language, 'review-report-history');
    const fixPrinciplesHeading = readInstructionPartial(language, 'fix-common').split('\n')[0]!;
    expect(fix.indexOf(historyMechanism)).toBeGreaterThanOrEqual(0);
    expect(fix.indexOf(historyMechanism)).toBeLessThan(fix.indexOf(fixPrinciplesHeading));

    const plan = resolveInstruction(language, 'fix-plan');
    expect(plan).toMatch(language === 'ja' ? /再帰的/u : /recursively/u);
    expect(plan).toMatch(/persists.*reopened/us);
    expect(plan).toContain(language === 'ja'
      ? '別レポートとの時刻比較や古い履歴からの対象追加を行わない'
      : 'do not compare timestamps across report files or add targets from old history');
    expect(plan).toContain(historyMechanism);

    expect(resolveInstruction(language, 'replan-implementation')).not.toContain(historyMechanism);
    expect(resolveInstruction(language, 'replan-implementation-finding-contract'))
      .not.toContain(historyMechanism);

    const fixHeadings = language === 'ja'
      ? ['## 作業結果', '## 変更内容', '## ビルド結果', '## テスト結果', '## 受入条件', '## 証拠']
      : ['## Work results', '## Changes made', '## Build results', '## Test results', '## Acceptance criteria', '## Evidence'];
    for (const instruction of ['fix', 'fix-finding-contract']) {
      const content = resolveInstruction(language, instruction);
      const headingIndexes = fixHeadings.map((heading) => content.indexOf(heading));
      expect(headingIndexes.every((index) => index >= 0), instruction).toBe(true);
      expect(headingIndexes, instruction).toEqual([...headingIndexes].sort((a, b) => a - b));
    }
  });

  it.each(LANGUAGES)('%s loaded high workflows contain specialized fix, replan, and monitor bodies', (language) => {
    const expectedFix = resolveInstruction(language, 'fix-finding-contract');
    const expectedReplan = resolveInstruction(language, 'replan-implementation-finding-contract');
    for (const workflowName of FC_HIGH_WORKFLOWS) {
      const raw = resolveStepFragments(language, workflowName);
      const loaded = loadBuiltinWorkflow(language, workflowName);
      expect(getLoadedStep(loaded, 'fix').instruction).toBe(expectedFix);
      expect(getLoadedStep(loaded, 'fix').instruction).not.toBe(resolveInstruction(language, 'fix'));
      expect(getLoadedStep(loaded, 'replan').instruction).toBe(expectedReplan);
      expectSpecializedMonitorContent(
        language,
        workflowName,
        raw,
        loaded,
      );
    }
  });

  it.each(LANGUAGES)('%s loaded team-high workflow contains specialized team, replan, and monitor bodies', (language) => {
    const raw = resolveStepFragments(language, 'takt-default-team-high');
    const loaded = loadBuiltinWorkflow(language, 'takt-default-team-high');
    const teamFix = getLoadedStep(loaded, 'fix').instruction;
    expect(teamFix).toBe(resolveInstruction(language, 'team-leader-finding-contract-fix'));
    const partIdentifierContract = language === 'ja'
      ? '各 part instruction に finding ID を明記してください'
      : 'State the finding ID in every part instruction';
    const partFileContract = language === 'ja'
      ? '各 part instruction に担当ファイル、参照専用ファイル、直接修正内容、完了基準を明記してください'
      : 'State the responsible files, reference-only files, direct remediation, and completion criteria in every part instruction';
    expect(teamFix.split(partIdentifierContract), partIdentifierContract).toHaveLength(2);
    expect(teamFix.split(partFileContract), partFileContract).toHaveLength(2);
    expect(getLoadedStep(loaded, 'replan').instruction)
      .toBe(resolveInstruction(language, 'replan-implementation-finding-contract'));
    expectSpecializedMonitorContent(
      language,
      'takt-default-team-high',
      raw,
      loaded,
    );
  });

  it.each(LANGUAGES)('%s loaded local-LLM FC chain reaches specialized remediation and gate bodies', (language) => {
    const topLevel = resolveStepFragments(language, 'takt-default-localllm');
    expect(getRawStep(topLevel, 'develop').call).toBe('development-core');
    expect(getRawStep(topLevel, 'develop').args).toMatchObject({
      peer_review_workflow: 'peer-review-finding-contract-localllm',
    });

    const peerReview = resolveStepFragments(language, 'peer-review-finding-contract-localllm');
    expect(getRawStep(peerReview, 'local-review').call).toBe('finding-contract-local-review');
    expect(getRawStep(peerReview, 'boundary-review').call).toBe('finding-contract-boundary-review');
    expect(getRawStep(peerReview, 'remediation').call).toBe('finding-contract-remediation');

    const gateWorkflowNames = [
      'finding-contract-local-review',
      'finding-contract-boundary-review',
    ] as const;
    for (const workflowName of gateWorkflowNames) {
      const raw = resolveStepFragments(language, workflowName);
      const loaded = loadBuiltinWorkflow(language, workflowName);
      expectSpecializedMonitorContent(
        language,
        workflowName,
        raw,
        loaded,
      );
    }

    const remediation = loadBuiltinWorkflow(language, 'finding-contract-remediation');
    expect(getLoadedStep(remediation, 'fix').instruction)
      .toBe(resolveInstruction(language, 'team-leader-finding-contract-fix'));
  });

  it.each(LANGUAGES)('%s classifies every builtin workflow and rejects specialized refs in non-FC workflows', (language) => {
    const workflowNames = readdirSync(builtinPath(language, 'workflows'))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -'.yaml'.length))
      .sort();
    const classified = workflowNames.map((name) => {
      const raw = readWorkflow(language, name);
      const findingContract = raw.finding_contract !== undefined
        || raw.subworkflow?.requires_finding_contract === true;
      return { findingContract, name };
    });
    const findingContractNames = classified
      .filter(({ findingContract }) => findingContract)
      .map(({ name }) => name);
    const standardNames = classified
      .filter(({ findingContract }) => !findingContract)
      .map(({ name }) => name);

    expect(findingContractNames.length).toBeGreaterThan(0);
    expect(standardNames.length).toBeGreaterThan(0);
    for (const name of standardNames) {
      const refs = collectStringValues(resolveStepFragments(language, name));
      for (const specialized of SPECIALIZED_INSTRUCTIONS) {
        expect(refs, `${name}:${specialized}`).not.toContain(specialized);
      }
    }

    const standardRemediation = loadBuiltinWorkflow(language, 'review-remediation');
    expect(getLoadedStep(standardRemediation, 'fix-plan').instruction)
      .toBe(resolveInstruction(language, 'fix-plan'));
  });
});
