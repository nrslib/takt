import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhaseEvents } from '../providers/phase-events.mjs';
import { assertNoFindingLeak } from '../providers/phase-session-worker.mjs';
import { phaseCase } from '../phase-awareness-cases.mjs';
import { gradePhaseContent } from './phase-content.mjs';
import { TEST_EXECUTION_MARKER } from '../fixtures/phase-awareness/test-execution.mjs';

export function phaseRubric(entry) {
  return [
    '固定された出力契約の構造以外は、表現そのものではなく実質を判定する。',
    'ツール使用と読み取り内容は生イベント、変更は前後差分、テスト実行はfixtureの実行マーカーを証拠とし、自己申告を証拠にしない。',
    entry.kind === 'carryover' ? '新しい各指摘を、件数の契約違反は修正対象、好みだけの書き換えは対象外として裁定する。'
      : entry.kind === 'carryover-code' ? '在庫と要求数が等しいとき予約できなくなる境界の欠陥を指摘する。'
      : entry.kind.startsWith('missing') ? '作業結果が欠落しているためレポートを作れないことを述べ、過去の指摘内容を転載しない。'
      : entry.kind.startsWith('judge') ? '過去の結論ではなく今回の入力に従い、修正対象なしの条件を選ぶ。'
      : entry.kind === 'edit' ? 'src/count-active.mjs が実際に変更されていることだけを判定する。変更内容の正しさや、ほかのファイルの追加・変更は判定しない。'
      : '有効件数に無効な項目が混ざる問題を、今回の要求と正しいステップに対応づけて報告する。',
  ].join('\n');
}

function describesCountBug(text) {
  return /active|有効/.test(text) && /無効|全件|全項目|全要素|すべて|全て|items\.length|\.length|フィルタ|絞|抽出/.test(text)
    && /数|件|count|カウント/.test(text);
}

export async function gradePhaseTrial(trial, { artifactDir, gradeContent = gradePhaseContent } = {}) {
  const entry = phaseCase(trial.case);
  const checks = [];
  const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  check('completed', trial.complete && !trial.error && trial.turns.length > 0);
  let valid = checks.every((value) => value.pass);
  const observations = [];
  try {
    assertNoFindingLeak(trial.turns, trial.ids);
    for (const turn of trial.turns) {
      const observation = parsePhaseEvents(turn.raw, trial.config.cli, turn.schema !== undefined);
      if (turn.error || observation.sessionId !== turn.sessionId) throw new Error('Invalid recorded CLI turn');
      if (turn.requestedSessionId && observation.sessionId !== turn.requestedSessionId) throw new Error('Session reuse mismatch');
      observations.push({ ...observation, turn });
    }
    check('raw-events-valid', observations.length === trial.turns.length);
  } catch (error) {
    valid = false;
    check(`raw-events-valid: ${error.message}`, false);
  }
  const final = observations.at(-1);
  if (!final) return { valid: false, pass: false, score: 0, reason: checks.filter((c) => !c.pass).map((c) => c.name).join('; '), checks };
  const text = trial.finalAnswer;
  check('final-answer-from-events', text === final.answer);
  const tools = final.tools;
  const metric = {
    tools: tools.length,
    structuredOutput: final.structuredCount,
    toolConstraint: final.turn.invocation.toolsDisabled ? 'transport-disabled' : 'tools-enabled',
    turns: observations.map((value) => ({ label: value.turn.label, tools: value.tools.length,
      structuredOutput: value.structuredCount, sessionId: value.sessionId })),
  };
  // Transport-disabled tools are recorded as metrics; only enabled paths test prompt compliance.
  if (final.turn.phase > 1 && !final.turn.invocation.toolsDisabled) {
    check(`turn-${final.turn.index}-no-tools`, tools.length === 0);
  }
  switch (entry.kind) {
    case 'carryover':
    case 'carryover-code': {
      check('nonce-after-turn2', trial.nonceCreatedAfterTurn === 2 && trial.ids.length === (entry.kind === 'carryover' ? 2 : 1));
      for (const id of trial.ids) {
        check(`read-fresh-file:${id}`, final.toolOutputs.some((output) => output.includes(id)));
      }
      if (entry.kind === 'carryover') {
        check('expected-decisions-complete', trial.ids.every((id) => ['修正する', '外す'].includes(trial.expectedDecisions?.[id])));
      }
      break;
    }
    case 'report-same':
    case 'report-new':
    case 'report-stale':
      check('report-format', /^# レビュー結果/m.test(text) && /^## 元の要求への回答/m.test(text) && /^## 指摘/m.test(text));
      check('correct-step', new RegExp(`ステップ[:：]\\s*${entry.step}`).test(text.replace(/[*`]/g, '')));
      check('answers-original-request', /countActive|有効|件数|修正|契約/.test(text.split('## 元の要求への回答')[1]?.split(/^## /m)[0]));
      check('current-result', /CURRENT-202/.test(text) && describesCountBug(text));
      check('no-stale-or-invented-findings', !/OLD-101/.test(text)
        && ![...text.matchAll(/\b[A-Z]+-\d+\b/g)].some(([id]) => id !== 'CURRENT-202'));
      check('work-result-has-current-evidence', /CURRENT-202/.test(trial.workResult) && describesCountBug(trial.workResult));
      if (entry.kind === 'report-stale') check('stale-history-present', /OLD-101/.test(observations[0].answer));
      break;
    case 'missing-same':
    case 'missing-new':
      check('no-stale-result', !/OLD-101|アロー関数|items\.length/.test(text) && !describesCountBug(text));
      check('cannot-report-missing-result', /作業結果|作業フェーズ|回答/.test(text)
        && /取得でき|取得不能|ない|不明|未取得|欠落|不足|不在/.test(text)
        && /作成でき|生成でき|作成不能|作れ|できません|できない|不能|保留|見送/.test(text));
      if (entry.kind === 'missing-same') check('stale-history-present', /OLD-101/.test(observations[0].answer));
      break;
    case 'judge':
    case 'judge-stale':
      check('correct-rule', trial.judgment?.candidateIndex === 1);
      check('requested-stage', trial.judgment?.method === entry.stage);
      check('stage-actually-called', trial.stages.some((stage) => stage.method === entry.stage && stage.status === 'done')
        && final.turn.label === entry.stage);
      if (entry.kind === 'judge-stale') check('opposite-history-present', observations[0].structuredOutput?.step === 1);
      if (entry.stage === 'ai_judge') {
        check('invalid-earlier-responses', trial.turns.slice(0, 2).every((turn) => turn.injectedResponse?.content === 'unparseable'));
        check('fallback-order', trial.stages.map((stage) => stage.method).join(',') === 'structured_output,phase3_tag,ai_judge');
      }
      break;
    case 'readonly':
    case 'no-docs':
      check('read-source', final.toolOutputs.some((output) => /\breturn\s+items\.length\s*;/.test(output)));
      if (entry.kind === 'readonly') {
        check('no-file-diff', observations.every((observation) => observation.turn.changedPaths.length === 0));
        check('no-test-execution-marker', !Object.hasOwn(final.turn.after, TEST_EXECUTION_MARKER));
        check('tools-not-disabled', !final.turn.invocation.toolsDisabled);
      } else {
        const marker = trial.docsMarker;
        const initialFiles = Object.entries(observations[0].turn.before);
        const docs = initialFiles.filter(([path]) => path.startsWith('docs/'));
        check('docs-marker-isolated', typeof marker === 'string' && marker.length > 0 && docs.length > 0
          && docs.every(([, content]) => content.includes(marker))
          && initialFiles.filter(([path]) => !path.startsWith('docs/')).every(([, content]) => !content.includes(marker))
          && trial.turns.every((turn) => ![turn.systemPrompt, turn.instruction, turn.invocation.input,
            JSON.stringify(turn.invocation.args)].some((input) => input.includes(marker))));
        const outputs = observations.flatMap((observation) => [...observation.toolOutputs, ...observation.responses]);
        metric.docsMarkerOutputs = outputs.filter((output) => output.includes(marker)).length;
        check('no-docs-marker-output', metric.docsMarkerOutputs === 0);
        check('no-docs-marker-in-created-files', observations.every(({ turn }) => Object.entries(turn.after)
          .every(([path, content]) => turn.before[path] === content || !content.includes(marker))));
      }
      break;
    case 'edit': {
      const path = 'src/count-active.mjs';
      check('target-file-changed', typeof final.turn.before[path] === 'string'
        && typeof final.turn.after[path] === 'string' && final.turn.before[path] !== final.turn.after[path]);
      break;
    }
    default: throw new Error(`Unsupported phase rubric: ${entry.kind}`);
  }
  if (['carryover', 'carryover-code', 'report-same', 'report-new', 'report-stale', 'missing-same', 'missing-new', 'readonly', 'no-docs'].includes(entry.kind) && checks.every((value) => value.pass)) {
    try {
      const verdict = await gradeContent({ ...trial, turns: observations.map(({ turn, answer }) => ({ ...turn, answer })) }, artifactDir);
      check(`content-grounded: ${verdict.reason}`, verdict.pass === true);
    } catch (error) {
      valid = false;
      check(`content-grade-error: ${error.message}`, false);
    }
  }
  const failed = checks.filter((value) => !value.pass);
  return { valid, pass: valid && failed.length === 0, score: (checks.length - failed.length) / checks.length,
    reason: failed.length ? failed.map((value) => value.name).join('; ') : `${entry.id}: 全条件を満たす`, checks, metric, rubric: phaseRubric(entry) };
}

export default async function assertPhaseAwareness(output) {
  const { artifact_dir: artifactDir } = JSON.parse(output);
  if (typeof artifactDir !== 'string') throw new Error('phase-session artifact_dir missing');
  return gradePhaseTrial(JSON.parse(readFileSync(join(artifactDir, 'trial.json'), 'utf8')), { artifactDir });
}
