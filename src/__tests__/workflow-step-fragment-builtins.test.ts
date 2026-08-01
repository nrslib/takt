import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';

type RawStep = Record<string, unknown>;
type RawWorkflow = {
  initial_step?: unknown;
  steps: RawStep[];
};
type Language = 'en' | 'ja';

const LANGUAGES: Language[] = ['en', 'ja'];
const REVIEWER_WORKFLOWS = ['takt-default-high', 'takt-default-team-high', 'review-fix-takt-default-high'];
const GATHER_WORKFLOWS = ['review-fix-takt-default', 'review-fix-takt-default-high'];
const FIX_WORKFLOWS = ['takt-default-high', 'review-fix-takt-default-high'];
const DEVELOPMENT_CORE_WORKFLOWS = [
  'default',
  'default-high',
  'takt-default',
  'cli',
  'review-fix-takt-default',
  'backend',
  'frontend',
  'dual',
  'backend-cqrs',
  'dual-cqrs',
  'backend-maintenance',
  'frontend-maintenance',
];
const MINI_WORKFLOWS = [
  'default-mini',
  'backend-mini',
  'frontend-mini',
  'dual-mini',
  'backend-cqrs-mini',
  'dual-cqrs-mini',
];
const REMEDIATION_WORKFLOWS = [
  'review-fix-default',
  'review-fix-backend',
  'review-fix-frontend',
  'review-fix-dual',
  'review-fix-backend-cqrs',
  'review-fix-dual-cqrs',
];

function readBuiltinWorkflow(lang: Language, name: string): RawWorkflow {
  return parseYaml(readFileSync(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), 'utf-8')) as RawWorkflow;
}

function getStep(raw: RawWorkflow, name: string): RawStep {
  const step = raw.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error('Builtin workflow does not define step "' + name + '"');
  return step;
}

function expectFragmentReference(step: RawStep, name: string): string {
  expect(step.name).toBe(name);
  expect(typeof step.uses).toBe('string');
  expect(step.rules).toBeDefined();
  return step.uses as string;
}

function resolveBuiltinWorkflow(lang: Language, name: string): RawWorkflow {
  const workflowPath = join(getBuiltinWorkflowsDir(lang), name + '.yaml');
  return resolveWorkflowStepFragments(readBuiltinWorkflow(lang, name), {
    candidateDirs: buildStepFragmentLookupDirs({ lang }),
    context: { lang, projectDir: process.cwd() },
    workflowPath,
  }).raw as RawWorkflow;
}

function collectRulesPaths(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const record = value as RawStep;
  const found = Object.hasOwn(record, 'rules') ? [`${path}rules`] : [];
  const parallel = record.parallel;
  if (!Array.isArray(parallel)) return found;
  return parallel.reduce<string[]>(
    (paths, child, index) => [...paths, ...collectRulesPaths(child, `${path}parallel[${index}].`)],
    found,
  );
}

function containsParam(value: unknown, paramName: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsParam(entry, paramName));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as RawStep;
  return record.$param === paramName;
}

function expectLoopMonitorsTrigger(
  monitors: readonly { cycle: string[]; threshold: number }[],
): void {
  expect(monitors.length).toBeGreaterThan(0);
  for (const monitor of monitors) {
    const detector = new CycleDetector([monitor]);
    let result = { triggered: false };
    for (let repetition = 0; repetition < monitor.threshold; repetition += 1) {
      for (const [index, step] of monitor.cycle.entries()) {
        result = detector.recordAndCheck(
          step,
          index === monitor.cycle.length - 1 ? monitor.cycle[0]! : monitor.cycle[index + 1]!,
        );
      }
    }
    expect(result.triggered, monitor.cycle.join(' -> ')).toBe(true);
  }
}

describe('builtin workflow step fragment migration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(LANGUAGES)('looks up %s language fragments from the selected builtin directory', (lang) => {
    const dirs = buildStepFragmentLookupDirs({ lang });
    const languageStepsDir = getBuiltinLanguageStepsDir(lang);

    expect(dirs).toContain(languageStepsDir);
  });

  it.each(LANGUAGES)('moves the %s reviewers steps to one language-specific fragment', (lang) => {
    const refs = REVIEWER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'reviewers'), 'reviewers'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s gather steps to one language-specific fragment', (lang) => {
    const refs = GATHER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'gather'), 'gather'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s fix steps to one language-specific fragment', (lang) => {
    const refs = FIX_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'fix'), 'fix'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s supervise step to its language-specific fragment', (lang) => {
    const raw = readBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate');
    const expanded = resolveBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate');
    const step = getStep(raw, 'supervise');
    const ref = expectFragmentReference(step, 'supervise');

    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${ref}.yaml`))).toBe(true);
    expect(step.with).toEqual({
      supervise_knowledge: { $param: 'supervise_knowledge' },
    });
    const expandedStep = getStep(expanded, 'supervise');
    expect(expandedStep).not.toHaveProperty('uses');
    expect(expandedStep).not.toHaveProperty('with');
    expect(expandedStep.knowledge).toEqual({ $param: 'supervise_knowledge' });
    expect(expandedStep.rules).toEqual(step.rules);
  });

  it.each(LANGUAGES)('moves structurally identical %s remediation calls to one typed fragment', (lang) => {
    const workflows = REMEDIATION_WORKFLOWS.map((workflow) => ({
      expanded: resolveBuiltinWorkflow(lang, workflow),
      raw: readBuiltinWorkflow(lang, workflow),
    }));
    const steps = workflows.map(({ raw }) => getStep(raw, 'remediation'));
    const refs = steps.map((step) => expectFragmentReference(step, 'remediation'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
    for (const [index, { expanded }] of workflows.entries()) {
      const step = steps[index]!;
      expect(step.with).toMatchObject({
        plan_policy: expect.any(Array),
        fix_policy: expect.any(Array),
        verification_policy: expect.any(Array),
        fix_knowledge: expect.any(Array),
      });
      const withValues = step.with as RawStep;
      const expandedStep = getStep(expanded, 'remediation');

      expect(expandedStep).not.toHaveProperty('uses');
      expect(expandedStep).not.toHaveProperty('with');
      expect(expandedStep.kind).toBe('workflow_call');
      expect(expandedStep.args).toEqual(withValues);
      expect(expandedStep.rules).toEqual(step.rules);
    }
  });

  it.each(LANGUAGES)('loads migrated %s builtin workflows through the fragment resolver', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflows = new Set([
      ...REVIEWER_WORKFLOWS,
      ...GATHER_WORKFLOWS,
      ...FIX_WORKFLOWS,
      ...DEVELOPMENT_CORE_WORKFLOWS,
      ...MINI_WORKFLOWS,
      ...REMEDIATION_WORKFLOWS,
      'peer-review-suite-base',
      'peer-review-suite-frontend',
      'peer-review-suite-cqrs',
      'peer-review-suite-frontend-cqrs',
      'merge-readiness-finding-contract-final-gate',
    ]);
    for (const name of workflows) {
      expect(() => loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), projectDir)).not.toThrow();
    }
  });

  it.each(LANGUAGES)('composes every %s development family through its shared core', (lang) => {
    for (const workflowName of DEVELOPMENT_CORE_WORKFLOWS) {
      const develop = getStep(readBuiltinWorkflow(lang, workflowName), 'develop');
      expect(develop.kind, workflowName).toBe('workflow_call');
      expect(develop.call, workflowName).toBe('development-core');
      expect(develop.args, workflowName).toEqual(expect.any(Object));
    }

    for (const workflowName of MINI_WORKFLOWS) {
      const develop = getStep(readBuiltinWorkflow(lang, workflowName), 'develop');
      expect(develop.kind, workflowName).toBe('workflow_call');
      expect(develop.call, workflowName).toBe('mini-core');
      expect(develop.args, workflowName).toEqual(expect.any(Object));
    }
  });

  it.each(LANGUAGES)('composes %s domain reviewer suites without dropping specialist or maintenance facets', (lang) => {
    const expectedSuites: Record<string, string | undefined> = {
      backend: undefined,
      frontend: 'peer-review-suite-frontend',
      dual: 'peer-review-suite-frontend',
      'backend-cqrs': 'peer-review-suite-cqrs',
      'dual-cqrs': 'peer-review-suite-frontend-cqrs',
      'backend-maintenance': undefined,
      'frontend-maintenance': 'peer-review-suite-frontend',
    };

    for (const [workflowName, expectedSuite] of Object.entries(expectedSuites)) {
      const develop = getStep(readBuiltinWorkflow(lang, workflowName), 'develop');
      const args = develop.args as RawStep;
      expect(args.reviewer_suite, workflowName).toBe(expectedSuite);
      expect(args.review_knowledge, workflowName).toEqual(expect.any(Array));
      expect((args.review_knowledge as unknown[]).length, workflowName).toBeGreaterThan(0);
    }

    for (const workflowName of ['backend-maintenance', 'frontend-maintenance']) {
      const develop = getStep(readBuiltinWorkflow(lang, workflowName), 'develop');
      const args = develop.args as RawStep;
      expect(args.review_policy_additions, workflowName).toContain('existing-system-respect');
      expect(args.review_knowledge, workflowName).toContain('existing-system');
    }
  });

  it.each(LANGUAGES)('propagates %s domain review context to every composed reviewer and final gate', (lang) => {
    const fragmentNames = [
      'peer-review-reviewers',
      'peer-review-frontend-reviewer',
      'peer-review-cqrs-reviewer',
    ];

    for (const fragmentName of fragmentNames) {
      const fragment = parseYaml(readFileSync(
        join(getBuiltinLanguageStepsDir(lang), fragmentName + '.yaml'),
        'utf-8',
      )) as RawStep;
      const reviewers = Array.isArray(fragment.parallel) ? fragment.parallel as RawStep[] : [fragment];
      for (const reviewer of reviewers) {
        expect(containsParam(reviewer.policy, 'review_policy_additions'), `${fragmentName}:${String(reviewer.name)}`).toBe(true);
        expect(containsParam(reviewer.knowledge, 'review_knowledge_additions'), `${fragmentName}:${String(reviewer.name)}`).toBe(true);
      }
    }

    const peerReview = readBuiltinWorkflow(lang, 'peer-review');
    const finalGate = getStep(peerReview, 'final-gate');
    expect(finalGate.with).toMatchObject({
      merge_readiness_policy: { $param: 'verification_policy' },
      review_knowledge: { $param: 'review_knowledge_additions' },
    });

    const adjudication = getStep(peerReview, 'review-adjudication');
    const fixPlan = getStep(peerReview, 'fix-plan');
    const finalGateFragment = parseYaml(readFileSync(
      join(getBuiltinLanguageStepsDir(lang), 'peer-review-final-gate.yaml'),
      'utf-8',
    )) as RawStep;
    const adjudicationFragment = parseYaml(readFileSync(
      join(getBuiltinLanguageStepsDir(lang), 'peer-review-adjudication.yaml'),
      'utf-8',
    )) as RawStep;

    expect(adjudication.rules).toEqual(expect.any(Array));
    expect(fixPlan.with).toMatchObject({
      plan_instruction: 'fix-plan-from-review-resolution',
    });
    expect(adjudicationFragment.output_contracts).toEqual({
      report: [{ name: 'review-resolution.md', format: 'review-decision' }],
    });
    expect(finalGateFragment).toMatchObject({
      persona: 'merge-readiness-supervisor',
      output_contracts: {
        report: [{ name: 'review-resolution.md', format: 'merge-readiness-supervision' }],
      },
    });
  });

  it.each(LANGUAGES)('detects every %s peer-review remediation cycle at its configured threshold', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(lang), 'peer-review.yaml'),
      projectDir,
    );
    expectLoopMonitorsTrigger(workflow.loopMonitors ?? []);
  });

  it.each(LANGUAGES)('detects every %s shared remediation cycle at its configured threshold', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(lang), 'review-remediation.yaml'),
      projectDir,
    );
    expectLoopMonitorsTrigger(workflow.loopMonitors ?? []);
  });

  it.each(LANGUAGES)('keeps %s migrated reviewers on the read-only provider preset', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(lang), 'takt-default-high.yaml'),
      projectDir,
    );
    const reviewers = workflow.steps.find((step) => step.name === 'reviewers');

    expect(reviewers?.parallel).toHaveLength(6);
    for (const reviewer of reviewers?.parallel ?? []) {
      expect(reviewer.providerOptions).toMatchObject({
        claude: { allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] },
        opencode: { allowedTools: ['read', 'glob', 'grep', 'bash', 'websearch', 'webfetch'] },
      });
    }
  });

  it('keeps every shipped fragment free of rules, including parallel descendants', () => {
    const stepDirs = [
      ...LANGUAGES.map((lang) => getBuiltinLanguageStepsDir(lang)),
    ];
    for (const directory of stepDirs) {
      for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml'))) {
        const fragment = parseYaml(readFileSync(join(directory, file), 'utf-8')) as unknown;
        expect(collectRulesPaths(fragment), `${directory}/${file}`).toEqual([]);
      }
    }
  });

});
