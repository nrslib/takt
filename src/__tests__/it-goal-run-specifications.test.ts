import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import { resolveTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { buildRunPaths, buildRunPathsFromRunsDirectory } from '../core/workflow/run/run-paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
import { runAgent } from '../agents/runner.js';

let project: string;
const specifications = {
  gherkin: 'Feature: SavedGherkinExport\n  Scenario: CSV\n    Then export succeeds\n',
  quint: 'module SavedQuintExport {\n  // ``` preserved\n}\n',
  alloy: 'sig SavedAlloyExport {}\n',
};
const specificationMarkers: Record<string, string> = {
  gherkin: 'SavedGherkinExport', quint: 'SavedQuintExport', alloy: 'SavedAlloyExport',
};
const runSlug = 'goal-specifications-run';
const orderContent = '# Export CSV\n\nImplement AC-EXPORT-1.';
const specificationFiles: Record<string, string> = {
  gherkin: 'gherkin.feature', quint: 'quint.qnt', alloy: 'alloy.als',
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'takt-goal-run-specs-{v2}-{{name}}-'));
  const workflows = join(project, '.takt', 'workflows');
  mkdirSync(workflows, { recursive: true });
  const personas = join(project, '.takt', 'facets', 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(personas, 'worker.md'), 'Implement the assigned requirement.');
  writeFileSync(join(workflows, 'data.csv'), 'requirement\nAC-EXPORT-1\n');
  writeFileSync(join(workflows, 'batch.md'), 'Verify {line:1}');
  writeFileSync(join(workflows, 'spec-root.yaml'), [
    'name: spec-root', 'max_steps: 5', 'initial_step: plan', 'steps:',
    '  - name: plan', '    persona: worker', '    instruction: "Plan {task}"',
    '    rules:', '      - condition: when(true)', '        next: child',
    '  - name: child', '    kind: workflow_call', '    call: spec-child',
    '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
  ].join('\n'));
  writeFileSync(join(workflows, 'spec-child.yaml'), [
    'name: spec-child', 'subworkflow:', '  callable: true',
    'max_steps: 5', 'initial_step: implement', 'steps:',
    '  - name: implement', '    persona: worker', '    instruction: Implement the assigned requirement.',
    '    rules:', '      - condition: when(true)', '        next: verify',
    '  - name: verify', '    persona: worker',
    '    arpeggio:', '      source: csv', '      source_path: ./data.csv', '      template: ./batch.md',
    '      merge:', '        strategy: concat',
    '    rules:', '      - condition: when(true)', '        next: COMPLETE',
  ].join('\n'));
  vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'worker', userInstruction: instruction });
    return { persona: 'worker', status: 'done', content: 'Completed.', timestamp: new Date() };
  });
  invalidateAllResolvedConfigCache();
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(project, { recursive: true, force: true });
  invalidateAllResolvedConfigCache();
});

it.each([
  { language: 'ja', specs: specifications, central: false, legacy: false },
  { language: 'en', specs: { gherkin: specifications.gherkin }, central: true, legacy: false },
  { language: 'ja', specs: undefined, central: false, legacy: true },
  { language: 'en', specs: {}, central: false, legacy: false },
] as const)('stages saved specifications and notifies root and child steps: %j', async ({ language, specs, central, legacy }) => {
  writeFileSync(join(project, '.takt', 'config.yaml'), `provider: mock\nlanguage: ${language}\n`);
  invalidateAllResolvedConfigCache();
  const goal = { ...goalRecord(), ...(specs === undefined ? {} : { specifications: specs }) };
  await new GoalStore(project).create(goal);
  const clone = join(project, 'clone');
  mkdirSync(clone);
  const runsDirectory = central ? join(project, 'state', 'runs') : undefined;
  const runPaths = runsDirectory === undefined
    ? buildRunPaths(clone, runSlug)
    : buildRunPathsFromRunsDirectory(runsDirectory, runSlug);
  const sourceTaskDir = '.takt/tasks/export';
  mkdirSync(join(project, sourceTaskDir), { recursive: true });
  const order = legacy ? `${orderContent}\n\n${specifications.quint}` : orderContent;
  writeFileSync(join(project, sourceTaskDir, 'order.md'), order);
  const taskSpec = resolveTaskSpecForExecution(project, clone, sourceTaskDir, runSlug, runPaths);

  const result = await runWorkflowExecution({
    projectCwd: project, cwd: clone, workflowIdentifier: 'spec-root',
    workflowResourceRoot: join(project, '.takt'), goalId: goal.id,
    task: taskSpec.taskPrompt, taskSpec, reportDirName: runSlug,
    outputMode: 'silent', handleSigint: false, skipWorktreeRuntimeProtection: true,
    ...(runsDirectory === undefined ? {} : { runPathsDirectory: runsDirectory }),
  });

  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(readFileSync(runPaths.contextTaskOrderAbs, 'utf8')).toBe(order);
  const directory = join(runPaths.contextTaskAbs, 'specifications');
  const expectedFiles = specs === undefined ? [] : Object.keys(specs).map((notation) => specificationFiles[notation]!);
  const prompts = vi.mocked(runAgent).mock.calls;
  expect(prompts.map(([, , options]) => options?.workflowMeta?.currentStep)).toEqual(['plan', 'implement', 'verify']);
  if (expectedFiles.length === 0) {
    expect(existsSync(directory)).toBe(false);
    for (const [, prompt] of prompts) expect(prompt).not.toContain(directory);
  } else {
    expect(readdirSync(directory).sort()).toEqual(expectedFiles.sort());
    for (const [notation, body] of Object.entries(specs!)) {
      const file = specificationFiles[notation]!;
      const path = join(directory, file);
      expect(readFileSync(path, 'utf8')).toBe(body);
      for (const [, prompt] of prompts) {
        expect(prompt).toContain(path);
        expect(prompt).not.toContain(body);
        expect(prompt).not.toContain(specificationMarkers[notation]!);
      }
    }
  }
  expect(existsSync(join(project, sourceTaskDir, 'specifications'))).toBe(false);
});
