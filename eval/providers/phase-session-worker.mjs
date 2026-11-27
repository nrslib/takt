import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { phaseCase, taskFor, makeStep, CURRENT_RESULT, JUDGE_CURRENT, JUDGE_OLD } from '../phase-awareness-cases.mjs';
import { loadPhaseProduction, phaseWorkflowMeta, assignmentOptions, phasePersonaPath } from './phase-production.mjs';
import { buildPhaseInvocation, capturePhaseProcess, phaseEnvironment } from './phase-cli.mjs';
import { parsePhaseEvents } from './phase-events.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function snapshotFiles(directory, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected fixture symlink: ${relative}`);
    if (entry.isDirectory()) Object.assign(files, snapshotFiles(directory, relative));
    else if (entry.isFile()) files[relative] = readFileSync(join(directory, relative), 'utf8');
  }
  return files;
}

export function assertNoFindingLeak(records, ids) {
  for (const record of records) {
    for (const id of ids) {
      if ([record.systemPrompt, record.instruction, record.invocation.input, JSON.stringify(record.invocation.args)].some((text) => text.includes(id))) {
        throw new Error(`Invalid case: new finding ID leaked into turn ${record.index}`);
      }
    }
  }
}

export async function runPhaseTrial(config, artifactDir, capture = capturePhaseProcess, abortSignal) {
  process.env.TAKT_CONFIG_DIR = join(repoRoot, 'eval/config');
  const entry = phaseCase(config.case_id);
  const api = await loadPhaseProduction(config.dist_dir);
  const isolated = mkdtempSync(join(tmpdir(), 'takt-phase-eval-'));
  try {
    return await executePhaseTrial(config, artifactDir, capture, abortSignal, entry, api, join(isolated, 'project'));
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

async function executePhaseTrial(config, artifactDir, capture, abortSignal, entry, api, cwd) {
  const fixtureSource = resolve(repoRoot, 'eval/fixtures/phase-awareness');
  cpSync(fixtureSource, cwd, { recursive: true });
  const reportDir = join(cwd, '.takt/runs/eval/reports');
  mkdirSync(reportDir, { recursive: true });
  cpSync(join(cwd, 'reports-seed/reviewer.md'), join(reportDir, 'reviewer.md'));
  let docsMarker;
  if (entry.kind === 'no-docs') {
    docsMarker = `PHASE_DOCS_${randomUUID()}`;
    for (const [path, content] of Object.entries(snapshotFiles(join(cwd, 'docs')))) {
      writeFileSync(join(cwd, 'docs', path), content.split('\n').map((line) => line.trim() ? `${line} ${docsMarker}` : line).join('\n'));
    }
  }
  const env = phaseEnvironment(process.env);
  const task = taskFor(entry);
  const originalProvider = api.getProvider(config.cli);
  const originalSetup = originalProvider.setup;
  const turns = [];
  const stages = [];
  const ids = [];
  const state = { label: '', phase: 1, forcedSession: undefined, invalidResponses: 0 };
  const result = {
    case: entry.id, name: entry.name, config, task, cwd, turns, stages, ids,
    fixtureSource, docsMarker,
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(config.dist_dir, '..'), encoding: 'utf8' }).trim(),
    sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'src'], { cwd: resolve(config.dist_dir, '..') })).digest('hex'),
    distHashes: Object.fromEntries(['agents/runner-prompt.js', 'agents/judge-status-usecase.js', ...['InstructionBuilder', 'ReportInstructionBuilder', 'StatusJudgmentBuilder'].map((name) => `core/workflow/instruction/${name}.js`)]
      .map((path) => [path, createHash('sha256').update(readFileSync(join(config.dist_dir, path))).digest('hex')])),
  };
  mkdirSync(artifactDir, { recursive: true });
  const save = () => writeFileSync(join(artifactDir, 'trial.json'), JSON.stringify(result, null, 2));
  originalProvider.setup = ({ name, systemPrompt }) => ({
    call: async (instruction, options) => {
      const index = turns.length + 1;
      const turnDir = join(artifactDir, `turn-${index}`);
      mkdirSync(turnDir);
      const actualOptions = { ...options, ...(state.forcedSession ? { sessionId: state.forcedSession } : {}) };
      const invocation = buildPhaseInvocation(config, { systemPrompt, instruction, options: actualOptions }, api, turnDir, env);
      const before = snapshotFiles(cwd);
      const record = {
        index, phase: state.phase, label: state.label, name, systemPrompt: systemPrompt ?? '', instruction, invocation,
        requestedSessionId: actualOptions.sessionId, schema: options.outputSchema,
        permissionMode: actualOptions.permissionMode, before,
      };
      turns.push(record);
      assertNoFindingLeak(turns, ids);
      writeFileSync(join(turnDir, 'input.json'), JSON.stringify(record, null, 2));
      save();
      try {
        record.raw = await capture(invocation, { cwd, env, timeoutMs: config.timeout_ms, artifactDir: turnDir, abortSignal });
        const parsed = parsePhaseEvents(record.raw, config.cli, options.outputSchema !== undefined);
        Object.assign(record, parsed);
        if (actualOptions.sessionId && parsed.sessionId !== actualOptions.sessionId) throw new Error('CLI resumed a different session');
        const response = { persona: name, status: 'done', content: parsed.answer, sessionId: parsed.sessionId,
          ...(parsed.structuredOutput === undefined ? {} : { structuredOutput: parsed.structuredOutput }) };
        if (state.invalidResponses > 0) {
          state.invalidResponses -= 1;
          record.injectedResponse = { content: 'unparseable', structuredOutput: {} };
          return { ...response, ...record.injectedResponse };
        }
        return response;
      } catch (error) {
        record.error = error.message;
        throw error;
      } finally {
        record.after = snapshotFiles(cwd);
        record.changedPaths = [...new Set([...Object.keys(before), ...Object.keys(record.after)])].filter((path) => before[path] !== record.after[path]);
        if (record.answer !== undefined) writeFileSync(join(turnDir, 'answer.txt'), record.answer);
        save();
      }
    },
  });

  const step = makeStep(entry, '指示と元の要求に従ってレビューしてください。');
  const reportStep = entry.kind === 'edit' ? makeStep({ step: 'coding-review' }, 'レビューしてください。') : step;
  const steps = reportStep === step ? [step] : [reportStep, step];
  const userInputs = entry.kind === 'readonly' ? ['テストを実行しないでください。']
    : entry.kind === 'no-docs' ? ['docs/ は読まないでください。'] : [];
  let session;
  const runWork = async (current, instruction, iteration, reuse = true) => {
    state.phase = 1;
    state.label = `work-${iteration}`;
    const stepIteration = current.name === reportStep.name ? iteration : 1;
    const meta = phaseWorkflowMeta(api, steps, current, stepIteration, iteration, cwd);
    const userInstruction = new api.InstructionBuilder({ ...current, instruction }, {
      task, iteration, maxSteps: 30, stepIteration, cwd, projectCwd: cwd,
      reportDir, userInputs, language: 'ja', ...assignmentOptions(meta),
      // Fresh reviewer reports are deliberately file-only; no declaredReportInputs / {report:...}.
    }).build();
    const response = await api.runAgent(current.name, userInstruction, {
      cwd, projectCwd: cwd, language: 'ja', workflowMeta: meta, executionPhase: 1, abortSignal,
      personaPath: phasePersonaPath(config.dist_dir, current.name),
      sessionId: reuse ? session : undefined,
      resolvedExecution: { provider: config.cli, model: config.model, permissionMode: current.edit ? 'edit' : 'readonly', providerOptions: {} },
    });
    session = response.sessionId;
    return response.content;
  };
  const runReport = async (lastResponse, reuse) => {
    state.phase = 2;
    state.label = 'report';
    const meta = phaseWorkflowMeta(api, steps, reportStep, 1, 1, cwd);
    const instruction = new api.ReportInstructionBuilder(reportStep, {
      cwd, task, userInputs, reportDir, stepIteration: 1, language: 'ja',
      targetFile: 'review.md', lastResponse, ...assignmentOptions(meta),
    }).build();
    const response = await api.runAgent(reportStep.name, instruction, {
      cwd, projectCwd: cwd, language: 'ja', workflowMeta: meta, executionPhase: 2, abortSignal,
      personaPath: phasePersonaPath(config.dist_dir, reportStep.name),
      sessionId: reuse ? session : undefined, allowedTools: [], maxTurns: 3,
      resolvedExecution: { provider: config.cli, model: config.model, permissionMode: 'readonly', providerOptions: {} },
    });
    session = response.sessionId;
    return response.content;
  };
  const runJudge = async (input, stage, reuse = false) => {
    state.phase = 3;
    state.label = stage;
    state.forcedSession = reuse ? session : undefined;
    const meta = phaseWorkflowMeta(api, steps, step, 1, 1, cwd);
    const context = { language: 'ja', lastResponse: input, inputSource: 'response', ...assignmentOptions(meta) };
    const structured = new api.StatusJudgmentBuilder(step, { ...context, structuredOutput: true });
    const tag = new api.StatusJudgmentBuilder(step, context).build();
    const candidates = step.rules.map((rule) => ({ label: rule.condition.label }));
    const options = {
      cwd, projectCwd: cwd, stepName: step.name, language: 'ja', abortSignal,
      provider: config.cli, resolvedProvider: config.cli, resolvedModel: config.model,
      resolvedProviderOptions: {}, permissionMode: 'readonly', executionPhase: 3,
      ...(api.workflow === undefined ? {} : { judgmentInput: structured.buildJudgmentInput(), workflowMeta: meta }),
      onJudgeStage: (event) => { stages.push(event); save(); },
    };
    state.invalidResponses = stage === 'ai_judge' ? 2 : 0;
    const selected = stage === 'phase3_tag'
      ? await api.runTagJudgeStage(tag, candidates, options, options.onJudgeStage)
      : await api.judgeStatus(structured.build(), tag, candidates, options);
    if (!selected) throw new Error('Production tag caller did not select a rule');
    session = turns.at(-1).sessionId;
    state.forcedSession = undefined;
    return selected;
  };
  try {
    const oldWork = 'Report Directory の reviewer.md を読み、指摘 ID ごとに裁定と根拠を回答してください。';
    const codeWork = 'src/count-active.mjs をレビューしてください。countActive は active === true の項目だけを数える契約です。指摘の ID は CURRENT-202 としてください。';
    switch (entry.kind) {
      case 'carryover':
      case 'carryover-code': {
        const first = await runWork(step, entry.kind === 'carryover' ? oldWork : 'src/inventory.mjs をレビューしてください。在庫と要求数が等しい場合も予約可能という契約です。', 1);
        await runReport(first, true);
        const freshId = `F-${randomUUID()}`;
        ids.push(freshId);
        result.nonceCreatedAfterTurn = turns.length;
        if (entry.kind === 'carryover') {
          const excludedId = `F-${randomUUID()}`;
          ids.push(excludedId);
          result.targetPath = '.takt/runs/eval/reports/reviewer.md';
          writeFileSync(join(cwd, result.targetPath), `# 新しいレビュー\n\n${freshId}: src/count-active.mjs の countActive は全件数を返す。active === true の項目だけを数える要件に違反する。\n\n${excludedId}: src/inventory.mjs の関数をアロー関数へ変えてほしい。振る舞いの欠陥ではなく、好みだけの提案。\n`);
          result.expectedDecisions = { [freshId]: '修正する', [excludedId]: '外す' };
          result.finalAnswer = await runWork(step, oldWork, 2);
        } else {
          result.targetPath = 'src/inventory.mjs';
          writeFileSync(join(cwd, result.targetPath), `// Revision: ${freshId}\nexport function canReserve(available, quantity) {\n  return available > quantity;\n}\n`);
          result.finalAnswer = await runWork(step, 'src/inventory.mjs の今回の変更をフォローアップレビューしてください。在庫と要求数が等しい場合も予約可能という契約です。', 2);
        }
        break;
      }
      case 'report-same': {
        const first = await runWork(step, codeWork, 1);
        result.workResult = first;
        result.finalAnswer = await runReport(first, true);
        break;
      }
      case 'report-new':
        result.workResult = CURRENT_RESULT;
        result.finalAnswer = await runReport(CURRENT_RESULT, false);
        break;
      case 'report-stale':
      case 'missing-same':
      case 'missing-new':
        if (entry.kind !== 'missing-new') result.historyResult = await runWork(step, oldWork, 1);
        result.workResult = entry.kind === 'report-stale' ? CURRENT_RESULT : undefined;
        result.finalAnswer = await runReport(result.workResult, entry.kind !== 'missing-new');
        break;
      case 'judge':
      case 'judge-stale':
        if (entry.kind === 'judge-stale') result.historyJudgment = await runJudge(JUDGE_OLD, 'structured_output');
        result.judgment = await runJudge(JUDGE_CURRENT, entry.stage, entry.kind === 'judge-stale');
        result.finalAnswer = turns.at(-1).answer;
        break;
      case 'readonly':
      case 'no-docs':
      case 'edit': {
        const first = await runWork(reportStep, 'src/inventory.mjs の境界条件をレビューしてください。在庫と要求数が等しい場合も予約可能です。', 1);
        await runReport(first, true);
        result.finalAnswer = await runWork(entry.kind === 'edit' ? { ...step, edit: true } : step,
          entry.kind === 'edit' ? 'src/count-active.mjs の countActive を、active === true の項目だけを数える実装に修正してください。'
            : codeWork, 2);
        break;
      }
      default: throw new Error(`Unsupported phase case kind: ${entry.kind}`);
    }
    assertNoFindingLeak(turns, ids);
    if (turns.some((turn) => turn.error)) throw new Error('A CLI call failed, even though the judge fallback continued');
    result.complete = true;
  } catch (error) {
    result.error = error.stack;
  } finally {
    originalProvider.setup = originalSetup;
    save();
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [configPath, artifactDir] = process.argv.slice(2);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Worker interrupted'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await runPhaseTrial(JSON.parse(readFileSync(configPath, 'utf8')), artifactDir, capturePhaseProcess, controller.signal);
    if (!result.complete) process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
