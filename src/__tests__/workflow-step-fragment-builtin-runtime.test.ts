import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return { ...actual, RuleEvaluator: MockRuleEvaluator };
});

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from './helpers/workflow-engine.js';
import { resolveWorkflowCallTarget } from '../infra/config/index.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';

interface BuiltinFragmentCase {
  fragment: 'fix' | 'gather';
  language: 'en' | 'ja';
  label: string;
  nextStep: string;
  persona: string;
  ruleIndex: number;
  ruleNextStep?: string;
}

interface FinalGateReturnCase {
  returnValue: 'COMPLETE' | 'needs_review' | 'need_replan' | 'needs_fix' | 'needs_conflict_adjudication' | 'ABORT';
  superviseRuleIndex: number;
  nextStep?: string;
}

interface RawRule {
  condition?: string;
  next?: string;
  return?: string;
}

function readRuleSpec(path: string, stepName?: string): unknown {
  const raw = parseYaml(readFileSync(path, 'utf-8')) as {
    rules?: unknown;
    steps?: Array<{ name?: string; rules?: unknown }>;
  };
  const rules = stepName === undefined
    ? raw.rules
    : raw.steps?.find((step) => step.name === stepName)?.rules;
  if (rules === undefined) {
    throw new Error(`Expected rules in builtin asset: ${path}`);
  }
  return rules;
}

function readRules(path: string, stepName?: string): RawRule[] {
  const rules = readRuleSpec(path, stepName);
  if (!Array.isArray(rules)) {
    throw new Error(`Expected rule array in builtin asset: ${path}`);
  }
  return rules as RawRule[];
}

function yamlFieldLines(field: string, value: unknown, indentation: number): string[] {
  const prefix = ' '.repeat(indentation);
  return stringifyYaml({ [field]: value }, { lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line) => prefix + line);
}

function findRuleIndex(rules: readonly RawRule[], field: 'next' | 'return', value: string): number {
  const index = rules.findIndex((rule) => rule[field] === value);
  if (index < 0) {
    throw new Error(`Expected builtin rule ${field}: ${value}`);
  }
  return index;
}

function schemaHasProperty(schema: unknown, property: string): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return false;
  }
  const properties = Reflect.get(schema, 'properties');
  return typeof properties === 'object'
    && properties !== null
    && !Array.isArray(properties)
    && property in properties;
}

function mockFindingContractAgents(
  contentByPersona: Readonly<Record<string, string>> = {},
): void {
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({
      systemPrompt: 'test system prompt',
      userInstruction: instruction,
    });
    const content = contentByPersona[persona ?? ''] ?? 'approved';
    if (schemaHasProperty(options?.outputSchema, 'rawFindings')) {
      return makeResponse({
        persona,
        content,
        structuredOutput: {
          ...(schemaHasProperty(options?.outputSchema, 'reportContent')
            ? { reportContent: content }
            : {}),
          rawFindings: [],
        },
      });
    }
    if (schemaHasProperty(options?.outputSchema, 'rawDecisions')) {
      return makeResponse({
        persona,
        content: 'manager complete',
        structuredOutput: {
          rawDecisions: [],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      });
    }
    return makeResponse({ persona, content });
  });
}

function fragmentRuleIndex(language: 'en' | 'ja', fragment: 'fix' | 'gather', nextStep: string): number {
  const workflow = fragment === 'fix'
    ? 'takt-default-high.yaml'
    : 'review-fix-takt-default-high.yaml';
  return findRuleIndex(
    readRules(join(getBuiltinWorkflowsDir(language), workflow), fragment),
    'next',
    nextStep,
  );
}

const SUPERVISE_RULES = readRules(
  join(getBuiltinWorkflowsDir('en'), 'merge-readiness-finding-contract-final-gate.yaml'),
  'supervise',
);
const FINAL_GATE_CALLER_RULES = readRuleSpec(
  join(getBuiltinWorkflowsDir('en'), 'takt-default-high.yaml'),
  'final-gate',
);
const REVIEWERS_CALLER_RULES = {
  en: readRuleSpec(join(getBuiltinWorkflowsDir('en'), 'takt-default-high.yaml'), 'reviewers'),
  ja: readRuleSpec(join(getBuiltinWorkflowsDir('ja'), 'takt-default-high.yaml'), 'reviewers'),
};
const MERGE_READINESS_REVIEW_RULES = readRules(
  join(getBuiltinWorkflowsDir('en'), 'merge-readiness-finding-contract-final-gate.yaml'),
  'merge-readiness-review',
);
const MERGE_READINESS_TO_SUPERVISE_RULE_INDEX = findRuleIndex(
  MERGE_READINESS_REVIEW_RULES,
  'next',
  'supervise',
);

const BUILTIN_FRAGMENT_CASES: BuiltinFragmentCase[] = [
  { fragment: 'fix', language: 'en', label: 'Fixes are complete', nextStep: 'reviewers', persona: 'coder', ruleIndex: fragmentRuleIndex('en', 'fix', 'reviewers') },
  { fragment: 'fix', language: 'en', label: 'Cannot proceed with fixes, or the implementation approach must be redefined', nextStep: 'replan', persona: 'coder', ruleIndex: fragmentRuleIndex('en', 'fix', 'replan') },
  { fragment: 'gather', language: 'en', label: 'Review target information gathered', nextStep: 'plan', persona: 'planner', ruleIndex: fragmentRuleIndex('en', 'gather', 'plan') },
  { fragment: 'fix', language: 'ja', label: '修正完了', nextStep: 'reviewers', persona: 'coder', ruleIndex: fragmentRuleIndex('ja', 'fix', 'reviewers') },
  { fragment: 'fix', language: 'ja', label: '修正を進められない、または実装方針の再定義が必要', nextStep: 'replan', persona: 'coder', ruleIndex: fragmentRuleIndex('ja', 'fix', 'replan') },
  { fragment: 'gather', language: 'ja', label: 'レビュー対象の情報収集完了', nextStep: 'plan', persona: 'planner', ruleIndex: fragmentRuleIndex('ja', 'gather', 'plan') },
];

const FINAL_GATE_RETURN_CASES: FinalGateReturnCase[] = [
  { returnValue: 'COMPLETE', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'next', 'COMPLETE') },
  { returnValue: 'needs_review', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'return', 'needs_review'), nextStep: 'reviewers' },
  { returnValue: 'need_replan', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'return', 'need_replan'), nextStep: 'replan' },
  { returnValue: 'needs_fix', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'return', 'needs_fix'), nextStep: 'fix' },
  { returnValue: 'needs_conflict_adjudication', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'return', 'needs_conflict_adjudication') },
  { returnValue: 'ABORT', superviseRuleIndex: findRuleIndex(SUPERVISE_RULES, 'next', 'ABORT') },
];

function writeBuiltinFragmentWorkflow(projectDir: string, fragmentCase: BuiltinFragmentCase): string {
  const workflowPath = join(projectDir, '.takt', 'workflows', `${fragmentCase.fragment}-runtime.yaml`);
  mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${fragmentCase.language}\n`, 'utf-8');
  writeFileSync(workflowPath, [
    `name: ${fragmentCase.fragment}-runtime`,
    'initial_step: entry',
    'max_steps: 2',
    'workflow_config:',
    '  provider: claude',
    'steps:',
    '  - name: entry',
    `    uses: ${fragmentCase.fragment}`,
    ...Array.from({ length: fragmentCase.ruleIndex + 1 }, (_unused, index) => [
      ...(index === 0 ? ['    rules:'] : []),
      `      - condition: result-${index}`,
      `        next: ${index === fragmentCase.ruleIndex ? (fragmentCase.ruleNextStep ?? fragmentCase.nextStep) : 'ABORT'}`,
    ]).flat(),
    `  - name: ${fragmentCase.nextStep}`,
    '    instruction: complete',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    ...(fragmentCase.nextStep === 'replan' ? [] : [
      '  - name: replan',
      '    instruction: replan',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]),
    ...(fragmentCase.nextStep === 'reviewers' ? [] : [
      '  - name: reviewers',
      '    instruction: reviewers',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]),
    ...(fragmentCase.nextStep === 'plan' ? [] : [
      '  - name: plan',
      '    instruction: plan',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]),
    '',
  ].join('\n'), 'utf-8');
  return workflowPath;
}

function writeBuiltinReturnWorkflow(projectDir: string): string {
  const workflowPath = join(projectDir, '.takt', 'workflows', 'builtin-return.yaml');
  mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: en\n', 'utf-8');
  writeFileSync(workflowPath, [
    'name: builtin-return',
    'initial_step: final-gate',
    'max_steps: 4',
    'workflow_config:',
    '  provider: mock',
    'finding_contract:',
    '  manager:',
    '    persona: findings-manager',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'steps:',
    '  - name: final-gate',
    '    uses: finding-contract-final-gate',
    ...yamlFieldLines('rules', FINAL_GATE_CALLER_RULES, 4),
    '  - name: fix',
    '    persona: coder',
    '    instruction: fix',
    '    rules:',
    '      - condition: fixed',
    '        next: COMPLETE',
    '  - name: reviewers',
    '    instruction: reviewers',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: replan',
    '    instruction: replan',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n'), 'utf-8');
  return workflowPath;
}

function writeBuiltinReviewersWorkflow(projectDir: string, language: 'en' | 'ja'): string {
  const workflowPath = join(projectDir, '.takt', 'workflows', `reviewers-${language}.yaml`);
  mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');
  writeFileSync(workflowPath, [
    `name: reviewers-${language}`,
    'initial_step: reviewers',
    'max_steps: 2',
    'workflow_config:',
    '  provider: mock',
    'finding_contract:',
    '  manager:',
    '    persona: findings-manager',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'steps:',
    '  - name: reviewers',
    '    uses: reviewers',
    ...yamlFieldLines('rules', REVIEWERS_CALLER_RULES[language], 4),
    '  - name: final-gate',
    '    instruction: complete',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: replan',
    '    instruction: replan',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: fix',
    '    instruction: fix',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n'), 'utf-8');
  return workflowPath;
}

describe('builtin step fragment runtime contracts', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;
  let engines: WorkflowEngine[];

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-builtin-step-fragment-runtime-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-builtin-step-fragment-runtime-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    engines = [];
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  afterEach(() => {
    for (const engine of engines) cleanupWorkflowEngine(engine);
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    if (existsSync(globalConfigDir)) rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(BUILTIN_FRAGMENT_CASES)(
    'executes the $fragment fragment rule $ruleIndex transition to $nextStep',
    async (fragmentCase) => {
      const workflow = loadWorkflowFromFile(writeBuiltinFragmentWorkflow(projectDir, fragmentCase), projectDir);
      const engine = new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
      engines.push(engine);
      const transitions: string[] = [];
      engine.on('step:complete', (step) => transitions.push(step.name));
      mockRunAgentSequence([
        makeResponse({ persona: fragmentCase.persona, content: fragmentCase.label }),
        makeResponse({ persona: fragmentCase.nextStep, content: 'done' }),
      ]);
      mockRuleEvaluationSequence([
        { index: fragmentCase.ruleIndex, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent).mock.calls[0]?.[0]).toBe(fragmentCase.persona);
      expect(transitions).toEqual(['entry', fragmentCase.nextStep]);
    },
  );

  it('passes the fix fragment permission requirement to its execution', async () => {
    const workflow = loadWorkflowFromFile(
      writeBuiltinFragmentWorkflow(projectDir, BUILTIN_FRAGMENT_CASES[0]!),
      projectDir,
    );
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
    engines.push(engine);
    mockRunAgentSequence([
      makeResponse({ persona: 'coder', content: 'Fixes are complete' }),
      makeResponse({ persona: 'reviewers', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    await engine.run();

    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.permissionResolution)
      .toMatchObject({ stepName: 'entry', requiredPermissionMode: 'edit' });
  });

  it('passes gather provider options through execution and starts its report phase', async () => {
    const workflow = loadWorkflowFromFile(
      writeBuiltinFragmentWorkflow(projectDir, BUILTIN_FRAGMENT_CASES[2]!),
      projectDir,
    );
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
    engines.push(engine);
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'Review target information gathered' }),
      makeResponse({ persona: 'plan', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    await engine.run();

    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.providerOptions).toMatchObject({
      claude: { allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] },
    });
    expect(runReportPhase).toHaveBeenCalledOnce();
  });

  it.each([
    { language: 'en' as const, label: 'Cannot identify review target, insufficient info' },
    { language: 'ja' as const, label: 'レビュー対象を特定できない、情報不足' },
  ])('routes the $language gather fragment abort branch to the terminal sink', async ({ language, label }) => {
    const abortRuleIndex = fragmentRuleIndex(language, 'gather', 'ABORT');
    const workflow = loadWorkflowFromFile(
      writeBuiltinFragmentWorkflow(projectDir, {
        fragment: 'gather',
        language,
        label,
        nextStep: 'plan',
        persona: 'planner',
        ruleIndex: abortRuleIndex,
        ruleNextStep: 'ABORT',
      }),
      projectDir,
    );
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'planner', content: label })]);
    mockRuleEvaluationSequence([{ index: abortRuleIndex, method: 'phase3_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
  });

  it.each(['en', 'ja'] as const)('executes all %s reviewers fragment sub-steps before its aggregate transition', async (language) => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'reviewed.ts'), 'export const reviewed = true;\n', 'utf-8');
    initializeGitFixture(projectDir, ['src/reviewed.ts']);
    const workflow = loadWorkflowFromFile(writeBuiltinReviewersWorkflow(projectDir, language), projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
    engines.push(engine);
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const reviewerPersonas = [
      'architecture-reviewer',
      'ai-antipattern-reviewer',
      'coding-reviewer',
      'implementation-semantics-reviewer',
      'contract-lifecycle-reviewer',
      'robustness-reviewer',
    ];
    mockFindingContractAgents({ 'final-gate': 'done' });
    mockRuleEvaluationSequence([
      ...reviewerPersonas.map(() => ({ index: 0, method: 'phase3_tag' as const })),
      { index: 6, method: 'aggregate' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    expect(state.status, abortReasons.join('\n')).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.slice(0, reviewerPersonas.length).map(([persona]) => persona).sort())
      .toEqual([...reviewerPersonas].sort());
  }, 60_000);

  it('resolves and executes a relative workflow_call declared by a step fragment', async () => {
    const parentPath = join(projectDir, '.takt', 'workflows', 'parent.yaml');
    const childPath = join(projectDir, '.takt', 'workflows', 'child.yaml');
    mkdirSync(join(projectDir, '.takt', 'steps'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'steps', 'delegate.yaml'), [
      'kind: workflow_call',
      'call: ./child.yaml',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(parentPath, [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 2',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '      - condition: ABORT',
      '        next: ABORT',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(childPath, [
      'name: child',
      'subworkflow:',
      '  callable: true',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    persona: reviewer',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'utf-8');
    const workflow = loadWorkflowFromFile(parentPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
        resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'reviewer', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[0]).toBe('reviewer');
  });

  it.each(FINAL_GATE_RETURN_CASES)('routes the final-gate fragment $returnValue return', async ({ returnValue, superviseRuleIndex, nextStep }) => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'reviewed.ts'), 'export const reviewed = true;\n', 'utf-8');
    initializeGitFixture(projectDir, ['src/reviewed.ts']);
    const workflowPath = writeBuiltinReturnWorkflow(projectDir);
    const workflow = loadWorkflowFromFile(workflowPath, projectDir, {
      trustInfo: {
        source: 'worktree',
        sourcePath: workflowPath,
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      },
    });
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      workflowCallResolver: ({ parentWorkflow, step, projectCwd: resolverProjectCwd, lookupCwd }) =>
        resolveWorkflowCallTarget(parentWorkflow, step, resolverProjectCwd, lookupCwd),
    });
    engines.push(engine);
    const transitions: string[] = [];
    const abortReasons: string[] = [];
    engine.on('step:complete', (step) => transitions.push(step.name));
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    mockFindingContractAgents({
      'merge-readiness-reviewer': 'approved',
      supervisor: returnValue,
      ...(nextStep ? { [nextStep]: 'done' } : {}),
    });
    mockRuleEvaluationSequence([
      { index: MERGE_READINESS_TO_SUPERVISE_RULE_INDEX, method: 'phase3_tag' },
      { index: superviseRuleIndex, method: 'phase3_tag' },
      ...(nextStep ? [{ index: 0, method: 'phase3_tag' as const }] : []),
    ]);

    const state = await engine.run();
    const needsConflictAdjudication = returnValue === 'needs_conflict_adjudication';

    expect(state.status, abortReasons.join('\n')).toBe(
      returnValue === 'ABORT' || needsConflictAdjudication ? 'aborted' : 'completed',
    );
    expect(transitions).toEqual([
      'merge-readiness-review',
      'supervise',
      ...(needsConflictAdjudication ? ['finding-conflict-adjudication', 'merge-readiness-review'] : []),
      ...(nextStep ? [nextStep] : []),
    ]);
    const conflictAdjudicationCalls = needsConflictAdjudication ? 2 : 0;
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4 + (nextStep ? 1 : 0) + conflictAdjudicationCalls);
  }, 60_000);
});

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
      if (repetition < monitor.threshold - 1) {
        expect(result.triggered, monitor.cycle.join(' -> ')).toBe(false);
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
      ...LIGHTWEIGHT_CORE_WORKFLOWS,
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

  it.each(LANGUAGES)('routes %s development-core rework through replan instead of a full replan-from-plan', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const raw = readBuiltinWorkflow(lang, 'development-core');
    const replan = getStep(raw, 'replan');
    // Defined inline: the subworkflow param type system cannot parameterize `uses:`,
    // so the FC instruction variant is selected through the instruction facet_ref param.
    expect(replan.uses).toBeUndefined();
    expect(replan).toMatchObject({
      persona: 'planner',
      edit: false,
      instruction: { $param: 'replan_instruction' },
      knowledge: { $param: 'plan_knowledge' },
      output_contracts: { report: [{ name: 'plan.md', format: 'plan' }] },
    });
    expect(replan.policy).toEqual(['contract-change', { $param: 'plan_policy' }]);
    expect((replan.rules as RawRule[]).map((rule) => rule.next))
      .toEqual(['implement', 'peer-review', 'ABORT']);

    const nextTargets = (stepName: string): (string | undefined)[] =>
      (getStep(raw, stepName).rules as RawRule[]).map((rule) => rule.next);
    expect(nextTargets('implement')).toContain('replan');
    expect(nextTargets('implement')).not.toContain('plan');
    expect(nextTargets('peer-review')).toContain('replan');
    expect(nextTargets('peer-review')).not.toContain('plan');
    // write_tests keeps its escalation to the full plan step.
    expect(nextTargets('write_tests')).toContain('plan');

    const workflowPath = join(getBuiltinWorkflowsDir(lang), 'development-core.yaml');
    const loaded = loadWorkflowFromFile(workflowPath, projectDir);
    const loadedReplan = loaded.steps.find((step) => step.name === 'replan');
    expect(loadedReplan).toMatchObject({ persona: 'planner', edit: false });
    expect(loadedReplan?.outputContracts?.[0]).toMatchObject({ name: 'plan.md', formatRef: 'plan' });
    expect(loadedReplan?.instruction?.trim().length ?? 0).toBeGreaterThan(0);

    invalidateAllResolvedConfigCache();
    const fcLoaded = loadWorkflowFromFile(workflowPath, projectDir, {
      callableArgs: { replan_instruction: 'replan-implementation-finding-contract' },
    });
    const fcReplan = fcLoaded.steps.find((step) => step.name === 'replan');
    expect(fcReplan?.instruction).not.toBe(loadedReplan?.instruction);
    expect(fcReplan?.instruction?.trim().length ?? 0).toBeGreaterThan(0);
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
