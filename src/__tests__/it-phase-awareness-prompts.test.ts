import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, Language } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';
import { MockProvider } from '../infra/providers/mock.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import type { AgentSetup, ProviderCallOptions } from '../infra/providers/types.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { prepareWorkflowExecutionBundle, publishWorkflowExecutionBundle, loadWorkflowExecutionBundle } from '../features/tasks/execute/workflowExecutionBundle.js';

const rootYaml = `name: root
description: 全体の役目
max_steps: 40
initial_step: first
steps:
  - name: first
    kind: workflow_call
    call: middle
    rules:
      - condition: middle-finished
        next: second
  - name: second
    kind: workflow_call
    call: middle
    rules:
      - condition: middle-finished
        next: gate
  - name: gate
    instruction: GATE-WORK
    rules:
      - condition: repeat
        next: first
      - condition: finish
        next: COMPLETE
`;
const middleYaml = `name: middle
subworkflow:
  callable: true
  returns: [middle-finished, middle-failed]
report_formats:
  static: |
    # Static report
initial_step: outer
steps:
  - name: outer
    parallel:
      - name: static
        instruction: STATIC-WORK
        output_contracts:
          report:
            - name: static.md
              format: static
        rules:
          - condition: static-ok
            next: COMPLETE
          - condition: static-no
            next: ABORT
      - name: nested
        kind: workflow_call
        call: leaf
        rules:
          - condition: leaf-finished
            next: COMPLETE
    rules:
      - condition: outer-ok
        return: middle-finished
      - condition: outer-no
        return: middle-failed
`;
const leafYaml = `name: leaf
description: 内側の役目
subworkflow:
  callable: true
  returns: [leaf-finished, leaf-failed]
report_formats:
  fixed: |
    # Fixed report
  pool: |
    # Pool report
initial_step: reviews
steps:
  - name: reviews
    parallel:
      fixed:
        - name: fixed
          instruction: FIXED-WORK
          output_contracts:
            report:
              - name: fixed.md
                format: fixed
          rules:
            - condition: fixed-ok
              next: COMPLETE
            - condition: fixed-no
              next: ABORT
      pool:
        - name: pool
          description: 必要なら選ぶ
          instruction: POOL-WORK
          output_contracts:
            report:
              - name: pool.md
                format: pool
          rules:
            - condition: pool-ok
              next: COMPLETE
            - condition: pool-no
              next: ABORT
      selection:
        mode: replace
    rules:
      - condition: reviews-ok
        return: leaf-finished
      - condition: reviews-no
        return: leaf-failed
`;

const jaTree = `- root（ワークフロー）: 全体の役目
  - first
    - middle（ワークフロー）
      - outer
        - static
        - nested
          - leaf（ワークフロー）: 内側の役目
            - reviews
              - fixed
              - pool（実行時に選ばれたときだけ動く）: 必要なら選ぶ
  - second
    - middle（ワークフロー）
      - outer
        - static
        - nested
          - leaf（ワークフロー）: 内側の役目
            - reviews
              - fixed
              - pool（実行時に選ばれたときだけ動く）: 必要なら選ぶ
  - gate`;
const enTree = `- root (workflow): 全体の役目
  - first
    - middle (workflow)
      - outer
        - static
        - nested
          - leaf (workflow): 内側の役目
            - reviews
              - fixed
              - pool (runs only when selected at runtime): 必要なら選ぶ
  - second
    - middle (workflow)
      - outer
        - static
        - nested
          - leaf (workflow): 内側の役目
            - reviews
              - fixed
              - pool (runs only when selected at runtime): 必要なら選ぶ
  - gate`;

interface CapturedCall {
  readonly agent: string;
  readonly provider: 'mock' | 'opencode';
  readonly system: string;
  readonly instruction: string;
  readonly options: ProviderCallOptions;
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  return text.slice(start + heading.length + 4).split(/\n(?:## |---(?:\n|$))/)[0]!.trim();
}

function done(content: string, structuredOutput?: Record<string, unknown>): AgentResponse {
  return { persona: 'default', status: 'done', content, structuredOutput, sessionId: 'work-session', timestamp: new Date() };
}

describe('phase awareness through bundled workflow engines and providers', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'takt-phase-awareness-'));
    vi.stubEnv('TAKT_CONFIG_DIR', join(directory, 'global'));
    mkdirSync(join(directory, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(directory, '.takt', 'workflows', 'root.yaml'), rootYaml);
    writeFileSync(join(directory, '.takt', 'workflows', 'middle.yaml'), middleYaml);
    writeFileSync(join(directory, '.takt', 'workflows', 'leaf.yaml'), leafYaml);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['ja', 'en'] as const)('keeps the complete tree, assignment, phase, and rules in every provider call (%s)', async (language: Language) => {
    const calls: CapturedCall[] = [];
    let gateWorks = 0;
    const reportAttempts = new Map<string, number>();
    const installProvider = (provider: 'mock' | 'opencode', setup: AgentSetup) => ({
      call: async (instruction: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        const system = setup.systemPrompt ?? '';
        calls.push({ agent: setup.name, provider, system, instruction, options });
        if (setup.name === 'dynamic-parallel-selector') return done('', { selected_ids: ['pool'], rationale: 'select pool' });
        const assignment = section(system, language === 'ja' ? '担当' : 'Assignment');
        const step = assignment.match(/^- (?:ステップ|Step): (\w+)/m)![1]!;
        const phase = Number(assignment.match(/Phase ([123])/ )![1]);
        if (phase === 1) {
          if (step === 'gate') gateWorks++;
          return done(`WORK-RESULT-${step}`);
        }
        if (phase === 2) {
          const key = `${step}:${assignment}`;
          const attempt = (reportAttempts.get(key) ?? 0) + 1;
          reportAttempts.set(key, attempt);
          // First resume and first fresh-session report both fail, then the other provider succeeds.
          if (provider === 'opencode') return done('');
          return done(`# Report\nWORK-RESULT-${step}`);
        }
        const selected = step === 'gate' && gateWorks === 2 ? 2 : 1;
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'matched_index')) return done('', { matched_index: selected, reason: 'matches the supplied result' });
        if (step === 'fixed' || step === 'gate' || step === 'reviews') return done('', { step: selected, reason: 'matches the supplied result' });
        if (step === 'pool' && Object.hasOwn(options.outputSchema?.properties ?? {}, 'content')) {
          return done('', { content: '[POOL:1]' });
        }
        // static and outer exhaust structured and tag stages and reach ai_judge.
        return done('No valid structured judgment or tag');
      },
    });
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => installProvider('mock', setup));
    vi.spyOn(OpenCodeProvider.prototype, 'setup').mockImplementation((setup) => installProvider('opencode', setup));

    const source = loadWorkflowFromFile(join(directory, '.takt', 'workflows', 'root.yaml'), directory);
    const prepared = prepareWorkflowExecutionBundle({
      rootWorkflow: source, projectCwd: directory, lookupCwd: directory,
      workflowCallResolver: ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, directory),
    });
    rmSync(join(directory, '.takt', 'workflows'), { recursive: true });
    const allRuns: CapturedCall[][] = [];
    for (const slug of ['initial', 'retry']) {
      gateWorks = 0;
      reportAttempts.clear();
      const offset = calls.length;
      const paths = buildRunPaths(directory, slug);
      publishWorkflowExecutionBundle(paths, prepared);
      const bundle = loadWorkflowExecutionBundle(paths);
      const engine = new WorkflowEngine(bundle.rootWorkflow, directory, 'TASK-REQUIREMENT', {
        selectorProvider: { provider: 'mock', model: undefined }, selectorGitCommandRunner: new GitSelectorCommandRunner(),
        projectCwd: directory, provider: 'opencode', model: 'test/model', language,
        reportFallbackProvider: { provider: 'mock', model: 'report-model' },
        workflowCallResolver: bundle.workflowCallResolver, workflowBundleResourceRoot: bundle.resourceRoot,
        structuredCaller: new ProviderNeutralStructuredCaller(), reportDirName: slug,
      });
      const aborts: string[] = [];
      engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
      const state = await engine.run();
      expect(state.status, aborts.join('\n')).toBe('completed');
      expect(gateWorks).toBe(2);
      expect(reportAttempts.size).toBe(12);
      expect([...reportAttempts.values()]).toEqual(Array<number>(12).fill(3));
      allRuns.push(calls.slice(offset));
    }

    const expectedTree = language === 'ja' ? jaTree : enTree;
    for (const run of allRuns) {
      const workflowCalls = run;
      expect(workflowCalls.length).toBeGreaterThan(40);
      const workCalls = workflowCalls.filter((call) => section(call.system, language === 'ja' ? '担当' : 'Assignment').includes('Phase 1'));
      expect(workCalls.filter((call) => call.instruction.includes('GATE-WORK'))).toHaveLength(2);
      const workSignature = workCalls.map((call) => {
        const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
        const step = assignment.match(/^- (?:ステップ|Step): (\w+)/m)![1];
        const stepIteration = assignment.match(/Step Iteration: (\d+)/)![1];
        const iteration = assignment.match(/^- Iteration: (\d+)\/40/m)![1];
        return `${step}:${stepIteration}:${iteration}`;
      });
      expect(workSignature.sort()).toEqual([
        'static:1:1', 'reviews:1:2', 'fixed:1:2', 'pool:1:2',
        'static:1:3', 'reviews:1:4', 'fixed:1:4', 'pool:1:4', 'gate:1:5',
        'static:1:6', 'reviews:1:7', 'fixed:1:7', 'pool:1:7',
        'static:1:8', 'reviews:1:9', 'fixed:1:9', 'pool:1:9', 'gate:2:10',
      ].sort());
      for (const call of workflowCalls) {
        const request = `${call.system}\n\n${call.instruction}`;
        expect(request.match(/## (?:担当|Assignment)(?:\n|\\n)/g), request).toHaveLength(1);
        expect(request.match(/## (?:担当とフェーズ|Assignment and phase)/g), request).toHaveLength(1);
        const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
        const step = assignment.match(/^- (?:ステップ|Step): (\w+)/m)![1]!;
        const stepIteration = Number(assignment.match(/Step Iteration: (\d+)/)![1]);
        const iteration = Number(assignment.match(/^- Iteration: (\d+)\/40/m)![1]);
        const phase = Number(assignment.match(/Phase ([123])/ )![1]);
        expect(stepIteration).toBeGreaterThan(0);
        expect(iteration).toBeGreaterThan(0);
        expect(assignment).not.toMatch(/undefined|null|:\s*$/m);
        expect(call.system).not.toContain('{{');
        expect(call.instruction).not.toContain('{{');
        const treeSection = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
        const actualTree = treeSection.slice(treeSection.indexOf('- root'));
        const marker = language === 'ja' ? ' ← 現在' : ' ← current';
        expect(actualTree.split(marker)).toHaveLength(2);
        expect(actualTree.replace(marker, '')).toBe(expectedTree);
        const markedLine = actualTree.split('\n').find((line) => line.includes(marker))!;
        expect(markedLine.trim()).toMatch(new RegExp(`^- ${step}(?:[: （]| \\(|$)`));
        if (step === 'gate') {
          expect([5, 10]).toContain(iteration);
          expect(stepIteration).toBe(iteration === 5 ? 1 : 2);
          expect(actualTree).toBe(`${expectedTree}${marker}`);
        } else {
          const invocations = [
            { branch: 'first', work: 1, judge: 2 },
            { branch: 'second', work: 3, judge: 4 },
            { branch: 'first', work: 6, judge: 7 },
            { branch: 'second', work: 8, judge: 9 },
          ];
          const invocation = invocations.find((entry) => (step === 'static' ? entry.work : entry.judge) === iteration);
          expect(invocation, `${step}: Phase ${phase}, Iteration ${iteration}`).toBeDefined();
          expect(stepIteration).toBe(1);
          const firstBranchRows: Record<string, number> = { outer: 3, static: 4, reviews: 7, fixed: 8, pool: 9 };
          const rowIndex = firstBranchRows[step]! + (invocation!.branch === 'second' ? 9 : 0);
          const expectedRows = expectedTree.split('\n');
          expectedRows[rowIndex] += marker;
          expect(actualTree).toBe(expectedRows.join('\n'));
        }
        const parent = ['static'].includes(step) ? 'outer' : ['fixed', 'pool'].includes(step) ? 'reviews' : undefined;
        if (parent !== undefined) expect(assignment).toContain(language === 'ja' ? `（${parent} の並列サブステップ）` : `(parallel substep of ${parent})`);
        const prefix = section(call.instruction, language === 'ja' ? '担当とフェーズ' : 'Assignment and phase');
        expect(call.instruction.trimStart().startsWith(language === 'ja' ? '## 担当とフェーズ' : '## Assignment and phase')).toBe(true);
        const stepLabel = parent === undefined ? step : language === 'ja'
          ? `${step}（${parent} の並列サブステップ）`
          : `${step} (parallel substep of ${parent})`;
        const phaseLabel = language === 'ja'
          ? ['', '作業', 'レポート', '判定'][phase]
          : ['', 'work', 'report', 'judgment'][phase];
        expect(prefix.split('\n')[0]).toBe(language === 'ja'
          ? `今は ${stepLabel} ステップの${phaseLabel}フェーズ（Phase ${phase}）です（Step Iteration: ${stepIteration}）。`
          : `You are now in the ${phaseLabel} phase (Phase ${phase}) of step ${stepLabel} (Step Iteration: ${stepIteration}).`);
        const systemPhase = language === 'ja'
          ? `${phaseLabel}フェーズ（Phase ${phase}）`
          : `${phaseLabel!.charAt(0).toUpperCase()}${phaseLabel!.slice(1)} phase (Phase ${phase})`;
        expect(assignment).toBe([
          `- ${language === 'ja' ? 'ステップ' : 'Step'}: ${stepLabel}`,
          `- Step Iteration: ${stepIteration}`,
          `- Iteration: ${iteration}/40`,
          `- ${language === 'ja' ? 'フェーズ' : 'Phase'}: ${systemPhase}`,
        ].join('\n'));
        if (Object.hasOwn(call.options.outputSchema?.properties ?? {}, 'matched_index')) {
          expect(call.instruction).toContain(language === 'ja' ? '# 判定タスク' : '# Judge Task');
          expect(call.instruction).toContain(language === 'ja' ? '## 判定基準' : '## Criteria');
        }
        const rules = section(call.system, language === 'ja' ? `${step} の rules` : `Rules for ${step}`);
        if (step === 'gate') expect(rules).toBe('- repeat → first\n- finish → COMPLETE');
        else if (step === 'outer' || step === 'reviews') {
          const workflow = step === 'outer' ? 'middle' : 'leaf';
          const target = (value: string) => language === 'ja'
            ? `${workflow} を終えて ${value} を返す`
            : `finish ${workflow} and return ${value}`;
          expect(rules).toBe(`- ${step}-ok → ${target(`${workflow}-finished`)}\n- ${step}-no → ${target(`${workflow}-failed`)}`);
        } else expect(rules).toBe(`- ${step}-ok → COMPLETE\n- ${step}-no → ABORT`);
        if (phase === 2) {
          expect(section(call.instruction, language === 'ja' ? '作業結果' : 'Work Results')).toContain(`WORK-RESULT-${step}`);
          if (call.provider === 'mock') expect(call.options.sessionId).toBeUndefined();
        }
      }
      const reports = workflowCalls.filter((call) => section(call.system, language === 'ja' ? '担当' : 'Assignment').includes('Phase 2'));
      expect(reports.some((call) => call.provider === 'opencode' && call.options.sessionId !== undefined)).toBe(true);
      expect(reports.some((call) => call.provider === 'opencode' && call.options.sessionId === undefined)).toBe(true);
      expect(reports.some((call) => call.provider === 'mock')).toBe(true);
      expect(workflowCalls.some((call) => call.instruction.includes('[JUDGE:N]'))).toBe(true);
      expect(workflowCalls.some((call) => Object.hasOwn(call.options.outputSchema?.properties ?? {}, 'content'))).toBe(true);
      expect(workflowCalls.some((call) => Object.hasOwn(call.options.outputSchema?.properties ?? {}, 'step'))).toBe(true);
    }
    const captureSignature = (run: CapturedCall[]) => run.filter((call) => call.system.includes(language === 'ja' ? '## 担当\n' : '## Assignment\n'))
      .map((call) => [section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow'), section(call.system, language === 'ja' ? '担当' : 'Assignment')].join('\n')).sort();
    expect(captureSignature(allRuns[1]!)).toEqual(captureSignature(allRuns[0]!));
  });
});
