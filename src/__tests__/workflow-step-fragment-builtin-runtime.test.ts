import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
  getBuiltinStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';

interface BuiltinFragmentCase {
  fragment: 'fix' | 'gather' | 'replan';
  language: 'en' | 'ja';
  label: string;
  nextStep: string;
  persona: string;
  ruleIndex: number;
}

interface FinalGateReturnCase {
  returnValue: 'COMPLETE' | 'needs_review' | 'need_replan' | 'needs_fix' | 'needs_conflict_adjudication' | 'ABORT';
  superviseRuleIndex: number;
  nextStep?: string;
}

interface RawRule {
  next?: string;
  return?: string;
}

function readRules(path: string, stepName?: string): RawRule[] {
  const raw = parseYaml(readFileSync(path, 'utf-8')) as {
    rules?: RawRule[];
    steps?: Array<{ name?: string; rules?: RawRule[] }>;
  };
  const rules = stepName === undefined
    ? raw.rules
    : raw.steps?.find((step) => step.name === stepName)?.rules;
  if (rules === undefined) {
    throw new Error(`Expected rules in builtin asset: ${path}`);
  }
  return rules;
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

function fragmentRuleIndex(
  language: 'en' | 'ja',
  fragment: 'fix' | 'gather' | 'replan',
  nextStep: string,
): number {
  return findRuleIndex(
    readRules(join(getBuiltinLanguageStepsDir(language), `${fragment}.yaml`)),
    'next',
    nextStep,
  );
}

const SUPERVISE_RULES = readRules(join(getBuiltinStepsDir(), 'finding-contract-supervise.yaml'));
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
  { fragment: 'replan', language: 'en', label: 'An actionable, untried project-scoped change or investigation and its verification steps were defined', nextStep: 'implement', persona: 'planner', ruleIndex: fragmentRuleIndex('en', 'replan', 'implement') },
  { fragment: 'replan', language: 'en', label: 'Concrete evidence shows the current implementation meets the requirements and acceptance criteria, all required project-scoped verification is complete, no untried change or investigation remains, and only independent review is needed', nextStep: 'reviewers', persona: 'planner', ruleIndex: fragmentRuleIndex('en', 'replan', 'reviewers') },
  { fragment: 'fix', language: 'ja', label: '修正完了', nextStep: 'reviewers', persona: 'coder', ruleIndex: fragmentRuleIndex('ja', 'fix', 'reviewers') },
  { fragment: 'fix', language: 'ja', label: '修正を進められない、または実装方針の再定義が必要', nextStep: 'replan', persona: 'coder', ruleIndex: fragmentRuleIndex('ja', 'fix', 'replan') },
  { fragment: 'gather', language: 'ja', label: 'レビュー対象の情報収集完了', nextStep: 'plan', persona: 'planner', ruleIndex: fragmentRuleIndex('ja', 'gather', 'plan') },
  { fragment: 'replan', language: 'ja', label: 'プロジェクト内で実行可能な未試行の変更または原因調査と、その検証手順を具体化した', nextStep: 'implement', persona: 'planner', ruleIndex: fragmentRuleIndex('ja', 'replan', 'implement') },
  { fragment: 'replan', language: 'ja', label: '現行実装が要件・受入条件を満たす具体的根拠があり、必要なプロジェクト内検証が完了し、未試行の変更・調査を残さず、独立レビューだけが必要', nextStep: 'reviewers', persona: 'planner', ruleIndex: fragmentRuleIndex('ja', 'replan', 'reviewers') },
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
    `  - uses: ${fragmentCase.fragment}`,
    '    name: entry',
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
    ...(fragmentCase.nextStep === 'write_tests' ? [] : [
      '  - name: write_tests',
      '    instruction: write_tests',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]),
    ...(fragmentCase.nextStep === 'implement' ? [] : [
      '  - name: implement',
      '    instruction: implement',
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
    '  ledger_path: .takt/findings/ledger.json',
    '  raw_findings_path: .takt/findings/raw',
    '  manager:',
    '    persona: findings-manager',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'steps:',
    '  - uses: finding-contract-final-gate',
    '    name: final-gate',
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
    '  ledger_path: .takt/findings/ledger.json',
    '  raw_findings_path: .takt/findings/raw',
    '  manager:',
    '    persona: findings-manager',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'steps:',
    '  - uses: reviewers',
    '    name: reviewers',
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

  it.each([
    {
      language: 'en' as const,
      label: 'Confirmed evidence shows that project-scoped changes or investigation cannot resolve the issue, leaving only external action or mutually unsatisfiable requirements',
    },
    {
      language: 'ja' as const,
      label: '確認済みの根拠により、プロジェクト内の変更や調査では解消できず、外部操作だけが残るか要件が両立不能である',
    },
  ])('routes the $language replan abort branch to the terminal sink', async ({ language, label }) => {
    const abortRuleIndex = fragmentRuleIndex(language, 'replan', 'ABORT');
    const workflow = loadWorkflowFromFile(
      writeBuiltinFragmentWorkflow(projectDir, {
        fragment: 'replan',
        language,
        label,
        nextStep: 'implement',
        persona: 'planner',
        ruleIndex: abortRuleIndex,
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
      { index: 5, method: 'aggregate' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    expect(state.status, abortReasons.join('\n')).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.slice(0, reviewerPersonas.length).map(([persona]) => persona).sort())
      .toEqual([...reviewerPersonas].sort());
  });

  it('resolves and executes a relative workflow_call declared by a step fragment', async () => {
    const parentPath = join(projectDir, '.takt', 'workflows', 'parent.yaml');
    const childPath = join(projectDir, '.takt', 'workflows', 'child.yaml');
    mkdirSync(join(projectDir, '.takt', 'steps'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'steps', 'delegate.yaml'), [
      'kind: workflow_call',
      'call: ./child.yaml',
      'rules:',
      '  - condition: COMPLETE',
      '    next: COMPLETE',
      '  - condition: ABORT',
      '    next: ABORT',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(parentPath, [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 2',
      'steps:',
      '  - uses: delegate',
      '    name: delegate',
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

    expect(state.status, abortReasons.join('\n')).toBe(
      returnValue === 'ABORT' || returnValue === 'needs_conflict_adjudication' ? 'aborted' : 'completed',
    );
    expect(transitions).toEqual([
      'merge-readiness-review',
      'supervise',
      'final-gate',
      ...(returnValue === 'needs_conflict_adjudication' ? ['finding-conflict-adjudication'] : []),
      ...(nextStep ? [nextStep] : []),
    ]);
    // merge-readiness と supervise は Finding Contract reviewer の
    // Phase 1 + report publication をそれぞれ1回ずつ実行する。
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(nextStep ? 5 : 4);
  });
});
