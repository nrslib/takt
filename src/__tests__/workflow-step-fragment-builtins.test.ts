import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';

type RawStep = Record<string, unknown>;
type RawWorkflow = { steps: RawStep[] };
type Language = 'en' | 'ja';

const LANGUAGES: Language[] = ['en', 'ja'];
const HIGH_WORKFLOWS = ['takt-default-high', 'takt-default-team-high', 'review-fix-takt-default-high'];
const REVIEWER_WORKFLOWS = [...HIGH_WORKFLOWS, 'takt-default-localllm'];
const REPLAN_WORKFLOWS = REVIEWER_WORKFLOWS;
const GATHER_WORKFLOWS = ['review-fix-takt-default', 'review-fix-takt-default-high'];
const FIX_WORKFLOWS = ['takt-default-high', 'review-fix-takt-default-high'];
const MINI_FIX_BOTH_WORKFLOWS = [
  'backend-mini',
  'frontend-mini',
  'dual-mini',
  'backend-cqrs-mini',
  'dual-cqrs-mini',
];
const PARAMETERIZED_FIX_WORKFLOWS = [
  'backend',
  'frontend',
  'dual-cqrs',
  'backend-cqrs',
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

  it.each(LANGUAGES)('looks up %s language fragments before the shared builtin directory', (lang) => {
    const dirs = buildStepFragmentLookupDirs({ lang });
    const languageStepsDir = getBuiltinLanguageStepsDir(lang);

    expect(dirs).toContain(languageStepsDir);
    expect(dirs.indexOf(languageStepsDir)).toBeLessThan(dirs.indexOf(getBuiltinStepsDir()));
  });

  it.each(LANGUAGES)('moves the %s reviewers steps to one language-specific fragment', (lang) => {
    const refs = REVIEWER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'reviewers'), 'reviewers'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s LocalLLM boundary reviewers to a rule-free language fragment', (lang) => {
    const step = getStep(readBuiltinWorkflow(lang, 'takt-default-localllm'), 'boundary-reviewers');
    const ref = expectFragmentReference(step, 'boundary-reviewers');

    expect(ref).toBe('boundary-reviewers');
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${ref}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('keeps %s replan routing in four concrete callers', (lang) => {
    for (const workflowName of REPLAN_WORKFLOWS) {
      const step = getStep(readBuiltinWorkflow(lang, workflowName), 'replan');
      expect(step.uses).toBe('implementation-high-replan-to-implement');
      expect((step.rules as RawStep[]).map((rule) => rule.next)).toEqual([
        'implement',
        'reviewers',
        'ABORT',
      ]);
    }
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), 'replan.yaml'))).toBe(false);
  });

  it.each(LANGUAGES)('covers every direct %s high replan-review cycle with a finite-stop monitor', (lang) => {
    for (const workflowName of HIGH_WORKFLOWS) {
      const workflow = readBuiltinWorkflow(lang, workflowName) as RawWorkflow & {
        loop_monitors?: Array<{ cycle: string[]; threshold: number; judge: unknown }>;
      };
      const monitors = workflow.loop_monitors ?? [];
      for (const cycle of [
        ['replan', 'reviewers'],
        ['replan', 'reviewers', 'final-gate'],
        ['replan', 'reviewers', 'fix'],
      ]) {
        const sourceCycle = [cycle[0]!, 'implement', ...cycle.slice(1)];
        const source = monitors.find((monitor) => monitor.cycle.join('\0') === sourceCycle.join('\0'));
        const companion = monitors.find((monitor) => monitor.cycle.join('\0') === cycle.join('\0'));

        expect(source).toBeDefined();
        expect(companion).toMatchObject({
          threshold: source?.threshold,
          judge: source?.judge,
        });
      }
    }
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

  it('moves both supervise steps to the same shared fragment', () => {
    const workflows = LANGUAGES.map((lang) => ({
      expanded: resolveBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate'),
      raw: readBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate'),
    }));
    const steps = workflows.map(({ raw }) => getStep(raw, 'supervise'));
    const refs = steps.map((step) => expectFragmentReference(step, 'supervise'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinStepsDir(), `${refs[0]}.yaml`))).toBe(true);
    for (const [index, { expanded }] of workflows.entries()) {
      const step = steps[index]!;
      expect(step.with).toEqual({
        supervise_knowledge: { $param: 'supervise_knowledge' },
      });
      const expandedStep = getStep(expanded, 'supervise');
      expect(expandedStep).not.toHaveProperty('uses');
      expect(expandedStep).not.toHaveProperty('with');
      expect(expandedStep.knowledge).toEqual({ $param: 'supervise_knowledge' });
      expect(expandedStep.rules).toEqual(step.rules);
    }
  });

  it.each(LANGUAGES)('moves all %s mini fix_both variants to one typed shared fragment', (lang) => {
    const workflows = MINI_FIX_BOTH_WORKFLOWS.map((workflow) => ({
      expanded: resolveBuiltinWorkflow(lang, workflow),
      raw: readBuiltinWorkflow(lang, workflow),
    }));
    const steps = workflows.map(({ raw }) => getStep(raw, 'fix_both'));
    const refs = steps.map((step) => expectFragmentReference(step, 'fix_both'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinStepsDir(), `${refs[0]}.yaml`))).toBe(true);
    for (const [index, { expanded }] of workflows.entries()) {
      const step = steps[index]!;
      expect(step.with).toMatchObject({
        fix_policy: expect.any(Array),
        fix_knowledge: expect.any(Array),
      });
      expect(step.rules).toMatchObject({
        self: expect.any(Array),
        parallel: {
          'ai-antipattern-fix-parallel': expect.any(Array),
          supervise_fix_parallel: expect.any(Array),
        },
      });
      const withValues = step.with as RawStep;
      const rules = step.rules as { self: unknown; parallel: Record<string, unknown> };
      const expandedStep = getStep(expanded, 'fix_both');
      const children = expandedStep.parallel as RawStep[];

      expect(expandedStep).not.toHaveProperty('uses');
      expect(expandedStep).not.toHaveProperty('with');
      expect(expandedStep.rules).toEqual(rules.self);
      expect(children.map((child) => child.name).sort()).toEqual(Object.keys(rules.parallel).sort());
      for (const child of children) {
        expect(child.policy).toEqual(withValues.fix_policy);
        expect(child.knowledge).toEqual(withValues.fix_knowledge);
        expect(child.rules).toEqual(rules.parallel[child.name as string]);
      }
    }
  });

  it.each(LANGUAGES)('moves structurally identical %s fix variants to one typed shared fragment', (lang) => {
    const workflows = PARAMETERIZED_FIX_WORKFLOWS.map((workflow) => ({
      expanded: resolveBuiltinWorkflow(lang, workflow),
      raw: readBuiltinWorkflow(lang, workflow),
    }));
    const steps = workflows.map(({ raw }) => getStep(raw, 'fix'));
    const refs = steps.map((step) => expectFragmentReference(step, 'fix'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinStepsDir(), `${refs[0]}.yaml`))).toBe(true);
    for (const [index, { expanded }] of workflows.entries()) {
      const step = steps[index]!;
      expect(step.with).toMatchObject({
        fix_policy: expect.any(Array),
        fix_knowledge: expect.any(Array),
      });
      const withValues = step.with as RawStep;
      const expandedStep = getStep(expanded, 'fix');

      expect(expandedStep).not.toHaveProperty('uses');
      expect(expandedStep).not.toHaveProperty('with');
      expect(expandedStep.policy).toEqual(withValues.fix_policy);
      expect(expandedStep.knowledge).toEqual(withValues.fix_knowledge);
      expect(expandedStep.rules).toEqual(step.rules);
    }
  });

  it.each(LANGUAGES)('loads migrated %s builtin workflows through the fragment resolver', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflows = new Set([
      ...REVIEWER_WORKFLOWS,
      ...REPLAN_WORKFLOWS,
      ...GATHER_WORKFLOWS,
      ...FIX_WORKFLOWS,
      ...MINI_FIX_BOTH_WORKFLOWS,
      ...PARAMETERIZED_FIX_WORKFLOWS,
      'merge-readiness-finding-contract-final-gate',
    ]);
    for (const name of workflows) {
      expect(() => loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), projectDir)).not.toThrow();
    }
  });

  it.each(LANGUAGES)('keeps %s migrated reviewers on the read-only provider preset', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    for (const workflowName of ['takt-default-high', 'takt-default-localllm']) {
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(lang), `${workflowName}.yaml`),
        projectDir,
      );
      const stepNames = workflowName === 'takt-default-localllm'
        ? ['reviewers', 'boundary-reviewers']
        : ['reviewers'];
      for (const stepName of stepNames) {
        const reviewers = workflow.steps.find((step) => step.name === stepName);
        expect(reviewers?.parallel?.length).toBeGreaterThan(0);
        for (const reviewer of reviewers?.parallel ?? []) {
          expect(reviewer.providerOptions).toMatchObject({
            claude: { allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] },
            opencode: { allowedTools: ['read', 'glob', 'grep', 'bash', 'websearch', 'webfetch'] },
          });
        }
      }
    }
  });

  it.each(LANGUAGES)('preserves terminal adjudication on every %s Finding final gate', (lang) => {
    for (const workflowName of REPLAN_WORKFLOWS) {
      const expanded = resolveBuiltinWorkflow(lang, workflowName);
      const gateNames = workflowName === 'takt-default-localllm'
        ? ['local-review-integrity-gate', 'final-gate']
        : ['final-gate'];
      for (const gateName of gateNames) {
        expect(getStep(expanded, gateName)).toMatchObject({
          kind: 'workflow_call',
          call: 'merge-readiness-finding-contract-final-gate',
          finding_contract_authority: 'terminal_adjudication',
        });
      }
    }
  });

  it('keeps English and Japanese Finding workflows structurally aligned', () => {
    const structure = (lang: Language, name: string) => {
      const workflow = readBuiltinWorkflow(lang, name) as RawWorkflow & {
        loop_monitors?: Array<{ cycle: string[]; threshold: number }>;
      };
      return {
        steps: workflow.steps.map((step) => ({
          name: step.name,
          uses: step.uses,
          selfTargets: Array.isArray(step.rules)
            ? (step.rules as RawStep[]).map((rule) => rule.next ?? rule.return)
            : ((step.rules as { self?: RawStep[] } | undefined)?.self ?? [])
                .map((rule) => rule.next ?? rule.return),
          parallelNames: Object.keys(
            (step.rules as { parallel?: Record<string, unknown> } | undefined)?.parallel ?? {},
          ),
        })),
        monitors: (workflow.loop_monitors ?? []).map((monitor) => ({
          cycle: monitor.cycle,
          threshold: monitor.threshold,
        })),
      };
    };

    for (const workflowName of REPLAN_WORKFLOWS) {
      expect(structure('ja', workflowName)).toEqual(structure('en', workflowName));
    }
  });

  it('keeps every shipped fragment free of rules, including parallel descendants', () => {
    const stepDirs = [
      getBuiltinStepsDir(),
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
