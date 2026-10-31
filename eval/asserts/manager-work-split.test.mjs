import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import evaluate from './manager-work-split.mjs';
import { loadManagerCase, managerWriteSchemas } from '../manager-work-split-prompt.mjs';

const selectedKeys = {
  'parallel-cli': ['users-command', 'jobs-command', 'storage-command'],
  'parallel-docs-migration': ['search-doc', 'export-doc', 'billing-migration'],
  'shared-resource': ['web-permissions'],
  'shared-definition': ['resolve-assignment'],
  'human-order': ['migration-a'],
  'constraint-carryover': ['resolve-assignment'],
  'constraint-carryover-data': ['channel-totals'],
  'constraint-once': ['ping-log', 'users-paging'],
  'integration-check': [],
  'escalate-repeated-failure': ['admin-copy'],
  'escalate-not-on-first-failure': ['csv-import'],
  'no-check-docs': [],
  'no-check-same-module': [],
  'integration-already-checked': [],
  'summary-keeps-constraint': [],
  'summary-keeps-constraint-web': [],
  'summary-no-invented-constraint': [],
  'mail-dispatch-state': [],
  'local-config-tampering': [],
  'offline-sync-queue': [],
  'report-publish-replacement': [],
  'reservation-validation': [],
  'legacy-date-format': [],
  'archive-test-coverage': [],
  'quoted-csv-fields': [],
  'inventory-retry-idempotency': [],
  'conflicting-calendar-visibility': [],
  'unchanged-adjudication': [],
};
const patrolTellCases = new Set([
  'mail-dispatch-state', 'local-config-tampering', 'offline-sync-queue', 'report-publish-replacement',
]);
const patrolRequiredCases = new Set([
  'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields',
  'inventory-retry-idempotency',
]);
const patrolNoTellCases = new Set(['unchanged-adjudication']);
const patrolQuestionCases = new Set(['conflicting-calendar-visibility']);
const suite = parse(readFileSync(new URL('../scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
function assertSemanticGrader(caseId, lang) {
  const row = suite.tests.find(({ vars }) => vars.case === caseId && vars.lang === lang);
  assert.ok(row.assert.some(({ type }) => type === 'llm-rubric'));
}
function enqueue(fixture, key) {
  return { tool: 'takt_enqueue_goal_task', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, workKey: key, purpose: `Implement ${key}`,
    task: `On the current tip of ${fixture.goal.branch}, run npm run build and targeted tests for ${key}; report evidence.`, workflow: 'default',
  } };
}
function tellRun(fixture, content = 'Keep the required behavior and correct the repair scope.') {
  const task = fixture.tasks.find(({ status }) => status === 'running');
  return { tool: 'takt_tell_run', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name, content,
  } };
}
function goodOutput(caseId, lang) {
  const fixture = loadManagerCase(caseId, lang);
  const conversation = fixture.turn === 'conversation';
  const output = { response: { message: '判断を記録します', summary: conversation
    ? { objective: 'Delivery destinations', outOfScope: [], acceptanceCriteria: ['Existing behavior retained'], constraints: [] } : null },
  calls: selectedKeys[caseId].map((key) => enqueue(fixture, key)) };
  if (caseId === 'escalate-repeated-failure') output.calls.unshift({ tool: 'takt_notify_goal', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, kind: 'blocked',
    body: lang === 'ja'
      ? '検証用の鍵がなく、方針を変えても結合テストが2回失敗しました。設定の読み込み順と接続先を確認し、対象を絞ってやり直しました。管理者が検証用の鍵を発行し、実行環境に設定してください。'
      : 'The test key is missing and integration tests failed twice despite a revised approach. Verified configuration loading order and endpoint and retried a targeted test. The administrator must issue the test key and configure it in the execution environment.',
  } });
  if (caseId === 'escalate-repeated-failure') {
    const independent = output.calls.find(({ tool }) => tool === 'takt_enqueue_goal_task');
    independent.arguments.purpose = fixture.readResults[0].result.work[2].purpose;
    independent.arguments.task = lang === 'ja'
      ? 'src/admin/help.ts の案内文を分かりやすくする。決済や注文保存の実装・確認、購入手順の更新は含めず、案内文だけを確認する。'
      : 'Clarify help text in src/admin/help.ts and check that text only. Exclude payment or order-storage implementation and checks and checkout-guide updates.';
  }
  if (caseId === 'escalate-not-on-first-failure') {
    output.calls[0].arguments.purpose = fixture.readResults[0].result.work[0].purpose;
    output.calls[0].arguments.task = lang === 'ja'
      ? 'docs/sales-csv.md と data/sales_sample.csv を読んでから sales/loader.py を実装する。sale_date、amount、channel と既存の日付形式を使い、見本データで読み込みと入力検証を確認する。'
      : 'Read docs/sales-csv.md and data/sales_sample.csv before implementing sales/loader.py. Use sale_date, amount, channel and the existing date format; verify loading and validation with the sample data.';
  }
  if (caseId === 'integration-check') {
    output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      summary: 'Prepare dependencies in a temporary worktree at the combined goal tip; build and test saved progress through restart and list display. Record results before completion.',
    } });
  }
  if (patrolTellCases.has(caseId)) {
    output.calls.push(tellRun(fixture));
    output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Recorded the repair item and the source supporting the instruction.',
    } });
  }
  if (patrolQuestionCases.has(caseId)) {
    output.calls.push({ tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd,
      goalId: fixture.goal.id,
      body: 'The two acceptance criteria conflict under the external service constraint. Which behavior should take priority?',
      options: ['Wait for external confirmation before showing the item.', 'Show the item locally while marking it unconfirmed.'],
      recommendation: 'Clarify which acceptance criterion takes priority before changing either one.',
    } });
  }
  if (caseId === 'constraint-carryover-data') {
    output.calls[0].arguments.purpose = fixture.readResults[0].result.work[0].purpose;
    output.calls[0].arguments.task = [
      output.calls[0].arguments.purpose,
      ...fixture.goal.constraints,
      lang === 'ja'
        ? 'report-export の実装はこの集計の取り込み後の作業へ回す。この作業は全データの再集計を担当しない。全データの再集計は全成果の取り込み後に始める最後の確認作業が 1 回だけ担当する。'
        : 'Defer report-export implementation until this aggregate is integrated. This task does not own full-data recomputation. A final check task started after all results are integrated owns that recomputation exactly once.',
    ].join('\n');
  }
  if (caseId === 'summary-keeps-constraint-web') {
    output.response.summary = lang === 'ja' ? {
      objective: 'オンラインストアの購入画面を整える',
      outOfScope: ['会員認証、配送業者との連携、決済事業者とストア全体のデザインの変更'],
      constraints: [
        '作業の制約: 途中は変更した画面のコンポーネントテストだけを流す。',
        '作業の制約: ブラウザを使う E2E はテスト環境でゴール全体の最後に 1 回だけ流す。',
        '作業の制約: 本番の決済 API は呼ばない。決済はスタブまたはテスト用 API で検証する。',
      ],
      acceptanceCriteria: [
        '数量変更、小計・送料・合計の表示、クーポン入力とエラー、配送先の必須検証、注文確認の入力と金額表示が動く。',
        '決済の成功・失敗が表示され、二重注文を防ぎ、完了画面で注文番号と購入内容を示す。購入手順とエラー案内を更新する。',
        '税込価格の丸め方、会員・ゲストの購入経路を維持し、戻った際の配送先入力を失わない。コンポーネントテストと E2E が通る。',
      ],
    } : {
      objective: 'Improve online store checkout screens',
      outOfScope: ['Changes to member authentication, shipping carrier integration, payment provider or whole-store design'],
      constraints: [
        'Work constraint: During work, run only component tests for changed screens.',
        'Work constraint: Run browser E2E in the test environment exactly once at the end of the whole goal.',
        'Work constraint: Never call the production payment API. Validate payments with a stub or the test API.',
      ],
      acceptanceCriteria: [
        'Support quantity changes, subtotal/shipping/total display, coupon input and errors, required address validation and order review of details and prices.',
        'Show payment success/failure, prevent duplicate orders and show the order number and purchased items on completion. Update checkout and error guidance.',
        'Preserve tax-inclusive rounding and member/guest paths, retain address input when going back and pass component tests and E2E.',
      ],
    };
  }
  if (caseId.startsWith('no-check-') || caseId === 'integration-already-checked') output.calls.push({ tool: 'takt_complete_goal', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, expectedSha: 'c'.repeat(40), summary: 'Acceptance criteria verified in run reports.',
  } });
  return output;
}
const score = (output, caseId, lang = 'ja') => evaluate(typeof output === 'string' ? output : JSON.stringify(output), { vars: { case: caseId, lang } });
function writingCalls(fixture, _keys) {
  const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
  const task = fixture.tasks.find(({ status }) => status === 'running') ?? fixture.tasks[0];
  const completedTask = fixture.tasks.find(({ status }) => status === 'completed') ?? task;
  return {
    takt_enqueue_goal_task: enqueue(fixture, 'unexpected-work').arguments,
    takt_requeue_goal_task: { ...base, taskName: task.name },
    takt_retry_goal_task: { ...base, taskName: task.name, task: 'Corrected instructions.' },
    takt_remove_goal_task: { ...base, taskName: task.name, reason: 'No longer needed.' },
    takt_merge_goal_task: { ...base, taskName: completedTask.name, expectedSha: completedTask.completion.sha },
    takt_complete_goal: { ...base, expectedSha: 'c'.repeat(40), summary: 'Reviewed acceptance evidence.' },
    takt_check_goal_completion: base,
    takt_ask_goal_question: { ...base, body: 'Approve these work units?' },
    takt_tell_run: { ...base, taskName: task.name, content: 'Review the repair target.' },
    takt_withdraw_goal_question: { ...base, questionId: '650e8400-e29b-41d4-a716-446655440001' },
    takt_notify_goal: { ...base, kind: 'custom', body: 'Decision recorded.' },
    takt_record_goal_work_log: {
      cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Reviewed the available evidence and selected the next work.',
    },
  };
}
for (const lang of ['ja', 'en']) {
  for (const caseId of ['parallel-cli', 'parallel-docs-migration']) {
    test(`${lang}/${caseId}: rejects withholding any ready independent task below the available limit`, () => {
      const correct = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      for (let index = 0; index < correct.calls.length; index++) {
        const output = structuredClone(correct);
        output.calls.splice(index, 1);
        assert.equal(score(output, caseId, lang).pass, false);
      }
    });
  }

  test(`${lang}: data carryover submits only the next aggregate task before CSV export and final recomputation`, () => {
    const fixture = loadManagerCase('constraint-carryover-data', lang);
    for (const key of ['report-export', 'recompute-all-data']) {
      const output = goodOutput('constraint-carryover-data', lang);
      output.calls = [enqueue(fixture, key)];
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
      output.calls.unshift(enqueue(fixture, 'channel-totals'));
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
    }
    const output = goodOutput('constraint-carryover-data', lang);
    output.calls.push({ tool: 'takt_complete_goal', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, expectedSha: 'c'.repeat(40), summary: 'Done',
    } });
    assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
  });

  test(`${lang}: data and web constraint meanings are delegated to their semantic graders`, () => {
    const output = goodOutput('constraint-carryover-data', lang);
    const bodies = lang === 'ja' ? [
      output.calls[0].arguments.task,
      '月別・販売経路別の集計を追加する。',
      '変更したモジュールの pytest を流し、この作業の最後に全データで再集計する。本番 DB に接続して検証する。',
      'すべての pytest と全データでの再集計を恒久的に禁止する。',
    ] : [
      output.calls[0].arguments.task,
      'Add monthly sales aggregates by channel.',
      'Run pytest for changed modules and recompute all data at the end of this task. Connect to the production DB to validate.',
      'Permanently prohibit all pytest tests and full-data recomputation.',
    ];
    for (const body of bodies) {
      output.calls[0].arguments.task = body;
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, true);
    }
    assertSemanticGrader('constraint-carryover-data', lang);
    const summary = goodOutput('summary-keeps-constraint-web', lang);
    assert.equal(score(summary, 'summary-keeps-constraint-web', lang).pass, true);
    summary.response.summary.constraints = lang === 'ja'
      ? ['作業の制約: 各画面の作業の最後に E2E を流す。本番の決済 API で検証する。']
      : ['Work constraint: Run E2E at the end of each screen task. Validate with the production payment API.'];
    assert.equal(score(summary, 'summary-keeps-constraint-web', lang).pass, true);
    assertSemanticGrader('summary-keeps-constraint-web', lang);
  });

  for (const caseId of Object.keys(selectedKeys)) {
    test(`${lang}/${caseId}: accepts intended tool calls and rejects missing required response or calls`, () => {
      const correct = goodOutput(caseId, lang);
      assert.equal(score(correct, caseId, lang).pass, true);
      const wrong = structuredClone(correct);
      if (caseId.startsWith('summary-')) wrong.response.summary = null;
      else if (patrolNoTellCases.has(caseId) || patrolRequiredCases.has(caseId) || caseId === 'integration-check') wrong.response.summary = { objective: 'Invalid event summary' };
      else wrong.calls = [];
      assert.equal(score(wrong, caseId, lang).pass, false);
    });
    test(`${lang}/${caseId}: rejects writes outside the case's permitted actions`, () => {
      const fixture = loadManagerCase(caseId.startsWith('summary-') ? 'parallel-cli' : caseId, lang);
      const calls = writingCalls(fixture, selectedKeys[caseId]);
      const allowed = caseId === 'escalate-repeated-failure'
        ? ['takt_enqueue_goal_task', 'takt_notify_goal', 'takt_ask_goal_question', 'takt_record_goal_work_log']
        : caseId === 'escalate-not-on-first-failure'
          ? ['takt_enqueue_goal_task', 'takt_requeue_goal_task', 'takt_retry_goal_task', 'takt_record_goal_work_log', 'takt_notify_goal']
        : patrolTellCases.has(caseId) ? ['takt_tell_run', 'takt_record_goal_work_log', 'takt_notify_goal']
          : patrolQuestionCases.has(caseId) ? ['takt_ask_goal_question', 'takt_tell_run', 'takt_record_goal_work_log', 'takt_notify_goal']
            : patrolRequiredCases.has(caseId) ? ['takt_tell_run', 'takt_ask_goal_question', 'takt_record_goal_work_log', 'takt_notify_goal']
            : patrolNoTellCases.has(caseId) ? ['takt_record_goal_work_log', 'takt_notify_goal']
              : caseId.startsWith('summary-') ? [] : caseId === 'integration-check'
                ? ['takt_record_goal_work_log', 'takt_notify_goal'] : [
        'takt_merge_goal_task', 'takt_record_goal_work_log', 'takt_notify_goal',
        caseId.startsWith('no-check-') || caseId === 'integration-already-checked' ? 'takt_complete_goal' : 'takt_enqueue_goal_task',
      ];
      for (const [tool, args] of Object.entries(calls)) {
        assert.ok(managerWriteSchemas[tool].safeParse(args).success, tool);
        if (allowed.includes(tool)) continue;
        for (const position of ['before', 'after']) {
          const output = goodOutput(caseId, lang);
          const call = { tool, arguments: args };
          if (position === 'before') output.calls.unshift(call);
          else output.calls.push(call);
          const graded = score(output, caseId, lang);
          assert.equal(graded.pass, false, `${tool} ${position}`);
          if (!caseId.startsWith('summary-')) assert.equal(graded.reason, `Writing tool not allowed for this case: ${tool}`);
        }
      }
    });
    if (!caseId.startsWith('summary-')) {
      test(`${lang}/${caseId}: permits work log entries and notifications`, () => {
        const fixture = loadManagerCase(caseId, lang);
        const calls = writingCalls(fixture, selectedKeys[caseId]);
        const output = goodOutput(caseId, lang);
        output.calls.unshift({ tool: 'takt_record_goal_work_log', arguments: calls.takt_record_goal_work_log });
        output.calls.push({ tool: 'takt_notify_goal', arguments: calls.takt_notify_goal });
        assert.equal(score(output, caseId, lang).pass, true);
      });
    }
  }
}
for (const lang of ['ja', 'en']) {
  test(`${lang}: sends one instruction only for unsupported or unnecessarily complex repair items`, () => {
    for (const caseId of patrolTellCases) {
      const output = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(output.calls.filter(({ tool }) => tool === 'takt_tell_run').length, 1);
      const duplicate = structuredClone(output);
      duplicate.calls.push(structuredClone(duplicate.calls.find(({ tool }) => tool === 'takt_tell_run')));
      assert.equal(score(duplicate, caseId, lang).pass, false);
      const withoutTell = structuredClone(output);
      withoutTell.calls = withoutTell.calls.filter(({ tool }) => tool !== 'takt_tell_run');
      assert.equal(score(withoutTell, caseId, lang).pass, false);
      const wrongTask = structuredClone(output);
      wrongTask.calls.find(({ tool }) => tool === 'takt_tell_run').arguments.taskName = 'another-task';
      assert.equal(score(wrongTask, caseId, lang).pass, false);
    }
  });

  test(`${lang}: permits instructions and questions for required items subject to semantic grading`, () => {
    for (const caseId of patrolRequiredCases) {
      const fixture = loadManagerCase(caseId, lang);
      const output = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      output.calls.push(tellRun(fixture));
      output.calls.push({ tool: 'takt_ask_goal_question', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, body: 'Please clarify the basis for the required behavior.',
      } });
      assert.equal(score(output, caseId, lang).pass, true);
      const duplicate = structuredClone(output);
      duplicate.calls.push(structuredClone(duplicate.calls[0]));
      duplicate.calls[2].arguments.content = 'Continue the required repair.';
      assert.equal(score(duplicate, caseId, lang).pass, false);
      output.calls[1].arguments.recipient = 'director';
      assert.equal(score(output, caseId, lang).pass, false);
      delete output.calls[1].arguments.recipient;
      output.calls[0].arguments.taskName = 'another-task';
      assert.equal(score(output, caseId, lang).pass, false);
    }
  });

  test(`${lang}: does not tell a running task to drop a required behavior, test or unchanged adjudication`, () => {
    for (const caseId of patrolNoTellCases) {
      const output = goodOutput(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(output.calls.filter(({ tool }) => tool === 'takt_tell_run').length, 0);
      output.calls.push(tellRun(loadManagerCase(caseId, lang)));
      assert.equal(score(output, caseId, lang).pass, false);
    }
  });

  test(`${lang}: asks a human about conflicting criteria and permits a run instruction subject to semantic grading`, () => {
    const caseId = 'conflicting-calendar-visibility';
    const output = goodOutput(caseId, lang);
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    const instruction = lang === 'ja'
      ? '人の回答までこの方針に依存する結論を出さず、受け入れ条件は変えない。依存しない作業は続けてよい。'
      : 'Do not decide matters dependent on this choice until the person answers; keep both criteria and continue independent work.';
    output.calls.push(tellRun(loadManagerCase(caseId, lang), instruction));
    assert.equal(score(output, caseId, lang).pass, true);
    const duplicate = structuredClone(output);
    duplicate.calls.push(structuredClone(duplicate.calls[1]));
    assert.equal(score(duplicate, caseId, lang).pass, false);
    const wrongTask = structuredClone(output);
    wrongTask.calls[1].arguments.taskName = 'another-task';
    assert.equal(score(wrongTask, caseId, lang).pass, false);
    output.calls = output.calls.filter(({ tool }) => tool !== 'takt_ask_goal_question');
    assert.equal(score(output, caseId, lang).pass, false);
  });
}
test('accepts a complete JSON code fence while preserving production envelope validation', () => {
  const output = JSON.stringify(goodOutput('parallel-cli', 'ja'), null, 2);
  for (const fence of ['json', 'JSON', '']) {
    assert.equal(score(` \n\`\`\`${fence}\n${output}\n\`\`\`\n`, 'parallel-cli').pass, true);
  }
  assert.equal(score(`\`\`\`json\r\n${output}\r\n\`\`\``, 'parallel-cli').pass, true);
});
for (const lang of ['ja', 'en']) {
  test(`${lang}: reads a top-level summary using the same response summary validation`, () => {
    for (const caseId of ['parallel-cli', 'summary-keeps-constraint']) {
      const output = goodOutput(caseId, lang);
      output.summary = output.response.summary;
      delete output.response.summary;
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(score(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``, caseId, lang).pass, true);
      output.summary = { objective: 'Incomplete summary' };
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput('parallel-cli', lang);
    output.summary = goodOutput('summary-keeps-constraint', lang).response.summary;
    delete output.response.summary;
    assert.equal(score(output, 'parallel-cli', lang).pass, false);
  });

  test(`${lang}: treats an omitted event summary as null without allowing an omitted conversation summary`, () => {
    for (const caseId of Object.keys(selectedKeys)) {
      const output = goodOutput(caseId, lang);
      delete output.response.summary;
      assert.equal(score(output, caseId, lang).pass, !caseId.startsWith('summary-'));
    }
    const output = goodOutput('parallel-cli', lang);
    delete output.response.summary;
    delete output.calls[0].arguments.workflow;
    assert.equal(score(output, 'parallel-cli', lang).pass, false);
  });
}
test('rejects trailing content and additional envelopes, including prohibited calls', () => {
  const caseId = 'reservation-validation';
  const output = goodOutput(caseId, 'ja');
  const forbidden = structuredClone(output);
  forbidden.calls.push(tellRun(loadManagerCase(caseId, 'ja')));
  const json = JSON.stringify(output);
  const suffixes = ['\n{}', '\nAdditional explanation', `\n${JSON.stringify(forbidden)}`, '\n```json\n{}\n```'];
  for (const suffix of suffixes) {
    assert.equal(score(`${json}${suffix}`, caseId).pass, false);
    assert.equal(score(`\`\`\`json\n${json}${suffix}\n\`\`\``, caseId).pass, false);
    assert.equal(score(`\`\`\`json\n${json}\n\`\`\`${suffix}`, caseId).pass, false);
  }
});
test('rejects malformed JSON and malformed production response/call envelopes inside or outside fences', () => {
  for (const output of [
    'not json', '```json\n{}\n```', '{}', '{"response":{"message":"x","summary":null},"calls":{}}',
    '{"response":{"message":"x"}}', '{"calls":[]}', '{"response":null,"calls":[]}',
    '{"response":[],"calls":[]}', '{"response":"x","calls":[]}',
    '{"response":{"message":"x","summary":null},"summary":null,"calls":[]}',
    '{"response":{"message":"x"},"calls":[],}',
  ]) {
    assert.equal(score(output, 'parallel-cli').pass, false);
  }
  const output = goodOutput('parallel-cli', 'ja');
  output.response.calls = [];
  assert.equal(score(output, 'parallel-cli').pass, false);
  assert.equal(score(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``, 'parallel-cli').pass, false);
  for (const text of [
    `Explanation\n\`\`\`json\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}`,
    `${JSON.stringify(goodOutput('parallel-cli', 'ja'))}}`,
    `${JSON.stringify(goodOutput('parallel-cli', 'ja')).slice(0, -1)}`,
    `{invalid}\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}`,
  ]) assert.equal(score(text, 'parallel-cli').pass, false);
});
test('rejects early consumers, duplicate work and unnecessary serialization', () => {
  const output = goodOutput('parallel-cli', 'ja');
  output.calls.push(enqueue(loadManagerCase('parallel-cli', 'ja'), 'aggregate-command'));
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls = output.calls.slice(0, 1);
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls.push({ ...output.calls[0], arguments: { ...output.calls[0].arguments } });
  assert.equal(score(output, 'parallel-cli').pass, false);
});
for (const lang of ['ja', 'en']) {
  test(`${lang}: rejects two shared-resource submissions, shared-definition consumers and reversed human order`, () => {
    for (const [caseId, additional] of [['shared-resource', 'worker-permissions'], ['shared-definition', 'assignment-mcp'], ['shared-definition', 'assignment-ui'], ['human-order', 'migration-b']]) {
      const output = goodOutput(caseId, lang);
      output.calls.push(enqueue(loadManagerCase(caseId, lang), additional));
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput('human-order', lang);
    output.calls = [enqueue(loadManagerCase('human-order', lang), 'migration-b')];
    assert.equal(score(output, 'human-order', lang).pass, false);
  });
}
test('rejects premature completion and check-only tasks', () => {
  const output = goodOutput('integration-check', 'ja');
  output.calls.push(goodOutput('no-check-docs', 'ja').calls[0]);
  assert.equal(score(output, 'integration-check').pass, false);
  output.calls.pop();
  output.calls = [enqueue(loadManagerCase('integration-check', 'ja'), 'check-a'), enqueue(loadManagerCase('integration-check', 'ja'), 'check-b')];
  assert.equal(score(output, 'integration-check').pass, false);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: final-check plans and work logs are optional when test selection is not being assessed`, () => {
    for (const caseId of ['integration-check', 'plan-cancelled', 'plan-integrated']) {
      const fixture = loadManagerCase(caseId, lang);
      const output = { response: { message: 'Final checks remain unverified.', summary: null }, calls: [] };
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Required work is integrated.',
      } });
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      output.calls.push(enqueue(fixture, 'usage-docs'));
      assert.equal(score(output, caseId, lang).pass, false, caseId);
    }
  });

  test(`${lang}: accepts ordered work bodies including equivalent wording and explicit deferrals`, () => {
    const bodies = lang === 'ja' ? [
      ['shared-resource', 'web-permissions', 'web 用の実行ロールに読み取り権限を追加する。'],
      ['shared-resource', 'worker-permissions', 'worker 用の実行ロールに書き込み権限を追加する。web の変更はこの成果を取り込んでから別の作業で行う。'],
      ['shared-definition', 'resolve-assignment', '保存済みの割り当てを起動時に解決し、共通の定義を作る。MCP ツールと画面表示の実装は、この成果の取り込み後の作業へ回す。'],
      ['human-order', 'migration-a', 'A 環境の台帳を既存の新形式へ変換し、結果を報告する。B の移行は A の結果を確認してから別の作業で行う。'],
    ] : [
      ['shared-resource', 'web-permissions', 'Add read access to the web runtime role.'],
      ['shared-resource', 'worker-permissions', 'Add write access to the worker runtime role. Defer web changes to another task after this result is integrated.'],
      ['shared-definition', 'resolve-assignment', 'Resolve stored assignments on startup and define their shared contract. Defer implementation of MCP tools and UI display to later tasks after integration.'],
      ['human-order', 'migration-a', 'Convert the environment A ledger to the existing new format and report results. Leave migration B to a later task after the result of A has been reviewed.'],
    ];
    for (const [caseId, key, body] of bodies) {
      const output = goodOutput(caseId, lang);
      output.calls = [enqueue(loadManagerCase(caseId, lang), key)];
      output.calls[0].arguments.purpose = body;
      output.calls[0].arguments.task = body;
      assert.equal(score(output, caseId, lang).pass, true);
      assertSemanticGrader(caseId, lang);
    }
  });

  test(`${lang}: delegates final-check plan meaning to the rubric`, () => {
    const output = goodOutput('integration-check', lang);
    const tasks = lang === 'ja' ? [
      'takt/goal/catalog の最新版で npm run build と npm test を実行し、保存形式から読み取りまで受け入れ条件を確認する。失敗があれば直す。',
      '両方の成果を取り込んだこのゴールのブランチでコンパイルと自動検証を行い、不具合を修正して証跡を報告する。',
      '両方の成果を取り込んだゴール用ブランチの今の先端でビルドと保存形式から読み取りまでのテストを実行する。失敗は証跡とともに報告し、manager が後で修正作業を投入する。',
      '現在の takt/goal/catalog ではビルドとテストを実行しない。README を更新する。',
    ] : [
      'On the latest takt/goal/catalog run npm run build and npm test against the saved-state reader acceptance path; repair failures.',
      'Compile and exercise the acceptance path on this goal branch with both results integrated; repair any failures and report evidence.',
      'Run build and saved-state reader tests on the current goal-branch tip after both results are integrated. Report failures and evidence so the manager can submit follow-up repair work.',
      'Do not run build or tests on the current takt/goal/catalog tip. Update the README.',
    ];
    for (const task of tasks) {
      output.calls[0].arguments.summary = task;
      assert.equal(score(output, 'integration-check', lang).pass, true);
    }
    assertSemanticGrader('integration-check', lang);
  });

  test(`${lang}: delegates correctly keyed but wrong purpose/task bodies to semantic graders`, () => {
    for (const [caseId, wrongBody] of [
      ['parallel-cli', 'Implement aggregate using all three unfinished command output formats.'],
      ['parallel-docs-migration', 'Implement aggregate using unfinished search and export outputs.'],
      ['constraint-once', 'Implement both ping logging and users paging in this work unit.'],
      ['shared-resource', lang === 'ja' ? '権限設定ではなく案内文を更新する。' : 'Update help text instead of permissions.'],
      ['shared-definition', lang === 'ja' ? '起動時の定義と MCP ツール、画面表示をこの作業で実装する。' : 'Implement the startup definition, MCP tools and UI display in this task.'],
      ['human-order', lang === 'ja' ? 'A と B の移行を同時に実行する。' : 'Run migrations A and B simultaneously.'],
    ]) {
      for (const field of ['purpose', 'task']) {
        const output = goodOutput(caseId, lang);
        output.calls.forEach((call) => { call.arguments[field] = wrongBody; });
        assert.equal(score(output, caseId, lang).pass, true);
        assertSemanticGrader(caseId, lang);
      }
    }
  });
}
test('rejects extra check tasks for unrelated results and stale completion SHAs', () => {
  for (const caseId of ['no-check-docs', 'no-check-same-module', 'integration-already-checked']) {
    const output = goodOutput(caseId, 'ja');
    output.calls[0].arguments.expectedSha = 'b'.repeat(40);
    assert.equal(score(output, caseId).pass, false);
    output.calls[0].arguments.expectedSha = 'c'.repeat(40);
    output.calls.unshift(enqueue(loadManagerCase(caseId, 'ja'), 'check-results'));
    assert.equal(score(output, caseId).pass, false);
  }
});
test('validates production tool names, arguments, goal identity, workflow and required fields', () => {
  for (const mutate of [
    (call) => { call.tool = 'takt_enqueue_task'; },
    (call) => { call.tool = 'toString'; },
    (call) => { call.arguments.task = ''; },
    (call) => { call.arguments.instruction = call.arguments.task; delete call.arguments.task; },
    (call) => { call.arguments.taskName = 'invented'; },
    (call) => { call.arguments.cwd = '/another/project'; },
    (call) => { call.arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
    (call) => { call.arguments.workflow = 'invented'; },
    (call) => { delete call.arguments.workflow; },
    (call) => { call.arguments.workflow = ''; },
    (call) => { call.arguments.workflow = ' '; },
  ]) {
    const output = goodOutput('parallel-cli', 'ja');
    mutate(output.calls[0]);
    assert.equal(score(output, 'parallel-cli').pass, false);
  }
});
test('validates integration taskName, reviewed SHA and ordering before new submissions', () => {
  const fixture = loadManagerCase('parallel-cli', 'ja');
  const task = fixture.tasks[0];
  const retry = { tool: 'takt_merge_goal_task', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name, expectedSha: task.completion.sha,
  } };
  const output = goodOutput('parallel-cli', 'ja');
  output.calls.unshift(structuredClone(retry));
  assert.equal(score(output, 'parallel-cli').pass, true);
  output.calls[0].arguments.taskName = 'unknown-task';
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls[0] = structuredClone(retry);
  output.calls[0].arguments.expectedSha = 'b'.repeat(40);
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls[0] = structuredClone(retry);
  output.calls.push(output.calls.shift());
  assert.equal(score(output, 'parallel-cli').pass, false);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: rejects repeated integration after integration-check results are already saved`, () => {
    const fixture = loadManagerCase('integration-check', lang);
    const task = fixture.tasks[0];
    const output = goodOutput('integration-check', lang);
    output.calls.unshift({ tool: 'takt_merge_goal_task', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name,
      expectedSha: task.completion.sha,
    } });
    assert.equal(score(output, 'integration-check', lang).pass, false);
  });

}
test('summary turns cannot create a goal or submit work before human approval', () => {
  const output = goodOutput('summary-keeps-constraint', 'ja');
  output.calls.push(enqueue(loadManagerCase('parallel-cli', 'ja'), 'users-command'));
  assert.equal(score(output, 'summary-keeps-constraint').pass, false);
});
test('validates summaries with explicit constraints and optional branches without registration fields', () => {
  const caseId = 'summary-keeps-constraint';
  const output = goodOutput(caseId, 'ja');
  output.response.summary.constraints = ['Run targeted tests during work.'];
  output.response.summary.startBranch = 'main';
  output.response.summary.integrationBranch = 'feat/checkout';
  assert.equal(score(output, caseId).pass, true);
  for (const constraints of [undefined, 'Run targeted tests', ['']]) {
    const invalid = structuredClone(output);
    invalid.response.summary.constraints = constraints;
    assert.equal(score(invalid, caseId).pass, false);
  }
  const invalid = structuredClone(output);
  invalid.response.summary.id = '650e8400-e29b-41d4-a716-446655440000';
  assert.equal(score(invalid, caseId).pass, false);
});
test('validates standalone work log summaries and rejects unrelated fields', () => {
  const fixture = loadManagerCase('parallel-cli', 'ja');
  const output = goodOutput('parallel-cli', 'ja');
  const entry = { tool: 'takt_record_goal_work_log', arguments: writingCalls(fixture, selectedKeys['parallel-cli']).takt_record_goal_work_log };
  output.calls.unshift(entry);
  assert.equal(score(output, 'parallel-cli').pass, true);
  for (const mutate of [
    (args) => { args.summary = ''; },
    (args) => { args.summary = ' '; },
    (args) => { delete args.summary; },
    (args) => { args.taskName = fixture.tasks[0].name; },
    (args) => { args.acceptanceCriteriaVersion = fixture.goal.acceptanceCriteriaVersion; },
    (args) => { args.cwd = '/another/project'; },
    (args) => { args.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
  ]) {
    const invalid = structuredClone(output);
    mutate(invalid.calls[0].arguments);
    assert.equal(score(invalid, 'parallel-cli').pass, false);
  }
});
test('instruction and summary meaning is left to llm-rubric rather than keyword assertions', () => {
  const output = goodOutput('constraint-once', 'ja');
  output.calls.forEach((call) => { call.arguments.task = 'Run the full gate at the end of this task.'; });
  assert.equal(score(output, 'constraint-once').pass, true);
  const summary = goodOutput('summary-no-invented-constraint', 'ja');
  summary.response.summary.constraints.push('作業の制約: 新しい制限');
  assert.equal(score(summary, 'summary-no-invented-constraint').pass, true);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: accepts one combined shared-permissions task under a new work key`, () => {
    const fixture = loadManagerCase('shared-resource', lang);
    for (const key of ['delivery-permissions', 'shared-delivery-permissions', 'coordinate-access']) {
      const output = goodOutput('shared-resource', lang);
      output.calls = [enqueue(fixture, key)];
      output.calls[0].arguments.purpose = lang === 'ja'
        ? '共有ポリシーで web の読み取りと worker の書き込みを両立する'
        : 'Preserve web read and worker write access in the shared policy';
      output.calls[0].arguments.task = lang === 'ja'
        ? 'infra/web.yaml と infra/worker.yaml の bindings を1つの作業で整合させ、どちらを適用しても既存の権限と必要な読み書きの権限を保持する。'
        : 'Coordinate the bindings in infra/web.yaml and infra/worker.yaml within this single task so applying either retains existing permissions and required read/write access.';
      assert.equal(score(output, 'shared-resource', lang).pass, true);
      output.calls.push(enqueue(fixture, 'other-permissions'));
      assert.equal(score(output, 'shared-resource', lang).pass, false);
    }
    for (const key of [undefined, '', ' ']) {
      const output = goodOutput('shared-resource', lang);
      output.calls[0].arguments.workKey = key;
      assert.equal(score(output, 'shared-resource', lang).pass, false);
    }
    assertSemanticGrader('shared-resource', lang);
  });

  test(`${lang}: accepts two implementation submissions with the final gate assigned to a later check`, () => {
    const fixture = loadManagerCase('constraint-once', lang);
    const output = goodOutput('constraint-once', lang);
    const finalCheck = lang === 'ja'
      ? '途中は対象テストだけを npx vitest run --config <分類に合った config> <ファイル> で直接流す。この作業は全体検証を担当しない。全成果の取り込み後に投入する確認作業が、ゴール先端で npm run test:types、npm run build、npm run lint をまとめて1回実行し、その後に追加・変更したテストを個別に流す。heavy IT 全体と E2E 全体は流さない。'
      : 'Directly run only targeted files during work with npx vitest run --config <matching config> <file>. This task does not own the final gate. A check submitted after all results are integrated runs npm run test:types, npm run build and npm run lint together once on the goal tip, followed by added/changed tests individually. Do not run full heavy IT or full E2E.';
    output.calls.forEach((call) => {
      const description = call.arguments.workKey === 'ping-log'
        ? lang === 'ja' ? 'ping のログに requestId を追加する。' : 'Add requestId to ping logs.'
        : lang === 'ja' ? '利用者 API にカーソルページングを追加する。' : 'Add cursor pagination to the users API.';
      call.arguments.task = `${description}\n${finalCheck}`;
    });
    const workLog = writingCalls(fixture, selectedKeys['constraint-once']).takt_record_goal_work_log;
    workLog.summary = finalCheck;
    output.calls.unshift({ tool: 'takt_record_goal_work_log', arguments: workLog });
    assert.equal(output.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task').length, 2);
    assert.equal(score(output, 'constraint-once', lang).pass, true);
    assertSemanticGrader('constraint-once', lang);
    output.calls.push(enqueue(fixture, 'final-check'));
    assert.equal(score(output, 'constraint-once', lang).pass, false);
  });

  test(`${lang}: escalation questions require a human recipient, including the production default`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    output.calls[0] = { tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      body: lang === 'ja'
        ? '検証用の鍵を用意して続けるか、受け入れ条件を変更するか選んでください。決済の検証という元の受け入れ条件を維持できるため、鍵を用意して続けることを推奨します。'
        : 'Provide the test key and continue, or change the acceptance criteria? I recommend providing the key and continuing because it preserves the original payment verification acceptance criteria.',

    } };
    assert.equal(score(output, caseId, lang).pass, true);
    output.calls[0].arguments.recipient = 'human';
    assert.equal(score(output, caseId, lang).pass, true);
    output.calls[0].arguments.recipient = 'director';
    assert.equal(score(output, caseId, lang).pass, false);
    const notification = goodOutput(caseId, lang).calls[0];
    output.calls.unshift(notification);
    assert.equal(score(output, caseId, lang).pass, false);
  });


  test(`${lang}: accepts an independent task and notification conveying a revised retry without a numeric failure count`, () => {
    const output = goodOutput('escalate-repeated-failure', lang);
    output.calls[0].arguments.body = lang === 'ja'
      ? '対象を絞った再試行の後も、環境と保存済み設定に TEST_PAYMENT_KEY がなく決済確認が止まっています。設定の読み込み順と接続先は確認しました。実行環境は管理画面にアクセスできないため、管理者が実行環境にテスト用の鍵を設定してください。決済確認と購入手順は待機し、独立した管理画面の案内文修正を進めます。'
      : 'Payment and order-storage integration verification remains blocked after a revised targeted test: TEST_PAYMENT_KEY is absent from the environment and stored settings. Configuration loading order and the test API endpoint were checked; this execution environment cannot access the administrator console or issue a key. The store administrator must configure a test payment key for the task environment. Payment verification and dependent checkout guidance will wait; the independent administration help-text update can proceed.';
    assert.equal(score(output, 'escalate-repeated-failure', lang).pass, true);
    assertSemanticGrader('escalate-repeated-failure', lang);
  });

  test(`${lang}: repeated failure requires the independent task and a notification without allowing stopped work`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    output.calls.pop();
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls = [enqueue(fixture, 'admin-copy')];
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls = goodOutput(caseId, lang).calls;
    output.calls.push(enqueue(fixture, 'admin-copy'));
    assert.equal(score(output, caseId, lang).pass, false);
  });


  test(`${lang}: repeated failure stops affected work and submits independent work with a human notification or question`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    assertSemanticGrader(caseId, lang);
    output.calls[0].arguments.kind = 'custom';
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls[0] = { tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      body: lang === 'ja'
        ? '検証用の鍵がなく、設定の読み込み順と接続先を確認してやり直しても2回失敗しました。管理者による鍵の発行と設定が必要です。鍵を用意して継続するか、受け入れ条件を変更するか選んでください。決済の検証という元の受け入れ条件を維持できるため、鍵を用意して継続することを推奨します。'
        : 'The test key is missing and both attempts failed after checking configuration loading order and endpoint. An administrator must issue and configure the key. Choose whether to provide the key and continue or change the acceptance criteria. I recommend providing the key and continuing because it preserves the original payment verification acceptance criteria.',

    } };
    assert.equal(score(output, caseId, lang).pass, true);
    for (const key of ['payment-check', 'checkout-guide']) {
      output.calls.push(enqueue(fixture, key));
      const blocked = score(output, caseId, lang);
      assert.equal(blocked.pass, false);
      assert.equal(blocked.reason, 'Unexpected or repeated work key');
      output.calls.pop();
    }
    delete output.calls[0].arguments.body;
    assert.equal(score(output, caseId, lang).pass, false);
  });
  test(`${lang}: first recoverable failure rejects blocked notification, questions and dependent work`, () => {
    const caseId = 'escalate-not-on-first-failure';
    const fixture = loadManagerCase(caseId, lang);
    assertSemanticGrader(caseId, lang);
    for (const tool of ['takt_notify_goal', 'takt_ask_goal_question']) {
      const output = goodOutput(caseId, lang);
      output.calls.push({ tool, arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id,
        body: 'Human action needed.', ...(tool === 'takt_notify_goal' ? { kind: 'blocked' } : {}),
      } });
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput(caseId, lang);
    output.calls = [enqueue(fixture, 'monthly-totals')];
    assert.equal(score(output, caseId, lang).pass, false);
  });
  test(`${lang}: escalation explanations and revised instructions are graded by rubric without keyword matching`, () => {
    const blocked = goodOutput('escalate-repeated-failure', lang);
    blocked.calls[0].arguments.body = 'More help needed.';
    assert.equal(score(blocked, 'escalate-repeated-failure', lang).pass, true);
    const retry = goodOutput('escalate-not-on-first-failure', lang);
    retry.calls[0].arguments.task = 'Repeat the previous instructions.';
    assert.equal(score(retry, 'escalate-not-on-first-failure', lang).pass, true);
  });
}

for (const lang of ['ja', 'en']) {
  test(`${lang}: first recoverable failure can use TAKT retry or requeue on the existing stopped task`, () => {
    const caseId = 'escalate-not-on-first-failure';
    const fixture = loadManagerCase(caseId, lang);
    const task = fixture.tasks.find(({ name }) => name === 'csv-import');
    for (const tool of ['takt_retry_goal_task', 'takt_requeue_goal_task']) {
      const output = goodOutput(caseId, lang);
      output.calls = [{ tool, arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name,
        ...(tool === 'takt_retry_goal_task'
          ? { task: 'Read docs/sales-csv.md and data/sales_sample.csv; use sale_date, amount and channel, then verify loading and validation.' }
          : { retryNote: 'Read docs/sales-csv.md before continuing.' }),
      } }];
      assert.equal(score(output, caseId, lang).pass, true);
      output.calls[0].arguments.taskName = 'foundation';
      assert.equal(score(output, caseId, lang).pass, false);
      output.calls[0].arguments.taskName = task.name;
      output.calls.push(enqueue(fixture, 'csv-import'));
      assert.equal(score(output, caseId, lang).pass, false);
    }
  });
}

const gapCases = [
  'verification-repeated', 'verification-once', 'verification-mixed', 'verification-told',
  'plan-missing', 'plan-dependent', 'plan-cancelled', 'plan-integrated', 'plan-queued', 'final-impact-tests',
];
for (const lang of ['ja', 'en']) {
  test(`${lang}: new cases enforce writing operations, production arguments and semantic grading`, () => {
    for (const caseId of gapCases) {
      const fixture = loadManagerCase(caseId, lang);
      const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
      const record = { tool: 'takt_record_goal_work_log', arguments: { ...base, summary: 'Decision and reason.' } };
      const output = { response: { message: 'Decision recorded.', summary: null }, calls: [record] };
      if (['verification-repeated', 'verification-mixed'].includes(caseId)) output.calls.unshift(tellRun(fixture));
      if (caseId === 'plan-missing') output.calls.unshift(enqueue(fixture, 'usage-docs'));
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      const invalid = structuredClone(output);
      invalid.calls[0].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099';
      assert.equal(score(invalid, caseId, lang).pass, false, caseId);
      for (const tool of ['takt_complete_goal', 'takt_merge_goal_task']) {
        const invalid = structuredClone(output);
        invalid.calls.push({ tool, arguments: writingCalls(fixture, [])[tool] });
        assert.equal(score(invalid, caseId, lang).pass, false, caseId);
      }
      const extraWork = structuredClone(output);
      extraWork.calls.push(enqueue(fixture, 'check-only'));
      assert.equal(score(extraWork, caseId, lang).pass, false, caseId);
      if (['verification-once', 'verification-told'].includes(caseId)) {
        output.calls.push(tellRun(fixture));
        assert.equal(score(output, caseId, lang).pass, false);
      }
      if (['verification-repeated', 'verification-mixed', 'plan-missing'].includes(caseId)) {
        const missingAction = structuredClone(output);
        missingAction.calls.shift();
        assert.equal(score(missingAction, caseId, lang).pass, false);
        const missingLog = structuredClone(output);
        missingLog.calls.pop();
        assert.equal(score(missingLog, caseId, lang).pass, false);
        const duplicate = structuredClone(output);
        duplicate.calls.unshift(structuredClone(duplicate.calls[0]));
        assert.equal(score(duplicate, caseId, lang).pass, false);
      }
      if (['plan-cancelled', 'plan-integrated', 'final-impact-tests'].includes(caseId)) {
        output.calls = [];
        assert.equal(score(output, caseId, lang).pass, caseId !== 'final-impact-tests');
      }
    }
  });
  test(`${lang}: plan-missing rejects assigning an already integrated plan item`, () => {
    const fixture = loadManagerCase('plan-missing', lang);
    const output = { response: { message: 'Next work.', summary: null }, calls: [
      enqueue(fixture, 'storage'),
      { tool: 'takt_record_goal_work_log', arguments: { cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Next work.' } },
    ] };
    assert.equal(score(output, 'plan-missing', lang).pass, false);
  });
}
