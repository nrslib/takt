import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import {
  cleanupTestFindingStorage,
  createTestFindingLedgerStore,
} from './helpers/finding-storage.js';

type RawStep = Record<string, unknown>;
type RawWorkflow = {
  steps: RawStep[];
  finding_contract?: unknown;
  subworkflow?: {
    requires_finding_contract?: unknown;
    params?: Record<string, { default?: unknown }>;
  };
};
type Language = 'en' | 'ja';

const LANGUAGES: Language[] = ['en', 'ja'];
const HIGH_WORKFLOWS = ['takt-default-high', 'takt-default-team-high', 'review-fix-takt-default-high'];
const REVIEWER_WORKFLOWS = [...HIGH_WORKFLOWS, 'finding-contract-local-review'];
const REPLAN_WORKFLOWS = HIGH_WORKFLOWS;
const LOCALLLM_COMPOSED_WORKFLOWS = [
  'takt-default-localllm',
  'finding-contract-local-review',
  'finding-contract-boundary-review',
  'finding-contract-remediation',
  'peer-review-finding-contract-localllm',
];
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
const LIGHTWEIGHT_CORE_WORKFLOWS = ['simple-core', 'mini-core', 'simple-mini'];
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

function listFindingContractWorkflows(lang: Language): string[] {
  return readdirSync(getBuiltinWorkflowsDir(lang))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .filter((name) => {
      const workflow = readBuiltinWorkflow(lang, name);
      return workflow.finding_contract !== undefined
        || workflow.subworkflow?.requires_finding_contract === true;
    })
    .sort();
}

function resolveParamValue(value: unknown, params: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveParamValue(entry, params));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$param === 'string') {
    if (!Object.hasOwn(params, record.$param)) {
      throw new Error(`Unresolved callable workflow parameter "${record.$param}"`);
    }
    return resolveParamValue(params[record.$param], params);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolveParamValue(entry, params)]),
  );
}

function workflowParamDefaults(workflow: RawWorkflow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(workflow.subworkflow?.params ?? {})
      .filter(([, definition]) => Object.hasOwn(definition, 'default'))
      .map(([name, definition]) => [name, definition.default]),
  );
}

function findWorkflowCallSteps(value: unknown): RawStep[] {
  if (Array.isArray(value)) {
    return value.flatMap(findWorkflowCallSteps);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const record = value as RawStep;
  const workflowCall = record.workflow_call;
  const isLegacyCall = typeof workflowCall === 'object'
    && workflowCall !== null
    && Object.hasOwn(workflowCall, 'workflow');
  return [
    ...(record.kind === 'workflow_call' || isLegacyCall ? [record] : []),
    ...Object.values(record).flatMap(findWorkflowCallSteps),
  ];
}

function workflowCallTarget(step: RawStep): string {
  const target = step.kind === 'workflow_call'
    ? step.call
    : (step.workflow_call as RawStep | undefined)?.workflow;
  if (typeof target !== 'string') {
    throw new Error(`workflow_call step "${String(step.name)}" has an unresolved target`);
  }
  return target;
}

function collectWorkflowCallTargets(lang: Language, rootWorkflowName: string): string[] {
  const targets: string[] = [];
  const activeWorkflows = new Set<string>();

  const visit = (workflowName: string, callArgs: Readonly<Record<string, unknown>>): void => {
    if (activeWorkflows.has(workflowName)) {
      throw new Error(`Recursive builtin workflow_call detected while inspecting "${workflowName}"`);
    }
    activeWorkflows.add(workflowName);
    const workflow = resolveBuiltinWorkflow(lang, workflowName);
    const params = {
      ...workflowParamDefaults(workflow),
      ...callArgs,
    };
    const resolvedWorkflow = resolveParamValue(workflow, params);
    for (const step of findWorkflowCallSteps(resolvedWorkflow)) {
      const target = workflowCallTarget(step);
      targets.push(target);
      const targetPath = join(getBuiltinWorkflowsDir(lang), `${target}.yaml`);
      if (existsSync(targetPath)) {
        const args = typeof step.args === 'object' && step.args !== null
          ? step.args as Record<string, unknown>
          : {};
        visit(target, args);
      }
    }
    activeWorkflows.delete(workflowName);
  };

  const root = resolveBuiltinWorkflow(lang, rootWorkflowName);
  visit(rootWorkflowName, workflowParamDefaults(root));
  return targets;
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
    cleanupTestFindingStorage();
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

  it.each(LANGUAGES)('moves the %s LocalLLM boundary reviewers to a rule-free language fragment', (lang) => {
    const step = getStep(readBuiltinWorkflow(lang, 'finding-contract-boundary-review'), 'boundary-reviewers');
    const ref = expectFragmentReference(step, 'boundary-reviewers');

    expect(ref).toBe('boundary-reviewers');
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${ref}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('keeps %s replan routing in three concrete high-cost callers', (lang) => {
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

  it.each(LANGUAGES)('keeps the expanded %s supervise step valid for Finding Contract intake', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();
    const workflow = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(lang), 'merge-readiness-finding-contract-final-gate.yaml'),
      projectDir,
    );
    const supervise = workflow.steps.find((candidate) => candidate.name === 'supervise');
    const runId = `merge-readiness-supervise-${lang}`;

    expect(supervise?.outputContracts).toEqual([
      expect.objectContaining({
        name: 'supervisor-validation.md',
        formatRef: 'supervisor-validation-finding-contract',
      }),
    ]);
    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: projectDir,
      inheritedFindingContract: {
        contract: {
          manager: {
            persona: 'findings-manager',
            instruction: 'findings-manager',
            outputContract: 'findings-manager',
          },
        },
        ledgerStore: createTestFindingLedgerStore({
          projectCwd: projectDir,
          runId,
          reportDir: join(projectDir, '.takt', 'runs', runId, 'reports'),
          workflowName: workflow.name,
        }),
        managerAuthority: 'standard',
      },
    })).not.toThrow();
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
      ...REPLAN_WORKFLOWS,
      ...GATHER_WORKFLOWS,
      ...FIX_WORKFLOWS,
      ...DEVELOPMENT_CORE_WORKFLOWS,
      ...MINI_WORKFLOWS,
      ...LIGHTWEIGHT_CORE_WORKFLOWS,
      ...REMEDIATION_WORKFLOWS,
      ...LOCALLLM_COMPOSED_WORKFLOWS,
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

  it.each(LANGUAGES)('loads %s lightweight development routines with resolved runtime report contracts', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    for (const workflowName of LIGHTWEIGHT_CORE_WORKFLOWS) {
      const workflowPath = join(getBuiltinWorkflowsDir(lang), workflowName + '.yaml');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const plan = workflow.steps.find((step) => step.name === 'plan');
      const implement = workflow.steps.find((step) => step.name === 'implement');
      const planContract = plan?.outputContracts?.find((contract) => contract.name === 'plan.md');

      expect(planContract, workflowName).toMatchObject({
        formatRef: 'plan',
        format: expect.any(String),
      });
      expect(planContract?.format?.trim().length, workflowName).toBeGreaterThan(0);
      expect(
        implement?.outputContracts?.some((contract) => contract.name === 'implementation-report.md'),
        workflowName,
      ).toBe(true);
    }
  });

  it.each(LANGUAGES)('resolves a non-default %s plan report format through callable step composition', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), 'mini-core.yaml'), projectDir, {
      callableArgs: { plan_report_format: 'plan-frontend' },
    });
    const planContract = workflow.steps
      .find((step) => step.name === 'plan')
      ?.outputContracts?.find((contract) => contract.name === 'plan.md');

    expect(planContract).toMatchObject({
      formatRef: 'plan-frontend',
      format: expect.any(String),
    });
    expect(planContract?.format?.trim().length).toBeGreaterThan(0);
  });

  it.each(LANGUAGES)('rejects an unknown %s callable plan report format', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    expect(() => loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), 'mini-core.yaml'), projectDir, {
      callableArgs: { plan_report_format: 'unknown-plan-format' },
    })).toThrow();
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
      merge_readiness_knowledge: { $param: 'review_knowledge_additions' },
      supervise_knowledge: { $param: 'review_knowledge_additions' },
      supervisor_persona: { $param: 'supervisor_persona' },
    });
  });

  it.each(LANGUAGES)('keeps %s ordinary peer review adjudication authoritative before remediation', (lang) => {
    const peerReview = readBuiltinWorkflow(lang, 'peer-review');
    const initialReviewers = getStep(peerReview, 'initial-reviewers');
    const reviewers = getStep(peerReview, 'reviewers');
    const adjudication = getStep(peerReview, 'review-adjudication');
    const fixPlan = getStep(peerReview, 'fix-plan');
    const adjudicationFragment = parseYaml(readFileSync(
      join(getBuiltinLanguageStepsDir(lang), 'peer-review-adjudication.yaml'),
      'utf-8',
    )) as RawStep;

    expect(initialReviewers.rules).toEqual([
      { condition: 'COMPLETE', next: 'review-adjudication' },
      { condition: 'needs_fix', next: 'review-adjudication' },
    ]);
    expect(reviewers.rules).toEqual(initialReviewers.rules);
    expect(adjudication.uses).toBe('peer-review-adjudication');
    expect(fixPlan.with).toMatchObject({
      plan_instruction: 'fix-plan-from-review-resolution',
    });
    expect(adjudicationFragment.output_contracts).toEqual({
      report: [{ name: 'review-resolution.md', format: 'review-decision' }],
    });
  });

  it.each(LANGUAGES)('does not mix ordinary %s adjudication into Finding Contract workflows', (lang) => {
    const findingContractWorkflows = listFindingContractWorkflows(lang);
    expect(findingContractWorkflows).toHaveLength(9);
    expect(findingContractWorkflows).toContain('merge-readiness-finding-contract-final-gate');

    for (const workflowName of findingContractWorkflows) {
      const workflow = readBuiltinWorkflow(lang, workflowName);
      const serialized = JSON.stringify(workflow);
      expect(serialized, workflowName).not.toContain('peer-review-adjudication');
      expect(serialized, workflowName).not.toContain('fix-plan-from-review-resolution');
      expect(serialized, workflowName).not.toContain('review-resolution.md');
      for (const target of collectWorkflowCallTargets(lang, workflowName)) {
        const ordinaryPeerReview = target.startsWith('peer-review')
          && target !== 'peer-review-finding-contract-localllm';
        expect(ordinaryPeerReview, `${workflowName} workflow_call target: ${target}`).toBe(false);
      }
    }
  });

  it.each(LANGUAGES)('keeps %s Finding development routes isolated from the ordinary development-core default', (lang) => {
    const developmentCore = readBuiltinWorkflow(lang, 'development-core');
    const defaultPeerReview = developmentCore.subworkflow?.params?.peer_review_workflow?.default;
    const localLlmDevelop = getStep(readBuiltinWorkflow(lang, 'takt-default-localllm'), 'develop');

    expect(defaultPeerReview).toBe('peer-review');
    expect((localLlmDevelop.args as RawStep).peer_review_workflow).toBe(
      'peer-review-finding-contract-localllm',
    );
    expect(collectWorkflowCallTargets(lang, 'takt-default-localllm')).toContain(
      'peer-review-finding-contract-localllm',
    );
    for (const workflowName of HIGH_WORKFLOWS) {
      const targets = collectWorkflowCallTargets(lang, workflowName);
      expect(targets, workflowName).toContain('merge-readiness-finding-contract-final-gate');
      expect(targets, workflowName).not.toContain('peer-review');
    }
  });

  it.each(LANGUAGES)('keeps %s migrated reviewers on the read-only provider preset', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const reviewSteps = [
      { workflowName: 'takt-default-high', stepName: 'reviewers' },
      { workflowName: 'finding-contract-local-review', stepName: 'reviewers' },
      { workflowName: 'finding-contract-boundary-review', stepName: 'boundary-reviewers' },
    ];
    for (const { workflowName, stepName } of reviewSteps) {
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(lang), `${workflowName}.yaml`),
        projectDir,
      );
      const reviewers = workflow.steps.find((step) => step.name === stepName);
      expect(reviewers?.parallel?.length).toBeGreaterThan(0);
      for (const reviewer of reviewers?.parallel ?? []) {
        expect(reviewer.providerOptions).toMatchObject({
          claude: { allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] },
          opencode: { allowedTools: ['read', 'glob', 'grep', 'bash', 'websearch', 'webfetch'] },
        });
      }
    }
  });

  it.each(LANGUAGES)('preserves terminal adjudication on every %s Finding final gate', (lang) => {
    for (const workflowName of HIGH_WORKFLOWS) {
      const expanded = resolveBuiltinWorkflow(lang, workflowName);
      expect(getStep(expanded, 'final-gate')).toMatchObject({
        kind: 'workflow_call',
        call: 'merge-readiness-finding-contract-final-gate',
        finding_contract_authority: 'terminal_adjudication',
      });
    }
    for (const [workflowName, gateName] of [
      ['finding-contract-local-review', 'integrity-gate'],
      ['finding-contract-boundary-review', 'final-gate'],
    ]) {
      expect(getStep(resolveBuiltinWorkflow(lang, workflowName!), gateName!)).toMatchObject({
        kind: 'workflow_call',
        call: 'merge-readiness-finding-contract-final-gate',
        finding_contract_authority: 'terminal_adjudication',
      });
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

    for (const workflowName of [...REPLAN_WORKFLOWS, ...LOCALLLM_COMPOSED_WORKFLOWS]) {
      expect(structure('ja', workflowName)).toEqual(structure('en', workflowName));
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
