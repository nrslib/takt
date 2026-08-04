import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';

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
