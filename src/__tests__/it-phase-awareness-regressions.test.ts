import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, Language, WorkflowConfig, WorkflowStep } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import { MockProvider } from '../infra/providers/mock.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';
import { buildWrappedSystemPrompt } from '../agents/runner-prompt.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

// These are independent expectations for the approved phase text, not rendered templates.
const phaseBodies = {
  ja: {
    1: 'このフェーズでは、ステップの作業をします。前のレポートフェーズや判定フェーズの「ファイルを読まない」「ツールを使わない」「ソースファイルを変更しない」という制限は、このフェーズにはありません。このステップの指示と権限の範囲で、必要なファイルを読み、コマンドを実行して確かめてください。',
    2: `このフェーズでは、今回の作業フェーズの結果を、「出力内容」の節で指定した形式のレポートとして回答します。
- 今回の作業フェーズの結果は「作業結果」の節です。会話の中に前の回の回答が残っていても、レポートには「作業結果」の節の内容を書いてください。「作業結果」の節に、今回の作業フェーズの回答を取得できなかったと書かれている場合は、会話の中の回答で補わず、作業結果がないためレポートを作れないことと、その理由を書いてください。
- 「元の要求」と「追加のユーザー入力」の節は、レポートが答えるべき要求として使ってください。
- 「Phase 1に提示された上流応答」と「Phase 1に注入された参考レポート」の節は、作業フェーズが受け取った材料です。作業結果の根拠を確かめるためだけに使い、そこから新しい結論を作らないでください。
このフェーズでは、ファイルを読まず、ツールも使いません。足りない情報は推測せず、分からないと書いてください。この制限はこのフェーズの中だけのもので、次の作業フェーズには持ち越しません。`,
    3: `このフェーズでは、この指示に含まれるレポートや回答に書かれた内容が、「判定基準」の節のどのルールに当たるかを選びます。選べるのは「判定基準」の節にあるルールだけです。
このフェーズでは、ファイルを読まず、ツールも使いません。会話の中に前の回のレポートや判定が残っていても、この指示に含まれる入力だけで判定してください。この制限はこのフェーズの中だけのものです。`,
  },
  en: {
    1: "In this phase, perform the step's work. Restrictions from previous report or judgment phases against reading files, using tools, or modifying source files do not apply to this phase. Within this step's instructions and permissions, read the necessary files and run commands to verify facts.",
    2: `In this phase, respond with a report of the current work phase's results in the format specified in the "Output" section.
- The results of the current work phase are in the "Work Results" section. Even if responses from earlier executions remain in the conversation, report the contents of "Work Results". If that section says the current work phase's response could not be retrieved, do not fill the gap with responses from the conversation. Explain that a report cannot be created because the work results are unavailable, and state the reason.
- Use the "Original Request" and "Additional User Inputs" sections as the requirements the report must address.
- The "Upstream Response Presented in Phase 1" and "Reference Reports Injected in Phase 1" sections contain materials received by the work phase. Use them only to check the evidence for the work results; do not draw new conclusions from them.
In this phase, do not read files or use tools. Do not guess missing information; state what is unknown. These restrictions apply only within this phase and do not carry over to the next work phase.`,
    3: `In this phase, select the rule in "Criteria" that matches the contents of the reports or responses included in this instruction. Only rules in "Criteria" may be selected.
In this phase, do not read files or use tools. Even if earlier reports or judgments remain in the conversation, judge only the inputs included in this instruction. These restrictions apply only within this phase.`,
  },
};

function expectPhase(instruction: string, language: Language, step: string, phase: 1 | 2 | 3, stepIteration: number): void {
  const heading = language === 'ja' ? '## 担当とフェーズ' : '## Assignment and phase';
  const name = language === 'ja'
    ? { 1: '作業', 2: 'レポート', 3: '判定' }[phase]
    : { 1: 'work', 2: 'report', 3: 'judgment' }[phase];
  const firstLine = language === 'ja'
    ? `今は ${step} ステップの${name}フェーズ（Phase ${phase}）です（Step Iteration: ${stepIteration}）。`
    : `You are now in the ${name} phase (Phase ${phase}) of step ${step} (Step Iteration: ${stepIteration}).`;
  const expected = `${heading}\n\n${firstLine}\n${phaseBodies[language][phase]}`;
  expect(instruction.split(heading)).toHaveLength(2);
  expect(instruction.trimStart().startsWith(`${expected}\n\n`)).toBe(true);
}

function section(text: string, heading: string): string {
  const prefix = `## ${heading}\n`;
  const index = text.indexOf(prefix);
  expect(index).toBeGreaterThanOrEqual(0);
  return text.slice(index + prefix.length).split(/\n(?:## |---(?:\n|$))/)[0]!.trim();
}

function done(content: string, structuredOutput?: Record<string, unknown>): AgentResponse {
  return { persona: 'default', status: 'done', content, structuredOutput, sessionId: 'session', timestamp: new Date() };
}

describe('phase awareness review regressions', () => {
  let directory: string;
  let providerCalls: Array<{ system: string; instruction: string }>;
  const recordCall = (system: string, instruction: string): void => {
    providerCalls.push({ system, instruction });
  };
  beforeEach(() => {
    providerCalls = [];
    directory = mkdtempSync(join(tmpdir(), 'takt-phase-regressions-'));
    const globalDir = join(directory, 'global');
    mkdirSync(globalDir);
    writeFileSync(join(globalDir, 'config.yaml'), 'prevent_sleep: false\n');
    vi.stubEnv('TAKT_CONFIG_DIR', globalDir);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });
  afterEach(() => {
    const calls = providerCalls;

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(directory, { recursive: true, force: true });
    for (const call of calls) {
      const request = `${call.system}\n\n${call.instruction}`;
      expect(request.match(/## (?:担当|Assignment)(?:\n|\\n)/g), request).toHaveLength(1);
      expect(request.match(/## (?:担当とフェーズ|Assignment and phase)/g), request).toHaveLength(1);
    }
  });

  it.each(['ja', 'en'] as const)('preserves persona, process safety, and runtime instructions without referring to a missing assignment (%s)', (language) => {
    for (const workflowMeta of [undefined, { workflowName: 'outside', currentStep: 'outside', processSafety: { protectedParentRunPid: 12345 } }]) {
      const system = buildWrappedSystemPrompt('PERSONA CONTENT', {
        language, personaPath: '/persona.md', workflowMeta,
        providerRuntimeInstructions: 'RUNTIME INSTRUCTIONS',
      });
      expect(system).toContain('PERSONA CONTENT');
      expect(system).toContain('## Provider Runtime Instructions\n\nRUNTIME INSTRUCTIONS');
      expect(system).toContain(language === 'ja' ? '## TAKT の仕組み' : '## How TAKT works');
      expect(system).not.toContain(language === 'ja' ? '## 会話とフェーズの制限' : '## Conversation and phase restrictions');
      expect(system).not.toContain(language === 'ja' ? '## 担当\n' : '## Assignment\n');
      if (workflowMeta !== undefined) {
        expect(system).toContain('## Process Safety');
        expect(system).toContain('12345');
      }
    }
  });

  it.each(['ja', 'en'] as const)('runs decomposition, a team part, and more-parts requests through the real structured caller with phase context (%s)', async (language) => {
    const calls: Array<{ system: string; instruction: string; kind: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        const properties = options.outputSchema?.properties ?? {};
        const kind = Object.hasOwn(properties, 'done') ? 'more'
          : Object.hasOwn(properties, 'parts') ? 'decompose'
          : Object.hasOwn(properties, 'step') ? 'judge'
          : (setup.systemPrompt ?? '').match(/^- (?:フェーズ|Phase): .*Phase 2/m) ? 'report' : 'part';
        calls.push({ system: setup.systemPrompt ?? '', instruction, kind });
        if (kind === 'decompose') return done('', { parts: [{ id: 'worker', title: 'Implement work', instruction: 'PART WORK' }] });
        if (kind === 'more') return done('', { done: true, reasoning: 'finished', cancelPartIds: [], parts: [] });
        if (kind === 'judge') return done('', { step: 1, reason: 'approved' });
        if (kind === 'report') return done('', { content: 'approved report' });
        return done('approved part result');
      },
    }));
    const engine = new WorkflowEngine({
      name: 'teams', maxSteps: 5, initialStep: 'implement',
      steps: [{
        name: 'implement', instruction: 'Implement task', personaDisplayName: 'Leader',
        teamLeader: { maxConcurrency: 1, timeoutMs: 10000 },
        outputContracts: [{ name: 'team.md', format: '# Report\n{task}' }],
        rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'ABORT' })],
      }],
    }, directory, 'team task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'teams', structuredCaller: new ProviderNeutralStructuredCaller() });
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
    engine.getState().stepIterations.set('implement.worker', 2);
    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    expect(calls.map((call) => call.kind)).toEqual(['decompose', 'part', 'more', 'report', 'judge']);
    for (const call of calls) {
      const phase = call.kind === 'report' ? 2 : call.kind === 'judge' ? 3 : 1;
      const label = call.kind === 'part'
        ? language === 'ja' ? 'worker（implement の part）' : 'worker (part of implement)'
        : 'implement';
      const stepIteration = call.kind === 'part' ? 3 : 1;
      expectPhase(call.instruction, language, label, phase, stepIteration);
      const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
      expect(assignment).toContain(`: ${label}\n- Step Iteration: ${stepIteration}\n- Iteration: 1/5`);
      expect(assignment).toContain(`Phase ${phase}`);
      const tree = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
      const root = language === 'ja' ? '- teams（ワークフロー）' : '- teams (workflow)';
      expect(tree.slice(tree.indexOf(root))).toBe(`${root}\n  - implement${language === 'ja' ? ' ← 現在' : ' ← current'}`);
      if (call.kind === 'part') {
        expect(call.system).not.toMatch(/## .*rules/);
      } else {
        expect(section(call.system, language === 'ja' ? 'implement の rules' : 'Rules for implement')).toBe('- approved → COMPLETE\n- needs_fix → ABORT');
      }
    }
  });

  it.each([['ja', false], ['en', false], ['ja', true], ['en', true]] as const)('keeps assignment exactly once in provider input after an empty response (%s, parallel=%s)', async (language, parallel) => {
    const sessions: Array<string | undefined> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        sessions.push(options.sessionId);
        return done(providerCalls.length === 1 ? '' : 'completed work');
      },
    }));
    const worker = {
      name: 'work', instruction: 'Perform the work', personaDisplayName: 'Worker',
      rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
    };
    const engine = new WorkflowEngine({
      name: 'empty-recovery', maxSteps: 5, initialStep: 'work',
      steps: [parallel ? {
        ...worker, instruction: '', parallel: [worker],
      } : worker],
    }, directory, 'work task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'empty-recovery' });
    engine.getState().stepIterations.set(parallel ? JSON.stringify({ ancestors: ['work'], step: 'work' }) : 'work', 2);
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));

    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    expect(providerCalls).toHaveLength(2);
    expect(sessions).toEqual([undefined, 'session']);
    const label = parallel
      ? language === 'ja' ? 'work（work の並列サブステップ）' : 'work (parallel substep of work)'
      : 'work';
    for (const call of providerCalls) {
      expectPhase(call.instruction, language, label, 1, 3);
      const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
      expect(assignment).toContain(`: ${label}\n- Step Iteration: 3\n- Iteration: 1/5`);
      expect(assignment).toContain('Phase 1');
    }
    expect(section(providerCalls[1]!.system, language === 'ja' ? '担当' : 'Assignment'))
      .toBe(section(providerCalls[0]!.system, language === 'ja' ? '担当' : 'Assignment'));
  });

  it.each([['ja', false], ['en', false], ['ja', true], ['en', true]] as const)('passes the owning step position and judgment phase through the completion retry transport (%s, parallel=%s)', async (language, parallel) => {
    const calls: Array<{ system: string; instruction: string; completionJudge: boolean }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        const properties = options.outputSchema?.properties ?? {};
        const completionJudge = Object.hasOwn(properties, 'complete');
        calls.push({ system: setup.systemPrompt ?? '', instruction, completionJudge });
        if (completionJudge) return done('', { complete: true, reason: 'checked', missing_paths: [] });
        if (Object.hasOwn(properties, 'step')) return done('', { step: 1, reason: 'approved' });
        if (Object.hasOwn(properties, 'content')) return done('', { content: 'approved report' });
        return done('approved review result');
      },
    }));
    const reviewer = {
      name: 'review', instruction: 'Review the work', personaDisplayName: 'Reviewer',
      completionRetry: { minRetry: 1, maxRetry: 1, retryInstruction: 'Recheck the work' },
      outputContracts: [{ name: 'review.md', format: '# Report\n{task}' }],
      rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'ABORT' })],
    };
    const engine = new WorkflowEngine({
      name: 'completion', maxSteps: 5, initialStep: 'review',
      steps: [parallel ? {
        name: 'review', instruction: '', personaDisplayName: 'Parent', parallel: [reviewer],
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      } : reviewer],
    }, directory, 'review task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'completion', structuredCaller: new ProviderNeutralStructuredCaller() });
    engine.getState().stepIterations.set(parallel ? JSON.stringify({ ancestors: ['review'], step: 'review' }) : 'review', 2);
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    const judgments = calls.filter((call) => call.completionJudge);
    expect(judgments).toHaveLength(2);
    const label = parallel
      ? language === 'ja' ? 'review（review の並列サブステップ）' : 'review (parallel substep of review)'
      : 'review';
    const phaseContext = language === 'ja'
      ? `## 担当とフェーズ\n\n今は ${label} ステップの判定フェーズ（Phase 3）です（Step Iteration: 3）。`
      : `## Assignment and phase\n\nYou are now in the judgment phase (Phase 3) of step ${label} (Step Iteration: 3).`;
    for (const call of judgments) {
      const payload = JSON.parse(call.instruction.slice(call.instruction.indexOf('\n{') + 1)) as {
        review_requirements: string;
      };
      expect(payload.review_requirements).toContain('Review the work');
      expect(payload.review_requirements).not.toContain(language === 'ja' ? '## 担当とフェーズ' : '## Assignment and phase');
      expect(payload.review_requirements).not.toContain(phaseBodies[language][1]);
      const judgmentRestrictions = phaseBodies[language][3].split('\n')[1];
      expect(call.instruction.startsWith(`${phaseContext}\n${judgmentRestrictions}\n\n`)).toBe(true);
      expect(call.instruction).not.toContain(phaseBodies[language][3].split('\n')[0]);
      expect(call.instruction).not.toContain(language === 'ja' ? '## 判定基準\n' : '## Criteria\n');
      const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
      expect(assignment).toBe(language === 'ja'
        ? `- ステップ: ${label}\n- Step Iteration: 3\n- Iteration: 1/5\n- フェーズ: 判定フェーズ（Phase 3）`
        : `- Step: ${label}\n- Step Iteration: 3\n- Iteration: 1/5\n- Phase: Judgment phase (Phase 3)`);
      const tree = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
      const root = language === 'ja' ? '- completion（ワークフロー）' : '- completion (workflow)';
      const marker = language === 'ja' ? ' ← 現在' : ' ← current';
      expect(tree.slice(tree.indexOf(root))).toBe(`${root}\n  - review${parallel ? '\n    - review' : ''}${marker}`);
      expect(tree.split(marker)).toHaveLength(2);
    }
  });

  it.each([['ja', false], ['en', false], ['ja', true], ['en', true]] as const)('keeps the triggering definition row and internal rules through loop monitor work and every judgment stage (%s, parallel=%s)', async (language, parallel) => {
    const calls: Array<{ system: string; instruction: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        const system = setup.systemPrompt ?? '';
        calls.push({ system, instruction });
        if (system.includes(language === 'ja' ? 'fix の loop monitor の判定' : 'loop monitor judgment for fix')) {
          if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'matched_index')) return done('', { matched_index: 1, reason: 'break the loop' });
          if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'step')) return done('no judgment');
          if (instruction.includes('Phase 3')) return done('', { content: 'no tag' });
          return done('', { content: 'monitor work result' });
        }
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'step')) return done('', { step: 1, reason: 'continue' });
        return done('ordinary work result');
      },
    }));
    const fix = {
      name: 'fix', instruction: 'Fix', personaDisplayName: 'Coder', rules: [normalizeRule({ condition: 'fixed', next: 'review' })],
    };
    const engine = new WorkflowEngine({
      name: 'monitors', maxSteps: 10, initialStep: 'review',
      steps: [
        { name: 'review', instruction: 'Review', personaDisplayName: 'Reviewer', rules: [normalizeRule({ condition: 'reviewed', next: 'fix' })] },
        parallel ? { ...fix, parallel: [{ name: 'fix', instruction: 'Fix in parallel', personaDisplayName: 'Coder' }] } : fix,
      ],
      loopMonitors: [{ cycle: ['review', 'fix'], threshold: 1, judge: {
        instruction: 'Monitor the cycle', rules: [
          { condition: normalizeRule({ condition: 'stop', next: 'COMPLETE' }).condition, next: 'COMPLETE' },
          { condition: normalizeRule({ condition: 'continue', next: 'review' }).condition, next: 'review' },
        ],
      } }],
    }, directory, 'monitor task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'monitors', structuredCaller: new ProviderNeutralStructuredCaller() });
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    const internalCalls = calls.filter((call) => call.system.includes(language === 'ja' ? 'fix の loop monitor の判定' : 'loop monitor judgment for fix'));
    expect(internalCalls).toHaveLength(4);
    for (const [index, call] of internalCalls.entries()) {
      const phase = index === 0 ? 1 : 3;
      const label = language === 'ja' ? 'fix の loop monitor の判定' : 'loop monitor judgment for fix';
      expectPhase(call.instruction, language, label, phase, 1);
      const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
      expect(assignment).toContain(`: ${label}\n- Step Iteration: 1\n- Iteration: 3/10`);
      expect(assignment).toContain(`Phase ${phase}`);
      const tree = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
      const root = language === 'ja' ? '- monitors（ワークフロー）' : '- monitors (workflow)';
      expect(tree.slice(tree.indexOf(root))).toBe(`${root}\n  - review\n  - fix${language === 'ja' ? ' ← 現在' : ' ← current'}${parallel ? '\n    - fix' : ''}`);
      expect(section(call.system, language === 'ja' ? '_loop_judge_review_fix の rules' : 'Rules for _loop_judge_review_fix')).toBe('- stop → COMPLETE\n- continue → review');
    }
  });

  it.each([
    ['ja', false, false], ['en', false, false], ['ja', true, false], ['en', true, false],
    ['ja', false, true], ['en', false, true], ['ja', true, true], ['en', true, true],
  ] as const)('passes structured-only work results into reports (%s, session=%s, parallel=%s)', async (language, hasSession, parallel) => {
    const workResult = { status: 'verified', paths: ['src/work.ts'] };
    const report = '# Report\nVerified src/work.ts';
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'status')) {
          return { ...done('', workResult), sessionId: hasSession ? 'work-session' : undefined };
        }
        const resultSection = section(instruction, language === 'ja' ? '作業結果' : 'Work Results');
        expect(JSON.parse(resultSection.slice(resultSection.indexOf('{')))).toEqual(workResult);
        return done(report, Object.hasOwn(options.outputSchema?.properties ?? {}, 'content') ? { content: report } : undefined);
      },
    }));
    const work: WorkflowStep = {
      name: 'work', instruction: 'Verify the paths', personaDisplayName: 'Reviewer',
      structuredOutput: { schemaRef: 'work-result', schema: {
        type: 'object', properties: { status: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['status', 'paths'], additionalProperties: false,
      } },
      outputContracts: [{ name: 'work.md', format: '# Report' }],
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    };
    const engine = new WorkflowEngine({
      name: 'structured-work', maxSteps: 5, initialStep: 'work',
      steps: [parallel ? {
        name: 'work', instruction: '', personaDisplayName: 'Parent', parallel: [work],
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      } : work],
    }, directory, 'verify task', {
      projectCwd: directory, provider: 'mock', language, reportDirName: 'structured-work',
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    expect((await engine.run()).status).toBe('completed');
    expect(providerCalls).toHaveLength(2);
    expect(readFileSync(join(directory, '.takt/runs/structured-work/reports/work.md'), 'utf8')).toBe(report);
  });

  it.each(['ja', 'en'] as const)('checks complete phase text exactly once through all three judgment stages (%s)', async (language) => {
    const calls: Array<{ system: string; instruction: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        calls.push({ system: setup.systemPrompt ?? '', instruction });
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'matched_index')) return done('', { matched_index: 1, reason: 'approved' });
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'step')) return done('no judgment');
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'content')) return done('', { content: 'no tag' });
        return done('approved work result');
      },
    }));
    const config: WorkflowConfig = {
      name: 'phases', maxSteps: 5, initialStep: 'review',
      steps: [{
        name: 'review', instruction: 'Review', personaDisplayName: 'Reviewer',
        outputContracts: [{ name: 'review.md', format: '# Report\n{task}' }],
        rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'ABORT' })],
      }],
    };
    const engine = new WorkflowEngine(config, directory, 'review task', {
      projectCwd: directory, provider: 'mock', language, reportDirName: 'phases', structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    expect((await engine.run()).status).toBe('completed');
    expect(calls).toHaveLength(5);
    for (const [index, call] of calls.entries()) {
      const phase = index === 0 ? 1 : index === 1 ? 2 : 3;
      expectPhase(call.instruction, language, 'review', phase, 1);
      expect(section(call.system, language === 'ja' ? '担当' : 'Assignment')).toContain(`Phase ${phase}`);
    }
    const aiJudge = calls[4]!.instruction;
    expect(section(aiJudge, language === 'ja' ? 'エージェント出力' : 'Agent Output')).toBe('```\n# review.md\n\napproved work result\n```');
    expect(aiJudge).toContain(language === 'ja' ? '## 判定基準\n' : '## Criteria\n');
    expect(aiJudge).not.toContain(language === 'ja' ? '## 条件\n' : '## Conditions\n');
  });

  it.each(['ja', 'en'] as const)('gives every Arpeggio batch the system assignment and complete work phase text (%s)', async (language) => {
    writeFileSync(join(directory, 'data.csv'), 'name\nAlice\nBob\n');
    writeFileSync(join(directory, 'batch.md'), 'Process {line:1}');
    const instructions: string[] = [];
    const systems: string[] = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        systems.push(setup.systemPrompt ?? '');
        instructions.push(instruction);
        return done('processed');
      },
    }));
    const engine = new WorkflowEngine({
      name: 'batches', maxSteps: 5, initialStep: 'process',
      steps: [{
        name: 'process', instruction: '', personaDisplayName: 'Processor',
        arpeggio: { source: 'csv', sourcePath: join(directory, 'data.csv'), templatePath: join(directory, 'batch.md'), batchSize: 1, concurrency: 2, maxRetries: 0, retryDelayMs: 0, merge: { strategy: 'concat' } },
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      }],
    }, directory, 'process task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'batches', structuredCaller: new ProviderNeutralStructuredCaller() });
    expect((await engine.run()).status).toBe('completed');
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toContain('Alice');
    expect(instructions[1]).toContain('Bob');
    for (const [index, instruction] of instructions.entries()) {
      expectPhase(instruction, language, 'process', 1, 1);
      expect(section(systems[index]!, language === 'ja' ? '担当' : 'Assignment')).toBe(language === 'ja'
        ? '- ステップ: process\n- Step Iteration: 1\n- Iteration: 1/5\n- フェーズ: 作業フェーズ（Phase 1）'
        : '- Step: process\n- Step Iteration: 1\n- Iteration: 1/5\n- Phase: Work phase (Phase 1)');
    }
  });

  it.each(['ja', 'en'] as const)('keeps same-name parent and child positions and iteration scopes distinct across phases (%s)', async (language) => {
    const calls: Array<{ system: string; instruction: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        calls.push({ system: setup.systemPrompt ?? '', instruction });
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'step')) return done('', { step: 1, reason: 'approved' });
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'content')) return done('', { content: 'approved report' });
        return done('approved work');
      },
    }));
    const rules = [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'ABORT' })];
    const engine = new WorkflowEngine({
      name: 'same-names', maxSteps: 5, initialStep: 'same',
      steps: [{
        name: 'same', instruction: '', personaDisplayName: 'Parent', rules,
        parallel: [{
          name: 'same', instruction: 'Review', personaDisplayName: 'Child', rules,
          outputContracts: [{ name: 'review.md', format: '# Report\n{task}' }],
        }],
      }],
    }, directory, 'review task', { projectCwd: directory, provider: 'mock', language, reportDirName: 'same-names', structuredCaller: new ProviderNeutralStructuredCaller() });
    engine.getState().stepIterations.set(JSON.stringify({ ancestors: ['same'], step: 'same' }), 3);
    expect((await engine.run()).status).toBe('completed');
    expect(calls).toHaveLength(4);
    for (const [index, call] of calls.entries()) {
      const parent = index === 3;
      const phase = index === 0 ? 1 : index === 1 ? 2 : 3;
      const label = parent ? 'same' : language === 'ja' ? 'same（same の並列サブステップ）' : 'same (parallel substep of same)';
      const stepIteration = parent ? 1 : 4;
      expectPhase(call.instruction, language, label, phase, stepIteration);
      const assignment = section(call.system, language === 'ja' ? '担当' : 'Assignment');
      expect(assignment).toContain(`- ${language === 'ja' ? 'ステップ' : 'Step'}: ${label}\n- Step Iteration: ${stepIteration}\n`);
      const tree = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
      const marker = language === 'ja' ? ' ← 現在' : ' ← current';
      const root = language === 'ja' ? '- same-names（ワークフロー）' : '- same-names (workflow)';
      expect(tree.slice(tree.indexOf(root))).toBe(`${root}\n  - same${parent ? marker : ''}\n    - same${parent ? '' : marker}`);
    }
  });

  it.each([['ja', false], ['en', false], ['ja', true], ['en', true]] as const)('gives dynamic facet selectors the owning definition row and work phase (%s, parallel=%s)', async (language, parallel) => {
    const selectors: Array<{ system: string; instruction: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        if (setup.name === 'dynamic-facet-selector') {
          selectors.push({ system: setup.systemPrompt ?? '', instruction });
          return done('', { selected_ids: ['quality'], rationale: 'relevant' });
        }
        return done('work result');
      },
    }));
    const worker = {
      name: 'fix', instruction: 'Fix the work', personaDisplayName: 'Coder',
      dynamicFacets: { pool: 'facets' },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    };
    const engine = new WorkflowEngine({
      name: 'facets', maxSteps: 5, initialStep: 'fix',
      facetPools: { facets: { name: 'facets', source: 'inline', candidates: [{
        id: 'quality', description: 'Code quality', policyRefs: [], knowledgeRefs: [],
        resolvedPolicyContents: [{ content: 'Verify the fix' }], resolvedKnowledgeContents: [],
      }] } },
      steps: [parallel ? { name: 'fix', instruction: '', personaDisplayName: 'Parent', parallel: [worker], rules: worker.rules } : worker],
    }, directory, 'fix task', {
      projectCwd: directory, provider: 'mock', language, reportDirName: 'facets',
      selectorProvider: { provider: 'mock', model: undefined }, selectorGitCommandRunner: new GitSelectorCommandRunner(),
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    expect(selectors).toHaveLength(1);
    const label = parallel ? language === 'ja' ? 'fix（fix の並列サブステップ）' : 'fix (parallel substep of fix)' : 'fix';
    expectPhase(selectors[0]!.instruction, language, label, 1, 1);
    const tree = section(selectors[0]!.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
    const root = language === 'ja' ? '- facets（ワークフロー）' : '- facets (workflow)';
    expect(tree.slice(tree.indexOf(root))).toBe(`${root}\n  - fix${parallel ? '\n    - fix' : ''}${language === 'ja' ? ' ← 現在' : ' ← current'}`);
  });

  it.each(['ja', 'en'] as const)('keeps the work phase in same-session live intervention calls (%s)', async (language) => {
    const store = new LiveInterventionFileStore(directory, 'live');
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        if (providerCalls.length === 1) await store.issue('Verify the additional requirement');
        return done('work result');
      },
    }));
    const engine = new WorkflowEngine({
      name: 'live', maxSteps: 5, initialStep: 'work',
      steps: [{ name: 'work', instruction: 'Work', personaDisplayName: 'Coder',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      }],
    }, directory, 'work task', {
      projectCwd: directory, provider: 'mock', language, reportDirName: 'live',
      structuredCaller: new ProviderNeutralStructuredCaller(), liveIntervention: store,
    });
    expect((await engine.run()).status).toBe('completed');
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]!.instruction).toContain('Verify the additional requirement');
    expect(store.read()).toMatchObject({ pending: 0, deliveredSameSession: 1 });
    for (const call of providerCalls) {
      expectPhase(call.instruction, language, 'work', 1, 1);
      expect(section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow')).toContain(`  - work${language === 'ja' ? ' ← 現在' : ' ← current'}`);
    }
  });

  it.each([['ja', false], ['en', false], ['ja', true], ['en', true]] as const)('includes assignment in companion selection, review, moderation, and follow-up calls (%s, emptyFollowUp=%s)', async (language, emptyFollowUp) => {
    const agents: string[] = [];
    let implementerCalls = 0;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        agents.push(setup.name);
        if (setup.name === 'companion-selector') return done('', { selected_ids: ['reviewer'], rationale: 'relevant' });
        if (setup.name === 'reviewer') return done('', { findings: [{ severity: 'should_fix', file: 'src/work.ts', line: 1, finding: 'Check this change' }], notes: null });
        if (setup.name === 'moderator') return done('', { findings: [{ action: 'accept', sourceIndex: 0 }] });
        implementerCalls++;
        if (emptyFollowUp && implementerCalls === 2) return done('');
        return done('implementation result');
      },
    }));
    const definition = (name: string) => ({ name, description: name, instruction: 'Inspect the work', instructionRef: name, intervalMs: 60000 });
    const engine = new WorkflowEngine({
      name: 'companions', maxSteps: 5, initialStep: 'implement',
      companions: { reviewer: definition('reviewer'), moderator: definition('moderator') },
      steps: [{ name: 'implement', instruction: 'Implement', personaDisplayName: 'Coder',
        companion: { fixed: [], pool: ['reviewer'], moderator: 'moderator' },
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      }],
    }, directory, 'implement task', {
      projectCwd: directory, provider: 'mock', language, reportDirName: 'companions',
      structuredCaller: new ProviderNeutralStructuredCaller(),
      companionEnabled: true, companionProviders: { reviewer: { provider: 'mock' }, moderator: { provider: 'mock' } },
      selectorProvider: { provider: 'mock', model: undefined },
      companionDiffReader: {
        readBaselineSha: async () => 'baseline-sha',
        readDiff: async () => ({ status: 'ok', snapshot: {
          digest: 'diff', changedLines: 10, content: '+changed\n', changedFiles: ['src/work.ts'],
          fileFingerprints: { 'src/work.ts': 'diff' }, hunkFingerprints: { 'src/work.ts:1-10': 'diff' },
          omittedBytes: 0, truncated: false,
        } }),
      },
    });
    const aborts: string[] = [];
    engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
    expect((await engine.run()).status, aborts.join('\n')).toBe('completed');
    expect(engine.getState().companion?.reason).toBeUndefined();
    expect(agents).toContain('companion-selector');
    expect(agents).toContain('reviewer');
    expect(agents).toContain('moderator');
    expect(agents.filter((agent) => !['companion-selector', 'reviewer', 'moderator'].includes(agent))).toHaveLength(emptyFollowUp ? 3 : 2);
    for (const call of providerCalls) {
      expectPhase(call.instruction, language, 'implement', 1, 1);
      expect(section(call.system, language === 'ja' ? '担当' : 'Assignment')).toContain('Iteration: 1/5');
      expect(section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow')).toContain(`  - implement${language === 'ja' ? ' ← 現在' : ' ← current'}`);
    }
  });

  it.each(['ja', 'en'] as const)('gives auto routing estimates and execution calls their owning step context (%s)', async (language) => {
    for (const mode of ['normal', 'parallel', 'team', 'arpeggio'] as const) {
      const offset = providerCalls.length;
      let estimates = 0;
      vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
        call: async (instruction, options) => {
          recordCall(setup.systemPrompt ?? '', instruction);
          if (setup.name === 'auto-router') {
            estimates++;
            expectPhase(instruction, language, 'work', 1, 1);
            return done('', { required_tier: 'medium', reason_codes: ['focused-change'], confidence: 1 });
          }
          const properties = options.outputSchema?.properties ?? {};
          if (Object.hasOwn(properties, 'done')) return done('', { done: true, reasoning: 'finished', cancelPartIds: [], parts: [] });
          if (Object.hasOwn(properties, 'parts')) return done('', { parts: [{ id: 'worker', title: 'Implement', instruction: 'PART WORK' }] });
          return done('work result');
        },
      }));
      writeFileSync(join(directory, 'data.csv'), 'name\nAlice\n');
      writeFileSync(join(directory, 'batch.md'), 'Process {line:1}');
      const worker = { name: 'work', tags: ['implementation'], instruction: 'Work', personaDisplayName: 'Coder', rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })] };
      const engine = new WorkflowEngine({
        name: `routing-${mode}`, maxSteps: 5, initialStep: 'work',
        steps: [mode === 'parallel' ? { ...worker, parallel: [{ ...worker, name: 'child' }] }
          : mode === 'team' ? { ...worker, teamLeader: { maxConcurrency: 1, timeoutMs: 10000 } }
          : mode === 'arpeggio' ? { ...worker, arpeggio: { source: 'csv', sourcePath: join(directory, 'data.csv'), templatePath: join(directory, 'batch.md'), batchSize: 1, concurrency: 1, maxRetries: 0, retryDelayMs: 0, merge: { strategy: 'concat' } } }
          : worker],
      }, directory, 'routing task', {
        projectCwd: directory, language, reportDirName: `routing-${mode}`,
        structuredCaller: new ProviderNeutralStructuredCaller(),
        autoRouting: {
          strategy: 'cost', router: { provider: 'mock', model: 'router-model' },
          candidates: [{ name: 'worker', description: 'Work', provider: 'mock', model: 'worker-model', routingTier: 'medium' }],
          defaultPool: 'general', candidatePools: { general: { candidates: ['worker'], fallback: 'worker' } },
          poolRules: { tags: { implementation: 'general' } },
        },
      });
      const aborts: string[] = [];
      engine.on('workflow:abort', (_state, reason) => aborts.push(reason));
      expect((await engine.run()).status, `${mode}: ${aborts.join('\n')}`).toBe('completed');
      expect(estimates, mode).toBeGreaterThan(0);
      expect(providerCalls.length, mode).toBeGreaterThan(offset + estimates);
      vi.restoreAllMocks();
    }
  });

  it.each(['ja', 'en'] as const)('rebuilds the tree through the production retry run and marks a same-name parallel child (%s)', async (language) => {
    const workflows = join(directory, '.takt', 'workflows');
    mkdirSync(workflows, { recursive: true });
    const rootPath = join(workflows, 'root.yaml');
    const root = (description: string) => `name: root\ndescription: ${description}\nmax_steps: 5\ninitial_step: enter\nsteps:\n  - name: enter\n    kind: workflow_call\n    call: child\n    rules:\n      - condition: finished\n        next: COMPLETE\n`;
    writeFileSync(rootPath, root('initial definition'));
    writeFileSync(join(workflows, 'child.yaml'), `name: child\nsubworkflow:\n  callable: true\n  returns: [finished]\ninitial_step: same\nsteps:\n  - name: same\n    parallel:\n      - name: same\n        instruction: CHILD WORK\n        rules:\n          - condition: approved\n            next: COMPLETE\n          - condition: needs_fix\n            next: ABORT\n    rules:\n      - condition: done\n        return: finished\n`);
    const calls: Array<{ system: string; instruction: string }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((setup) => ({
      call: async (instruction, options) => {
        recordCall(setup.systemPrompt ?? '', instruction);
        calls.push({ system: setup.systemPrompt ?? '', instruction });
        if (Object.hasOwn(options.outputSchema?.properties ?? {}, 'step')) return done('', { step: 1, reason: 'approved' });
        return done('approved');
      },
    }));
    const options = { projectCwd: directory, provider: 'mock' as const, language, outputMode: 'silent' as const, handleSigint: false };
    const initial = await executeWorkflow(loadWorkflowFromFile(rootPath, directory), 'task', directory, { ...options, reportDirName: 'initial' });
    expect(initial.success, initial.reason).toBe(true);
    const firstCalls = calls.splice(0);
    writeFileSync(rootPath, root('retry definition'));
    const retry = await executeWorkflow(loadWorkflowFromFile(rootPath, directory), 'task', directory, {
      ...options, reportDirName: 'retry', startStep: 'enter', retryNote: 'Retry the work', resumeSource: { sourceRunSlug: 'initial', resumeMode: 'retry' },
    });
    expect(retry.success, retry.reason).toBe(true);
    expect(retry.runDirectory).not.toBe(initial.runDirectory);
    const retryMeta = JSON.parse(readFileSync(buildRunPaths(directory, 'retry').metaAbs, 'utf8')) as Record<string, unknown>;
    expect(retryMeta).toMatchObject({ source_run_slug: 'initial', resume_mode: 'retry', status: 'completed' });
    for (const [runCalls, description] of [[firstCalls, 'initial definition'], [calls, 'retry definition']] as const) {
      expect(runCalls).toHaveLength(2);
      for (const [index, call] of runCalls.entries()) {
        const tree = section(call.system, language === 'ja' ? 'ワークフロー' : 'Workflow');
        const expectedTree = language === 'ja'
          ? `- root（ワークフロー）: ${description}\n  - enter\n    - child（ワークフロー）\n      - same\n        - same ← 現在`
          : `- root (workflow): ${description}\n  - enter\n    - child (workflow)\n      - same\n        - same ← current`;
        const treeRows = tree.slice(tree.indexOf('- root'));
        expect(treeRows).toBe(expectedTree);
        expect(treeRows.split(language === 'ja' ? '← 現在' : '← current')).toHaveLength(2);
        const stepLabel = language === 'ja' ? 'same（same の並列サブステップ）' : 'same (parallel substep of same)';
        expectPhase(call.instruction, language, stepLabel, index === 0 ? 1 : 3, 1);
        expect(section(call.system, language === 'ja' ? '担当' : 'Assignment')).toContain(`- ${language === 'ja' ? 'ステップ' : 'Step'}: ${stepLabel}\n- Step Iteration: 1\n- Iteration: 1/5`);
      }
    }
  });
});
